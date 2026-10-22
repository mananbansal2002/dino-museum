/**
 * Socket.IO transport with automatic path fallback and session recovery.
 *
 * Locally the server exposes the standard `/socket.io` path. On Vercel the
 * serverless function is mounted at `/api/socket`, so the client has to talk
 * to `/api/socket/socket.io`. We try both, and only ever use the websocket
 * transport (long polling is not sticky-session safe on serverless).
 *
 * The path that worked is remembered (localStorage) and tried first next
 * time, and once a path has worked in this page, reconnects stick to it
 * instead of alternating with a path that can never work.
 *
 * Socket.IO's own reconnection is disabled because it cannot switch paths;
 * this module manages reconnects itself:
 *   - `join()` can be called before any socket is connected. The request is
 *     (re)sent on whichever socket connects first.
 *   - After a successful join, an unexpected disconnect triggers status
 *     "reconnecting"; once a new socket connects the same room is re-joined
 *     with the same name/look at the last position sent, and
 *     `handlers.onRejoined(ack)` fires (the ack has a NEW `id` and the full
 *     roster) and status "online" is emitted. A re-join that gets no answer
 *     is retried on a fresh socket.
 *   - Every join carries a per-page resume token, so the server hands the
 *     re-joined client its old player (colour, score, ice cream) and tells
 *     the others "playerRejoined" instead of "left" + "joined".
 *
 * Handlers:
 *   onStatus(status, detail)  "connecting" | "online" | "error" | "offline" | "reconnecting"
 *   onRejoined(ack)           after an automatic re-join (`ack.resumed` when
 *                             the server kept the old player)
 *   playerRejoined(p)         another player reconnected: `p.oldId` -> `p.id`.
 *                             Without this handler it is delivered as
 *                             playerLeft({id: oldId, rejoined: true}) followed
 *                             by playerJoined({...p, rejoined: true}).
 *   playerJoined, playerLeft, state, chat, action, look, rateLimited
 */

const CANDIDATES = ["/socket.io", "/api/socket/socket.io"];
const SERVER_EVENTS = [
  "playerJoined",
  "playerLeft",
  "state",
  "chat",
  "action",
  "look",
  "rateLimited",
];
const JOIN_TIMEOUT_MS = 15000;
const REJOIN_TIMEOUT_MS = 12000;
const PATH_KEY = "dm:socketPath";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked storage throws on access
  }
}

/** First path to try: the one that worked last time, else a guess by host. */
function initialPathIndex() {
  try {
    const i = CANDIDATES.indexOf(storage()?.getItem(PATH_KEY));
    if (i !== -1) return i;
  } catch {
    /* unreadable storage */
  }
  const host = globalThis.location?.hostname || "";
  return /\.vercel\.app$/i.test(host) ? CANDIDATES.indexOf("/api/socket/socket.io") : 0;
}

function rememberPath(path) {
  try {
    storage()?.setItem(PATH_KEY, path);
  } catch {
    /* private mode / quota: just try the default order next time */
  }
}

