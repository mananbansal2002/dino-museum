/**
 * Socket.IO transport with automatic path fallback.
 *
 * Locally the server exposes the standard `/socket.io` path. On Vercel the
 * serverless function is mounted at `/api/socket`, so the client has to talk
 * to `/api/socket/socket.io`. We try both, and only ever use the websocket
 * transport (long polling is not sticky-session safe on serverless).
 */

const CANDIDATES = ["/socket.io", "/api/socket/socket.io"];

export function createNet(handlers = {}) {
  const io = globalThis.io;
  let socket = null;
  let index = 0;
  let attempts = 0;
  let destroyed = false;
  let timer = null;

  function connect() {
    if (destroyed) return;
    const path = CANDIDATES[index % CANDIDATES.length];
    handlers.onStatus?.("connecting", path);

    const s = io({
      path,
      transports: ["websocket"],
      upgrade: false,
      reconnection: false,
      timeout: 9000,
      autoConnect: true,
    });
    socket = s;

    s.on("connect", () => {
      attempts = 0;
      handlers.onStatus?.("online", path);
    });

    s.on("connect_error", (err) => {
      handlers.onStatus?.("error", err?.message || "connection failed");
      index++;
      attempts++;
      const wait = Math.min(5000, 700 * attempts);
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          s.close();
        } catch {
          /* already closed */
        }
        connect();
      }, wait);
    });

    s.on("disconnect", (reason) => {
      handlers.onStatus?.("offline", reason);
    });

    for (const ev of ["playerJoined", "playerLeft", "state", "chat", "action"]) {
      s.on(ev, (payload) => handlers[ev]?.(payload));
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
    emit(event, ...args) {
      if (socket && socket.connected) socket.emit(event, ...args);
    },
    join(opts) {
      return new Promise((resolve, reject) => {
        if (!socket) return reject(new Error("no socket"));
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("join timed out"));
          }
        }, 12000);
        socket.emit("join", opts, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (res) resolve(res);
          else reject(new Error("join refused"));
        });
      });
    },
    close() {
      destroyed = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
