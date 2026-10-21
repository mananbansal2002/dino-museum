/**
 * Socket.IO transport with automatic path fallback and session recovery.
 *
 * Locally the server exposes the standard `/socket.io` path. On Vercel the
 * serverless function is mounted at `/api/socket`, so the client has to talk
 * to `/api/socket/socket.io`. We try both, and only ever use the websocket
 * transport (long polling is not sticky-session safe on serverless).
 *
 * Socket.IO's own reconnection is disabled because it cannot switch paths;
 * this module manages reconnects itself:
 *   - `join()` can be called before any socket is connected. The request is
 *     (re)sent on whichever socket connects first.
 *   - After a successful join, an unexpected disconnect triggers status
 *     "reconnecting"; once a new socket connects the same room is re-joined
 *     with the same name/look, `handlers.onRejoined(ack)` fires (the ack has
 *     a NEW `id` and the full roster) and status "online" is emitted.
 *
 * Handlers:
 *   onStatus(status, detail)  "connecting" | "online" | "error" | "offline" | "reconnecting"
 *   onRejoined(ack)           after an automatic re-join
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

export function createNet(handlers = {}) {
  const io = globalThis.io;
  let socket = null;
  let index = 0;
  let attempts = 0;
  let destroyed = false;
  let timer = null;

  /** Options of the last successful join (room = the room actually joined). */
  let session = null;
  /** A join() promise waiting for its ack. */
  let pending = null;

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
    if (nextPath) index++;
    attempts++;
    const wait = Math.min(5000, 700 * attempts);
    clearTimeout(timer);
    timer = setTimeout(connect, wait);
  }

  function sendJoin(s, opts, onAck) {
    s.emit("join", opts, (res) => {
      if (s !== socket) return; // stale socket: the join will be resent
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
      sendJoin(s, session, (res) => {
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
    emit(event, ...args) {
      if (socket && socket.connected) socket.emit(event, ...args);
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
