// Headless smoke test: drives the PRODUCTION pipeline (intake gate included)
// for one trip and reports tool usage.
// Usage: npx tsx src/smoke.ts "Plan a one-day trip from Amsterdam tomorrow"
//        npx tsx src/smoke.ts "<prompt>" "<follow-up turn>"   # intake answer OR refinement
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

const { createVeloGuidePipeline } = await import("./pipeline.js");
type AgentSessionEvent = import("@earendil-works/pi-coding-agent").AgentSessionEvent;
type TurnOutcome = import("./pipeline.js").TurnOutcome;

const fast = process.env.FAST === "1";
const basePrompt = process.argv[2] ?? "Plan a one-day cycling trip from Amsterdam starting tomorrow";
const followUp = process.argv[3];

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

const toolCalls: string[] = [];
const eventCounts: Record<string, number> = {};
const tStart = Date.now();

// Raw session-event trace: timestamps expose dead gaps (retries, compaction)
// between visible actions. Pipeline events drive the actual checks.
const trace = (event: AgentSessionEvent) => {
  eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  if (event.type !== "message_update") {
    process.stderr.write(`  · [t+${((Date.now() - tStart) / 1000).toFixed(0)}s] ${event.type}\n`);
  }
  if (event.type === "tool_execution_start") {
    toolCalls.push(event.toolName);
    process.stderr.write(`  → tool: ${event.toolName}\n`);
  }
  if (event.type === "tool_execution_end") {
    process.stderr.write(`     ✓ ${event.toolName} -> ${JSON.stringify(event.result ?? "").slice(0, 90)}\n`);
  }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "error") {
    process.stderr.write(`  !! msg error: ${JSON.stringify(event.assistantMessageEvent.error).slice(0, 200)}\n`);
  }
};

const pipeline = await createVeloGuidePipeline({ onSessionEvent: trace });

console.error(`\nPrompt: ${basePrompt}${fast ? "  [fast]" : ""}\n`);
const t0 = Date.now();
let outcome: TurnOutcome = await pipeline.runTurn({ text: basePrompt, images, fast });

if (outcome.kind === "clarification") {
  console.error(`\n--- INTAKE GATE asked (zero tools, agent not invoked) ---\n${outcome.text}\n`);
  if (followUp) {
    console.error(`--- ANSWERING: ${followUp} ---\n`);
    outcome = await pipeline.runTurn({ text: followUp, fast });
  }
} else if (followUp) {
  // Plan delivered on turn 1 — argv[3] becomes a refinement check: does it
  // adjust the existing plan (few tools, no re-ask) vs re-plan from scratch?
  const toolsBefore = toolCalls.length;
  const ft0 = Date.now();
  process.stderr.write(`\n--- FOLLOW-UP: ${followUp} ---\n`);
  const refined = await pipeline.runTurn({ text: followUp, fast });
  const followUpTools = toolCalls.slice(toolsBefore);
  console.log("\n========== FOLLOW-UP RESULT ==========");
  console.log(`tools on follow-up: ${followUpTools.length} [${followUpTools.join(", ")}]`);
  console.log(`follow-up elapsed:  ${((Date.now() - ft0) / 1000).toFixed(1)}s`);
  console.log(`reply (first 200 chars): ${refined.text.slice(0, 200)}`);
  const asked = /\?\s*$|which|could you|let me know|what.*prefer/i.test(refined.text.slice(0, 300));
  console.log(`re-asked instead of adjusting: ${asked}`);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log("\n========== TOOLS CALLED ==========");
console.log(toolCalls.join(", ") || "(none)");
console.log("\n========== FINAL REPLY ==========");
console.log(outcome.text);
console.log("\n========== EVENT COUNTS ==========");
console.log(JSON.stringify(eventCounts, null, 2));
console.log("\n========== CHECKS ==========");
const fab = /\d+\s*(?:→|->|to)\s*\d+\s*(?:→|->|to)\s*\d+/.test(outcome.text);
console.log(`outcome kind:                ${outcome.kind}`);
console.log(`tools fired:                 ${toolCalls.length}`);
console.log(`plan_route called:           ${toolCalls.includes("plan_route")}`);
console.log(`get_weather called:          ${toolCalls.includes("get_weather")}`);
console.log(`find_knooppunten called:     ${toolCalls.includes("find_knooppunten")}`);
console.log(`no fabricated junction seq:  ${!fab}`);
console.log(`elapsed:                     ${elapsed}s`);

// Hard failures only (so the exit code is CI-usable). A run that ends at the
// intake gate without an answer turn is a usage error, not an agent failure —
// flag it with instructions.
const failures: string[] = [];
if (outcome.kind === "clarification") {
  failures.push('run ended at the intake gate — pass the missing details as a second argument, e.g. npx tsx src/smoke.ts "<prompt>" "tomorrow, one day"');
} else {
  if (!toolCalls.length) failures.push("no tools were called");
  if (outcome.text.length < 200) failures.push(`itinerary too short (${outcome.text.length} chars)`);
  if (fab) failures.push("output contains a fabricated junction sequence");
}
if (failures.length) {
  console.error(`\nSMOKE FAILED: ${failures.join("; ")}`);
}

pipeline.dispose();
process.exit(failures.length ? 1 : 0);