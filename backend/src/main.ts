import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { startServer } from "./server.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
// Bind to loopback by default: the agent has no authentication, so exposing it
// on all interfaces would let anyone on the LAN spend the API key. Set
// HOST=0.0.0.0 explicitly to serve other devices.
const host = process.env.HOST ?? "127.0.0.1";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

startServer(port, host).catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