function makeResumeToken() {
  const bytes = new Uint8Array(18);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createNet(handlers = {}) {
  const io = globalThis.io;
  let socket = null;
  let index = initialPathIndex();
  /** Index of the path that connected in this page (null until one has). */
  let workingIndex = null;
  let attempts = 0;
  let destroyed = false;
  let timer = null;

  /** Options of the last successful join (room = the room actually joined). */
  let session = null;
  /** A join() promise waiting for its ack. */
  let pending = null;
  /** Lets the server match a re-join to the player this page left behind. */
  const resumeToken = makeResumeToken();
  /** Socket id of the last successful join (the player to resume). */
  let lastId = null;
  /** Last movement state sent, so a re-join spawns where the player stood. */
  let lastState = null;
  /** Timer for an automatic re-join that has not been answered yet. */
  let rejoinTimer = null;

  const status = (s, d) => handlers.onStatus?.(s, d);

  function dispose(s) {
    if (!s) return;
    s.removeAllListeners();
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }

  function scheduleConnect(nextPath) {
    if (destroyed) return;
    // Once a path has worked, a failure is an outage, not a wrong path.
    if (nextPath && workingIndex === null) index++;
    attempts++;
    const wait = Math.min(5000, 700 * attempts);
    clearTimeout(timer);
    timer = setTimeout(connect, wait);
  }

  function sendJoin(s, opts, onAck) {
    const msg = { ...opts, resume: resumeToken };
    if (lastId) msg.prevId = lastId;
    s.emit("join", msg, (res) => {
      if (s !== socket) return; // stale socket: the join will be resent
      if (res && !res.error && res.id) lastId = res.id;
      onAck(res);
    });
  }

  function flushJoin(s) {
    if (pending) {
      const p = pending;
      sendJoin(s, p.opts, (res) => {
        if (pending !== p) return;
        pending = null;
        clearTimeout(p.timer);
        if (res && !res.error && res.id) {
          session = { ...p.opts, room: res.room };
          status("online", s.io?.opts?.path);
          p.resolve(res);
        } else {
          p.reject(new Error(res?.error ? `join refused (${res.error})` : "join refused"));
        }
      });
    } else if (session) {
      // Re-join where the player last stood, not at the original spawn.
      const opts = lastState ? { ...session, state: lastState } : session;
      clearTimeout(rejoinTimer);
      rejoinTimer = setTimeout(() => {
        // No answer (e.g. the server is stuck on a slow backend): start over
        // on a fresh socket rather than staying "reconnecting" forever.
        if (s !== socket) return;
        dispose(s);
        socket = null;
        status("reconnecting", "rejoin timed out");
        scheduleConnect(false);
      }, REJOIN_TIMEOUT_MS);
      sendJoin(s, opts, (res) => {
        clearTimeout(rejoinTimer);
        if (res && !res.error && res.id) {
          session = { ...session, room: res.room };
          status("online", s.io?.opts?.path);
          handlers.onRejoined?.(res);
        } else {
          // Refused (e.g. rate limited): drop this socket and try again.
          dispose(s);
          socket = null;
          status("reconnecting", res?.error || "rejoin refused");
          scheduleConnect(false);
        }
      });
    } else {
      status("online", s.io?.opts?.path);
    }
  }

  function connect() {
    if (destroyed) return;
    const path = CANDIDATES[index % CANDIDATES.length];
    status(session ? "reconnecting" : "connecting", path);

    dispose(socket);
    const s = io({
      path,
      transports: ["websocket"],
      upgrade: false,
      reconnection: false,
      timeout: 9000,
      autoConnect: true,
      forceNew: true,
    });
    socket = s;

    s.on("connect", () => {
      if (s !== socket) return;
      attempts = 0;
      workingIndex = index % CANDIDATES.length;
      rememberPath(path);
      flushJoin(s);
    });

    s.on("connect_error", (err) => {
      if (s !== socket) return;
      status(session ? "reconnecting" : "error", err?.message || "connection failed");
      dispose(s);
      socket = null;
      scheduleConnect(true);
    });

    s.on("disconnect", (reason) => {
      if (s !== socket) return;
      if (destroyed || reason === "io client disconnect") {
        status("offline", reason);
        return;
      }
      dispose(s);
      socket = null;
      if (session || pending) {
        status("reconnecting", reason);
        // Retry the path that just worked first.
        scheduleConnect(false);
      } else {
        status("offline", reason);
        scheduleConnect(false);
      }
    });

    for (const ev of SERVER_EVENTS) {
      s.on(ev, (payload) => {
        if (s === socket) handlers[ev]?.(payload);
      });
    }
    s.on("playerRejoined", (p) => {
      if (s !== socket || !p) return;
      if (handlers.playerRejoined) {
        handlers.playerRejoined(p);
      } else {
        handlers.playerLeft?.({ id: p.oldId, name: p.name, rejoined: true });
        handlers.playerJoined?.({ ...p, rejoined: true });
      }
    });
  }

  connect();

  return {
    get connected() {
      return !!socket && socket.connected;
    },
    get socket() {
      return socket;
    },
    /** This client's current socket id (changes after a reconnect). */
    get id() {
      return socket?.id ?? null;
    },
    /** True while the connection has been lost after a join. */
    get reconnecting() {
      return !!session && !(socket && socket.connected) && !destroyed;
    },
    /** Send an event; returns false when it could not be sent (offline). */
    emit(event, ...args) {
      if (event === "state" && args[0] && typeof args[0] === "object") lastState = { ...args[0] };
      if (!(socket && socket.connected)) return false;
      socket.emit(event, ...args);
      return true;
    },
    /** Update this player's look for everyone (and for future re-joins). */
    setLook(look) {
      if (session) session = { ...session, look };
      if (pending) pending.opts = { ...pending.opts, look };
      if (socket && socket.connected) socket.emit("look", look);
    },
    join(opts = {}) {
      return new Promise((resolve, reject) => {
        if (destroyed) return reject(new Error("connection closed"));
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("superseded by a newer join"));
        }
        const p = { opts: { ...opts }, resolve, reject, timer: null };
        p.timer = setTimeout(() => {
          if (pending !== p) return;
          pending = null;
          reject(new Error("join timed out"));
        }, JOIN_TIMEOUT_MS);
        pending = p;
        if (socket && socket.connected) flushJoin(socket);
        // Otherwise it is sent as soon as a socket connects.
      });
    },
    close() {
      destroyed = true;
      clearTimeout(timer);
      clearTimeout(rejoinTimer);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("connection closed"));
        pending = null;
      }
      const s = socket;
      socket = null;
      if (s) {
        s.removeAllListeners();
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
      status("offline", "closed");
    },
  };
}
