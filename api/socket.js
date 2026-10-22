/**
 * Vercel serverless function exposing the multiplayer Socket.IO server.
 *
 * Vercel serves this at /api/socket. `vercel.json` rewrites /socket.io to it,
 * so the browser can use the standard Socket.IO path on every host (see
 * public/js/net.js). Static assets are served straight from /public.
 */
import { createMuseumServer } from "../src/museum-server.js";

/**
 * The static site itself is served by Vercel from /public, so the function
 * only needs the Socket.IO endpoint (plus /health). `vercel.json` rewrites
 * /socket.io to this function and Vercel hands it the original path, which
 * is exactly what Socket.IO expects.
 */
const { server } = createMuseumServer({ mountPath: "/api/socket" });

export default server;
