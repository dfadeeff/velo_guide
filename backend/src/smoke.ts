// Headless smoke test: drives one real agent turn and reports tool usage.
// Usage: npx tsx src/smoke.ts "Plan a one-day cycling trip from Amsterdam"
//        npx tsx src/smoke.ts "<prompt>" "<follow-up turn>"     # multi-turn check
//        IMAGE=eval/fixtures/dutch-windmill.jpg npx tsx src/smoke.ts "Somewhere like this?"
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

const { createVeloGuideSession } = await import("./agent.js");
const { FAST_MODE_INSTRUCTION } = await import("./system-prompt.js");
type AgentSessionEvent = import("@earendil-works/pi-coding-agent").AgentSessionEvent;

const fast = process.env.FAST === "1";
const basePrompt = process.argv[2] ?? "Plan a one-day cycling trip from Amsterdam";
const prompt = fast ? `${basePrompt}\n\n${FAST_MODE_INSTRUCTION}` : basePrompt;

// Optional image input (IMAGE=path/to/photo.jpg) — exercises the multimodal path.
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const images = process.env.IMAGE
  ? [{
      type: "image" as const,
      data: fs.readFileSync(path.resolve(process.env.IMAGE)).toString("base64"),
      mimeType: MIME[path.extname(process.env.IMAGE).toLowerCase()] ?? "image/jpeg",
    }]
  : undefined;
if (images) console.error(`Image attached: ${process.env.IMAGE}`);

const session = await createVeloGuideSession();

const toolCalls: string[] = [];
const eventCounts: Record<string, number> = {};
let text = "";
const tStart = Date.now();

session.subscribe((event: AgentSessionEvent) => {
  eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  // Log every non-delta event with a timestamp to expose dead gaps (retries,
  // compaction, etc.) between visible actions.
  if (event.type !== "message_update") {
    process.stderr.write(`  · [t+${((Date.now() - tStart) / 1000).toFixed(0)}s] ${event.type}\n`);
  }
  if (event.type === "tool_execution_start") {
    toolCalls.push(event.toolName);
    // Mirror the server-side narration strip: text before a tool is preamble.
    text = "";
    process.stderr.write(`  → [t+${((Date.now() - t0) / 1000).toFixed(0)}s] tool: ${event.toolName}\n`);
  }
  if (event.type === "tool_execution_end") {
    const r = JSON.stringify(event.result ?? "").slice(0, 90);
    process.stderr.write(`     ✓ ${event.toolName} -> ${r}\n`);
  }
  if (event.type === "message_update") {
    const a = event.assistantMessageEvent;
    if (a.type === "text_delta") text += a.delta;
    if (a.type === "done") {
      const content = a.message.content;
      const msgText = typeof content === "string"
        ? content
        : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      process.stderr.write(`  ⟫ done reason=${a.reason} textLen=${msgText.length}\n`);
      if (!text && msgText) text = msgText;
    }
    if (a.type === "error") {
      process.stderr.write(`  !! msg error reason=${a.reason}: ${JSON.stringify(a.error).slice(0, 200)}\n`);
    }
  }
  if (/error/i.test(event.type)) {
    process.stderr.write(`  !! ${event.type}: ${JSON.stringify(event).slice(0, 300)}\n`);
  }
});

console.error(`\nPrompt: ${prompt}\n`);
const t0 = Date.now();
await session.prompt(prompt, { images });
let reprompted = false;
if (text.length < 20) {
  reprompted = true;
  process.stderr.write("  ⟳ empty turn — re-prompting for synthesis\n");
  await session.prompt(
    "You gathered the data but didn't write the plan. Using ONLY the tool results already in this conversation (do not call any more tools), write the complete final itinerary now.",
  );
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// Optional follow-up turn (process.argv[3]) to test multi-turn refinement:
// does it adjust the existing plan (few tools, no re-ask) vs re-plan from scratch?
const followUp = process.argv[3];
if (followUp) {
  const toolsBefore = toolCalls.length;
  text = "";
  const ft0 = Date.now();
  process.stderr.write(`\n--- FOLLOW-UP: ${followUp} ---\n`);
  await session.prompt(followUp);
  const followUpTools = toolCalls.slice(toolsBefore);
  console.log("\n========== FOLLOW-UP RESULT ==========");
  console.log(`tools on follow-up: ${followUpTools.length} [${followUpTools.join(", ")}]`);
  console.log(`follow-up elapsed:  ${((Date.now() - ft0) / 1000).toFixed(1)}s`);
  console.log(`reply (first 200 chars): ${text.slice(0, 200)}`);
  const asked = /\?\s*$|which|could you|let me know|what.*prefer/i.test(text.slice(0, 300));
  console.log(`re-asked instead of adjusting: ${asked}`);
}

console.log("\n========== TOOLS CALLED ==========");
console.log(toolCalls.join(", ") || "(none)");
console.log("\n========== FINAL ITINERARY ==========");
console.log(text);
console.log("\n========== EVENT COUNTS ==========");
console.log(JSON.stringify(eventCounts, null, 2));
console.log("\n========== CHECKS ==========");
const fab = /\d+\s*(?:→|->|to)\s*\d+\s*(?:→|->|to)\s*\d+/.test(text);
console.log(`tools fired:                 ${toolCalls.length}`);
console.log(`plan_route called:           ${toolCalls.includes("plan_route")}`);
console.log(`get_weather called:          ${toolCalls.includes("get_weather")}`);
console.log(`find_knooppunten called:     ${toolCalls.includes("find_knooppunten")}`);
console.log(`no fabricated junction seq:  ${!fab}`);
console.log(`elapsed:                     ${elapsed}s`);

// Hard failures only (so the exit code is CI-usable): the agent must have used
// tools, produced an itinerary, and not fabricated a junction sequence. The
// per-tool lines above stay informational — not every prompt needs every tool.
const failures: string[] = [];
if (!toolCalls.length) failures.push("no tools were called");
if (text.length < 200) failures.push(`itinerary too short (${text.length} chars)`);
if (fab) failures.push("output contains a fabricated junction sequence");
if (failures.length) {
  console.error(`\nSMOKE FAILED: ${failures.join("; ")}`);
}

session.dispose();
process.exit(failures.length ? 1 : 0);
