import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createVeloGuideSession, DEFAULT_MODEL } from "./agent.js";
import {
  CLARIFICATION_PATTERN,
  CLARIFICATION_REPROMPT,
  FAST_MODE_INSTRUCTION,
  SYNTHESIS_REPROMPT,
} from "./system-prompt.js";

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
    console.log(`  model:    ${process.env.MODEL ?? DEFAULT_MODEL}`);
    console.log(`  overpass: ${overpass}`);
    console.log(`  routing:  ${process.env.ORS_API_KEY ? "OpenRouteService (cycling network + elevation)" : "OSRM fallback"}`);
  });

  const wss = new WebSocketServer({ server });

  // Heartbeat: ping every 30s and drop connections that miss a pong, so dead
  // sockets (sleep, network change, proxy idle-close) are detected instead of
  // lingering, and intermediaries see traffic on long-idle chats.
  const HEARTBEAT_MS = 30_000;
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", async (ws: WebSocket) => {
    console.log("Client connected");
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    let session: Awaited<ReturnType<typeof createVeloGuideSession>> | null = null;
    let textCharsThisTurn = 0;
    let textThisTurn = "";
    let toolCallsThisTurn = 0;
    let busy = false;

    try {
      session = await createVeloGuideSession();

      session.subscribe((event: AgentSessionEvent) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            textCharsThisTurn += msgEvent.delta.length;
            textThisTurn += msgEvent.delta;
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
          textThisTurn = "";
          toolCallsThisTurn++;
          ws.send(JSON.stringify({ type: "reset" }));
          ws.send(JSON.stringify({
            type: "tool_start",
            name: event.toolName,
            label: event.toolName,
          }));
        }

        if (event.type === "tool_execution_end") {
          ws.send(JSON.stringify({ type: "tool_end", name: event.toolName }));
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
          // The web client disables its send button while streaming, but the
          // server is the authority: a second tab (or any raw client) must not
          // interleave prompts into a session mid-turn.
          if (busy) {
            ws.send(JSON.stringify({ type: "error", message: "Still working on the previous request — please wait for it to finish." }));
            return;
          }
          busy = true;

          const images = msg.images?.map((img: any) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType,
          }));

          ws.send(JSON.stringify({ type: "response_start" }));

          try {
            textCharsThisTurn = 0;
            textThisTurn = "";
            toolCallsThisTurn = 0;
            // Fast mode is the DEFAULT (compact plans, fewer turns). A client
            // opts into detailed mode by sending fast === false.
            const fast = msg.fast !== false;
            const text = fast
              ? `${msg.text || ""}\n\n${FAST_MODE_INSTRUCTION}`
              : msg.text || "";
            await session.prompt(text, {
              images: images?.length ? images : undefined,
            });

            // Reliability guard 1 (premature stop): the model occasionally ends
            // a turn after gathering tool data but before writing the itinerary.
            // Detect a turn that produced no text and re-prompt once to
            // synthesize from the data already in context.
            if (textCharsThisTurn < 20) {
              await session.prompt(SYNTHESIS_REPROMPT);
            } else if (toolCallsThisTurn === 0 && CLARIFICATION_PATTERN.test(textThisTurn)) {
              // Reliability guard 2 (clarification loop): the model asked about
              // trip length/year/direction instead of planning, violating the
              // answer-first policy. Discard the question client-side and
              // re-prompt once to apply defaults and deliver the plan.
              ws.send(JSON.stringify({ type: "reset" }));
              await session.prompt(CLARIFICATION_REPROMPT);
            }
          } catch (err: any) {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          } finally {
            busy = false;
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
