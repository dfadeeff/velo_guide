import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { createVeloGuideSession } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");

export function startServer(port: number, host: string) {
  const app = express();

  app.use(express.static(FRONTEND_DIR));

  const server = app.listen(port, host, () => {
    console.log(`VeloGuide running at http://localhost:${port}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws: WebSocket) => {
    console.log("Client connected");

    let session: Awaited<ReturnType<typeof createVeloGuideSession>> | null = null;

    try {
      session = await createVeloGuideSession();

      session.subscribe((event: any) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            ws.send(JSON.stringify({ type: "delta", text: msgEvent.delta }));
          }
        }

        if (event.type === "tool_execution_start") {
          ws.send(JSON.stringify({
            type: "tool_start",
            name: event.toolCallEvent?.name ?? "unknown",
            label: event.toolCallEvent?.label ?? event.toolCallEvent?.name ?? "unknown",
          }));
        }

        if (event.type === "tool_execution_end") {
          ws.send(JSON.stringify({
            type: "tool_end",
            name: event.toolCallEvent?.name ?? "unknown",
          }));
        }
      });

      ws.send(JSON.stringify({ type: "ready" }));
    } catch (err: any) {
      console.error("Failed to create agent session:", err);
      ws.send(JSON.stringify({ type: "error", message: `Failed to initialize: ${err.message}` }));
      ws.close();
      return;
    }

    ws.on("message", async (raw: Buffer) => {
      if (!session) return;

      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "prompt") {
          const images = msg.images?.map((img: any) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType,
          }));

          ws.send(JSON.stringify({ type: "response_start" }));

          try {
            await session.prompt(msg.text || "", {
              images: images?.length ? images : undefined,
            });
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          }

          ws.send(JSON.stringify({ type: "response_end" }));
        }
      } catch (err: any) {
        console.error("Message handling error:", err);
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
      if (session) {
        session.dispose();
        session = null;
      }
    });
  });

  return server;
}
