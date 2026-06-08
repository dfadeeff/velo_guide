import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { startServer } from "./server.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

startServer(port, host);
