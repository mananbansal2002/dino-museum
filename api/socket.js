/**
 * Vercel serverless function exposing the multiplayer Socket.IO server.
 *
 * Vercel serves this at /api/socket. `vercel.json` rewrites /socket.io to it,
 * so the browser can use the standard Socket.IO path on every host (see
 * public/js/net.js). Static assets are served straight from /public.
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
