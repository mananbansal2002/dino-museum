import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMuseumServer } from "./src/museum-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { server } = createMuseumServer({
  staticDir: path.join(__dirname, "public"),
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n  🦖  Dinosaur Museum running at http://localhost:${PORT}\n`);
});
