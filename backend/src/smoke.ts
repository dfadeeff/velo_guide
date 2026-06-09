// Headless smoke test: drives one real agent turn and reports tool usage.
// Usage: npx tsx src/smoke.ts "Plan a one-day cycling trip from Amsterdam"
import dotenv from "dotenv";
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

const fast = process.env.FAST === "1";
const basePrompt = process.argv[2] ?? "Plan a one-day cycling trip from Amsterdam";
const prompt = fast ? `${basePrompt}\n\n${FAST_MODE_INSTRUCTION}` : basePrompt;

const session = await createVeloGuideSession();

const toolCalls: string[] = [];
const eventCounts: Record<string, number> = {};
let text = "";
const tStart = Date.now();

session.subscribe((event: any) => {
  eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  // Log every non-delta event with a timestamp to expose dead gaps (retries,
  // compaction, etc.) between visible actions.
  if (event.type !== "message_update") {
    const a = event.assistantMessageEvent?.type ? `:${event.assistantMessageEvent.type}` : "";
    process.stderr.write(`  · [t+${((Date.now() - tStart) / 1000).toFixed(0)}s] ${event.type}${a}\n`);
  }
  if (event.type === "tool_execution_start") {
    toolCalls.push(event.toolName ?? "unknown");
    // Mirror the server-side narration strip: text before a tool is preamble.
    text = "";
    process.stderr.write(`  → [t+${((Date.now() - t0) / 1000).toFixed(0)}s] tool: ${event.toolName}\n`);
  }
  if (event.type === "tool_execution_end") {
    const r = JSON.stringify((event as any).result ?? (event as any).output ?? "").slice(0, 90);
    process.stderr.write(`     ✓ ${event.toolName} -> ${r}\n`);
  }
  if (event.type === "message_update") {
    const a = event.assistantMessageEvent;
    if (a?.type === "text_delta") text += a.delta;
    if (a?.type === "done") {
      const content = a.message?.content;
      const msgText = typeof content === "string"
        ? content
        : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      process.stderr.write(`  ⟫ done reason=${a.reason} textLen=${msgText.length}\n`);
      if (!text && msgText) text = msgText;
    }
    if (a?.type === "error") {
      process.stderr.write(`  !! msg error reason=${a.reason}: ${JSON.stringify(a.error).slice(0, 200)}\n`);
    }
  }
  if (/error/i.test(event.type)) {
    process.stderr.write(`  !! ${event.type}: ${JSON.stringify(event).slice(0, 300)}\n`);
  }
});

console.error(`\nPrompt: ${prompt}\n`);
const t0 = Date.now();
await session.prompt(prompt);
let reprompted = false;
if (text.length < 20) {
  reprompted = true;
  process.stderr.write("  ⟳ empty turn — re-prompting for synthesis\n");
  await session.prompt(
    "You gathered the data but didn't write the plan. Using ONLY the tool results already in this conversation (do not call any more tools), write the complete final itinerary now.",
  );
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

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

session.dispose();
process.exit(0);
