import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { createVeloGuideSession } from "./agent.js";
import { FAST_MODE_INSTRUCTION } from "./system-prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");

export function startServer(port: number, host: string) {
  const app = express();

  app.use(express.static(FRONTEND_DIR));

  const server = app.listen(port, host, () => {
    const overpass = process.env.OVERPASS_URL
      ? `LOCAL ${process.env.OVERPASS_URL}  (fast)`
      : "PUBLIC overpass-api.de  (rate-limited, slow — set OVERPASS_URL)";
    console.log(`VeloGuide running at http://localhost:${port}`);
    console.log(`  model:    ${process.env.MODEL ?? "anthropic/claude-haiku-4.5"}`);
    console.log(`  overpass: ${overpass}`);
    console.log(`  routing:  ${process.env.ORS_API_KEY ? "OpenRouteService (cycling network + elevation)" : "OSRM fallback"}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws: WebSocket) => {
    console.log("Client connected");

    let session: Awaited<ReturnType<typeof createVeloGuideSession>> | null = null;
    let textCharsThisTurn = 0;

    try {
      session = await createVeloGuideSession();

      session.subscribe((event: any) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            textCharsThisTurn += msgEvent.delta.length;
            ws.send(JSON.stringify({ type: "delta", text: msgEvent.delta }));
          }
        }

        if (event.type === "tool_execution_start") {
          // The agent gathers ALL data before writing the itinerary, so any
          // assistant text streamed before a tool runs is planning preamble
          // ("I'll gather data… now I'll…"). Tell every client to discard it,
          // so the narration strip lives server-side (works for the web UI,
          // CLI, and any future API client alike) rather than per-client.
          textCharsThisTurn = 0;
          ws.send(JSON.stringify({ type: "reset" }));
          ws.send(JSON.stringify({
            type: "tool_start",
            name: (event as any).toolName ?? "unknown",
            label: (event as any).toolName ?? "unknown",
          }));
        }

        if (event.type === "tool_execution_end") {
          ws.send(JSON.stringify({
            type: "tool_end",
            name: (event as any).toolName ?? "unknown",
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
            textCharsThisTurn = 0;
            // Fast mode is the DEFAULT (compact plans, fewer turns). A client
            // opts into detailed mode by sending fast === false.
            const fast = msg.fast !== false;
            const text = fast
              ? `${msg.text || ""}\n\n${FAST_MODE_INSTRUCTION}`
              : msg.text || "";
            await session.prompt(text, {
              images: images?.length ? images : undefined,
            });

            // Reliability guard: the model occasionally ends a turn after
            // gathering tool data but before writing the itinerary (an empty
            // completion / premature stop). Detect a turn that produced no
            // text and re-prompt once to synthesize from the data already in
            // context — no new tool calls needed.
            if (textCharsThisTurn < 20) {
              await session.prompt(
                "You gathered the data but didn't write the plan. Using ONLY the tool results already in this conversation (do not call any more tools), write the complete final itinerary now.",
              );
            }
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
