import { createServer } from "node:http";
import express from "express";
import { Server } from "socket.io";
import { createSync } from "./sync.js";

const COLORS = 0xffffff;

/**
 * Builds the Express + Socket.IO application used both by the local dev
 * server and by the Vercel serverless function.
 */
export function createMuseumServer({ staticDir = null, mountPath = null } = {}) {
  const app = express();
  const server = createServer(app);

  // On Vercel the function is mounted at /api/socket. Depending on the
  // platform the request URL may or may not keep that prefix, so normalise it
  // to the plain Socket.IO path before Socket.IO inspects the upgrade.
  if (mountPath) {
    server.prependListener("upgrade", (req, socket, head) => {
      if (req.url.startsWith(mountPath)) {
        req.url = req.url.slice(mountPath.length) || "/socket.io";
      }
    });
  }

  const io = new Server(server, {
    cors: { origin: "*" },
    // Vercel strips the function mount path, so the default path works there
    // and locally. Long-polling is disabled client-side (see public/js/net.js).
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: 1e6,
  });

  const sync = createSync();
  const rooms = new Map();

  function getRoom(code) {
    if (!rooms.has(code)) {
      rooms.set(code, { code, players: new Map(), log: [], createdAt: Date.now() });
    }
    return rooms.get(code);
  }

  function newRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
      code = Array.from(
        { length: 4 },
        () => chars[Math.floor(Math.random() * chars.length)]
      ).join("");
    } while (rooms.has(code));
    return code;
  }

  function publicPlayers(room) {
    return Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score || 0,
      iceCream: p.iceCream || null,
      look: p.look || null,
    }));
  }

  function rosterPayload(room) {
    const local = publicPlayers(room);
    return local;
  }

  /** Relay an event to every socket in the room except (optionally) one. */
  function fanOut(code, event, exceptId = null) {
    const room = rooms.get(code);
    if (!room) return;
    for (const [id, player] of room.players) {
      if (id === exceptId) continue;
      const socket = io.sockets.sockets.get(id);
      if (socket) socket.emit(event.type, event.payload);
    }
  }

  function pushEvent(code, type, payload, exceptId = null) {
    fanOut(code, { type, payload }, exceptId);
    sync.publish(code, { t: type, p: payload });
  }

  io.on("connection", (socket) => {
    socket.on("join", async (opts = {}, ack) => {
      const name =
        String(opts.name || "Visitor").replace(/\s+/g, " ").trim().slice(0, 18) ||
        "Visitor";
      let code = String(opts.room || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 8);
      if (code.length < 3) code = newRoomCode();

      const room = getRoom(code);
      socket.join(code);
      socket.data.room = code;
      socket.data.name = name;

      const player = {
        id: socket.id,
        name,
        color: Number(opts.color) || 0xffc857,
        score: 0,
        iceCream: null,
        look: opts.look || null,
      };
      room.players.set(socket.id, player);

      const joinEvent = {
        t: "playerJoined",
        p: { id: player.id, name, color: player.color, look: player.look },
      };

      // Tell everybody (including other instances) that this player arrived.
      pushEvent(code, joinEvent.t, joinEvent.p, socket.id);

      // Roster = local players + (if redis is configured) remote ones.
      let roster = rosterPayload(room);
      if (sync.enabled) {
        await sync.setRoster(code, roster);
        const remote = await sync.getRoster(code);
        if (remote && remote.length) {
          const seen = new Set(roster.map((p) => p.id));
          for (const r of remote) if (!seen.has(r.id)) roster.push(r);
        }
        await sync.primeRoom(code);
        sync.watch(code, (ev) => {
          fanOut(code, { type: ev.t, payload: ev.p });
          if (ev.t === "playerJoined") {
            const r = rooms.get(code);
            if (r && !r.players.has(ev.p.id)) {
              r.players.set(ev.p.id, {
                id: ev.p.id,
                name: ev.p.name,
                color: ev.p.color,
                score: 0,
                iceCream: null,
                remote: true,
              });
            }
          } else if (ev.t === "playerLeft") {
            const r = rooms.get(code);
            if (r) r.players.delete(ev.p.id);
          }
        });
      }

      const payload = {
        id: socket.id,
        room: code,
        players: roster,
        crossInstance: sync.enabled,
      };
      if (typeof ack === "function") ack(payload);
    });

    socket.on("state", (p) => {
      if (!p) return;
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const player = room.players.get(socket.id);
      if (!player) return;
      player.x = Number(p.x) || 0;
      player.y = Number(p.y) || 0;
      player.z = Number(p.z) || 0;
      player.ry = Number(p.ry) || 0;
      player.anim = String(p.anim || "idle").slice(0, 12);
      pushEvent(socket.data.room, "state", {
        id: socket.id,
        x: player.x,
        y: player.y,
        z: player.z,
        ry: player.ry,
        anim: player.anim,
      }, socket.id);
    });

    socket.on("chat", (text) => {
      const clean = String(text || "").slice(0, 240);
      if (!clean.trim()) return;
      pushEvent(socket.data.room, "chat", {
        id: socket.id,
        name: socket.data.name,
        text: clean,
      });
    });

    socket.on("action", (msg) => {
      if (!msg) return;
      const type = String(msg.type || "");
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const player = room.players.get(socket.id);
      if (!player) return;

      if (type === "score") {
        player.score = (player.score || 0) + (Number(msg.payload) || 1);
      }
      if (type === "iceCream") {
        player.iceCream = msg.payload || null;
      }
      pushEvent(socket.data.room, "action", {
        id: socket.id,
        name: player.name,
        type,
        payload: msg.payload,
      });
    });

    socket.on("disconnect", () => {
      const code = socket.data.room;
      const room = rooms.get(code);
      if (!room) return;
      room.players.delete(socket.id);
      pushEvent(code, "playerLeft", { id: socket.id, name: socket.data.name });
      if (sync.enabled) sync.setRoster(code, publicPlayers(room));
    });
  });

  if (staticDir) {
    app.use(express.static(staticDir));
    app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        rooms: rooms.size,
        crossInstance: sync.enabled,
        instance: sync.instanceId,
      });
    });
    app.get(/^\/(?!api\/|socket\.io\/|health$).*/, (_req, res) => {
      res.sendFile("index.html", { root: staticDir });
    });
  } else {
    app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        rooms: rooms.size,
        crossInstance: sync.enabled,
        instance: sync.instanceId,
      });
    });
  }

  return { app, server, io, rooms, sync };
}
