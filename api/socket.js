/**
 * Vercel serverless function exposing the multiplayer Socket.IO server.
 *
 * Vercel serves this at /api/socket, and Socket.IO strips the mount path, so
 * the browser connects to /api/socket/socket.io (see public/js/net.js).
 * Static assets are served by Vercel straight from /public.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMuseumServer } from "../src/museum-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { server } = createMuseumServer({
  staticDir: path.join(__dirname, "..", "public"),
  mountPath: "/api/socket",
});

export default server;
