// Express + WebSocket transport. All conversation logic (intake gate, guards,
// narration strip) lives in pipeline.ts — this file only moves bytes between
// the socket and the pipeline.
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { DEFAULT_MODEL } from "./agent.js";
import { createVeloGuidePipeline, type PipelineEvent } from "./pipeline.js";
import { sanitizeImages } from "./utils/images.js";
import { normalizeSubmission, openFeedbackStore, type TurnRecord } from "./feedback.js";
import { sttBackend, transcribeAudio, validateAudio } from "./stt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");

// How many recent turns to keep joinable for feedback. Feedback arrives seconds
// after a plan; this only needs to outlive that window, not persist sessions.
const TURN_BUFFER_CAP = 500;

export async function startServer(port: number, host: string) {
  const app = express();

  // Feedback is off unless FEEDBACK_DB is set; the store is otherwise a no-op
  // and no feedback controls are advertised to the client (see emitting of
  // turn_id below). It is its own concern, not session persistence.
  const feedback = await openFeedbackStore(process.env.FEEDBACK_DB);

  // Server-authoritative trace of recent turns, keyed by a turn_id handed to the
  // client. Feedback POSTs reference a turn_id; the plan/tool trace is read from
  // HERE, never trusted from the client. Bounded + insertion-ordered (Map), so
  // the oldest turn is evicted once the cap is reached.
  const turnBuffer = new Map<string, TurnRecord>();
  const bufferTurn = (id: string, rec: TurnRecord) => {
    turnBuffer.set(id, rec);
    if (turnBuffer.size > TURN_BUFFER_CAP) turnBuffer.delete(turnBuffer.keys().next().value!);
  };

  const stt = sttBackend();

  // Server-side STT (optional). Registered BEFORE the global JSON parser with
  // its own higher limit, so an audio upload isn't rejected by the 1 MB cap that
  // protects the other routes. The frontend uploads WAV; we reuse the OpenRouter
  // key via an audio-capable chat model (see stt.ts).
  app.post("/transcribe", express.json({ limit: "10mb" }), async (req, res) => {
    if (stt === "browser") return res.status(404).json({ error: "server STT disabled" });
    const audio = validateAudio(req.body?.data, req.body?.mimeType);
    if (!audio) return res.status(400).json({ error: "invalid or missing audio" });
    try {
      res.json({ text: await transcribeAudio(audio) });
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(FRONTEND_DIR));

  // Lets the frontend discover which voice path to use (browser Web Speech API
  // vs. server STT) without baking the choice into the static assets.
  app.get("/config", (_req, res) => res.json({ stt }));

  // Anonymous thumbs up/down on a delivered plan. 404 when feedback is disabled
  // (the UI never shows the controls in that case). 400 on a malformed body,
  // 404 on an unknown/expired turn_id.
  app.post("/feedback", (req, res) => {
    if (!feedback.enabled) return res.status(404).json({ error: "feedback disabled" });
    let sub;
    try {
      sub = normalizeSubmission(req.body);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    const turn = turnBuffer.get(sub.turn_id);
    if (!turn) return res.status(404).json({ error: "unknown or expired turn_id" });
    feedback.record({ ...sub, ...turn, ts: new Date().toISOString() });
    res.json({ ok: true });
  });

  app.get("/feedback/stats", (_req, res) => {
    if (!feedback.enabled) return res.status(404).json({ error: "feedback disabled" });
    res.json(feedback.stats());
  });

  const server = app.listen(port, host, () => {
    const overpass = process.env.OVERPASS_URL
      ? `LOCAL ${process.env.OVERPASS_URL}  (fast)`
      : "PUBLIC overpass-api.de  (rate-limited, slow — set OVERPASS_URL)";
    console.log(`VeloGuide running at http://localhost:${port}`);
    console.log(`  model:    ${process.env.MODEL ?? DEFAULT_MODEL}`);
    console.log(`  overpass: ${overpass}`);
    console.log(`  routing:  ${process.env.ORS_API_KEY ? "OpenRouteService (cycling network + elevation)" : "OSRM fallback"}`);
    const sttLabel =
      stt === "gemini"
        ? `server: Gemini via OpenRouter (${process.env.STT_MODEL ?? "google/gemini-2.5-flash"})`
        : stt === "deepgram"
          ? `server: Deepgram (${process.env.DEEPGRAM_MODEL ?? "nova-2"})${process.env.DEEPGRAM_API_KEY ? "" : " — ⚠ DEEPGRAM_API_KEY not set"}`
          : "browser Web Speech API (set STT_BACKEND=gemini|deepgram for server STT)";
    console.log(`  stt:      ${sttLabel}`);
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

    // Per-connection turn id space (connection uuid + sequence), so a turn_id is
    // unique across concurrent clients and reconnects.
    const connId = randomUUID();
    let turnSeq = 0;

    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const forward = (event: PipelineEvent) => {
      switch (event.type) {
        case "delta":
          send({ type: "delta", text: event.text });
          break;
        case "reset":
          send({ type: "reset" });
          break;
        case "tool_start":
          send({ type: "tool_start", name: event.name, label: event.name });
          break;
        case "tool_end":
          // Tool results stay server-side; the client only needs the lifecycle.
          send({ type: "tool_end", name: event.name });
          break;
      }
    };

    let pipeline: Awaited<ReturnType<typeof createVeloGuidePipeline>> | null = null;
    let busy = false;

    try {
      pipeline = await createVeloGuidePipeline({ onEvent: forward });
      send({ type: "ready" });
    } catch (err: any) {
      console.error("Failed to create agent pipeline:", err);
      send({ type: "error", message: `Failed to initialize: ${err.message}` });
      ws.close();
      return;
    }

    ws.on("message", async (raw: Buffer) => {
      if (!pipeline) return;

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "prompt") return;

        // The web client disables its send button while streaming, but the
        // server is the authority: a second tab (or any raw client) must not
        // interleave prompts into a session mid-turn.
        if (busy) {
          send({ type: "error", message: "Still working on the previous request — please wait for it to finish." });
          return;
        }
        busy = true;

        send({ type: "response_start" });
        let turnId: string | undefined;
        try {
          const text = typeof msg.text === "string" ? msg.text : "";
          const outcome = await pipeline.runTurn({
            text,
            images: sanitizeImages(msg.images),
            fast: msg.fast !== false, // fast is the default; clients opt out with fast === false
          });
          // Only buffer + advertise a turn_id when feedback is enabled — that is
          // the signal the client uses to render the thumbs up/down controls, so
          // a disabled deployment shows none.
          if (feedback.enabled) {
            turnId = `${connId}-${++turnSeq}`;
            bufferTurn(turnId, {
              turn_text: text,
              plan_text: outcome.text,
              tool_calls: outcome.toolCalls,
              model: process.env.MODEL ?? DEFAULT_MODEL,
            });
          }
        } catch (err: any) {
          send({ type: "error", message: err.message });
        } finally {
          busy = false;
        }
        send({ type: "response_end", turn_id: turnId });
      } catch (err: any) {
        console.error("Message handling error:", err);
        send({ type: "error", message: err.message });
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
      pipeline?.dispose();
      pipeline = null;
    });
  });

  return server;
}