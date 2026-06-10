// Runnable eval harness: drives each case in test-cases.json through a real
// headless agent session and checks the *automatable* half of EVALUATION.md —
// tool usage and grounding (tool-sourced distances, junction numbers, POI
// names, no fabricated junction sequences). Judgment-call assertions from the
// JSON (e.g. "beginner-friendly advice is given") are printed for manual /
// LLM-as-judge review, not scored.
//
// Usage:
//   npx tsx eval/run-eval.ts             # all cases
//   npx tsx eval/run-eval.ts --case basic-day-trip
//   FAST=0 npx tsx eval/run-eval.ts      # detailed (non-fast) mode
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

const { createVeloGuideSession } = await import("../src/agent.js");
const { FAST_MODE_INSTRUCTION } = await import("../src/system-prompt.js");

interface TestCase {
  id: string;
  name: string;
  input: string;
  expected_tools: string[];
  assertions: string[];
}

interface Check {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

const CASE_TIMEOUT_MS = 300_000;
// Fast mode mirrors the web UI default; FAST=0 evaluates the detailed path.
const fast = process.env.FAST !== "0";

const allCases: TestCase[] = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "test-cases.json"), "utf-8"),
);
const caseFlag = process.argv.indexOf("--case");
const cases =
  caseFlag !== -1
    ? allCases.filter((c) => c.id === process.argv[caseFlag + 1])
    : allCases;
if (!cases.length) {
  console.error(`No matching case. Available: ${allCases.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

async function runCase(tc: TestCase): Promise<{ checks: Check[]; elapsed: number; reply: string }> {
  const session = await createVeloGuideSession();

  const toolCalls: string[] = [];
  // Raw stringified result per tool name — grounding checks regex into this.
  const toolOutputs: Record<string, string> = {};
  let text = "";

  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      toolCalls.push(event.toolName ?? "unknown");
      text = ""; // mirror the server-side narration strip
    }
    if (event.type === "tool_execution_end") {
      const out = JSON.stringify(event.result ?? event.output ?? "");
      toolOutputs[event.toolName] = (toolOutputs[event.toolName] ?? "") + out;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });

  const t0 = Date.now();
  const prompt = fast ? `${tc.input}\n\n${FAST_MODE_INSTRUCTION}` : tc.input;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`case timed out after ${CASE_TIMEOUT_MS / 1000}s`)), CASE_TIMEOUT_MS),
  );
  try {
    await Promise.race([session.prompt(prompt), timeout]);
    if (text.length < 20) {
      // Same empty-turn backstop the server uses.
      await Promise.race([
        session.prompt(
          "You gathered the data but didn't write the plan. Using ONLY the tool results already in this conversation (do not call any more tools), write the complete final itinerary now.",
        ),
        timeout,
      ]);
    }
  } catch (err: any) {
    session.dispose();
    return {
      checks: [{ name: "completed without error", status: "fail", detail: err.message }],
      elapsed: (Date.now() - t0) / 1000,
      reply: text,
    };
  }
  const elapsed = (Date.now() - t0) / 1000;
  session.dispose();

  const checks: Check[] = [];
  const allToolOutput = Object.values(toolOutputs).join("\n");

  // 1. Expected tools were called (subset check; extra calls are fine).
  if (tc.expected_tools.length) {
    const missing = tc.expected_tools.filter((t) => !toolCalls.includes(t));
    checks.push({
      name: "expected tools called",
      status: missing.length ? "fail" : "pass",
      detail: missing.length ? `missing: ${missing.join(", ")}` : `[${toolCalls.join(", ")}]`,
    });
  } else {
    checks.push({ name: "expected tools called", status: "skip", detail: "no tools expected" });
  }

  // 2. A real reply was produced.
  checks.push({
    name: "non-empty reply",
    status: text.trim().length >= 50 ? "pass" : "fail",
    detail: `${text.trim().length} chars`,
  });

  // 3. No fabricated knooppunten sequence ("12 → 45 → 63").
  const fabricated = /\d+\s*(?:→|->)\s*\d+\s*(?:→|->)\s*\d+/.test(text);
  checks.push({ name: "no fabricated junction sequence", status: fabricated ? "fail" : "pass" });

  // 4. Junction-number grounding: numbers in "knooppunten …: 12, 34" lines must
  //    come from find_knooppunten output.
  const junctionLists = [...text.matchAll(/knooppunten[^:\n]*:\s*([0-9][0-9,\s]*)/gi)];
  if (junctionLists.length && toolOutputs["find_knooppunten"]) {
    const returned = new Set(
      [...toolOutputs["find_knooppunten"].matchAll(/junction_number\\?":\s*\\?"(\w+)/g)].map((m) => m[1]),
    );
    const claimed = junctionLists.flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean));
    const invented = claimed.filter((n) => !returned.has(n) && !returned.has(n.replace(/^0+/, "")));
    checks.push({
      name: "junction numbers grounded in tool output",
      status: invented.length ? "fail" : "pass",
      detail: invented.length ? `not in tool output: ${invented.join(", ")}` : `${claimed.length} checked`,
    });
  } else {
    checks.push({ name: "junction numbers grounded in tool output", status: "skip" });
  }

  // 5. POI usage: if find_pois returned named places, the reply should name at
  //    least one of them (proves the itinerary is built from tool data).
  const poiOutput = (toolOutputs["find_pois"] ?? "") + (toolOutputs["find_accommodation"] ?? "");
  const poiNames = [...poiOutput.matchAll(/name\\?":\s*\\?"([^\\"]{3,})/g)].map((m) => m[1]);
  if (poiNames.length) {
    const used = poiNames.filter((n) => text.includes(n));
    checks.push({
      name: "reply uses tool-returned POI names",
      status: used.length ? "pass" : "fail",
      detail: `${used.length}/${poiNames.length} returned names appear in reply`,
    });
  } else {
    checks.push({ name: "reply uses tool-returned POI names", status: "skip" });
  }

  // 6. Day-header distances ("Day 1: … | 48.4 km") must match a plan_route
  //    distance within 2% / 0.5 km — catches estimated-not-computed distances.
  const claimedKm = [...text.matchAll(/\|\s*~?([\d.]+)\s*km/g)].map((m) => parseFloat(m[1]));
  const routedKm = [...(toolOutputs["plan_route"] ?? "").matchAll(/distance_km\\?":\s*\\?"([\d.]+)/g)].map((m) =>
    parseFloat(m[1]),
  );
  if (claimedKm.length && routedKm.length) {
    const ungrounded = claimedKm.filter(
      (c) => !routedKm.some((r) => Math.abs(c - r) <= Math.max(0.5, r * 0.02)),
    );
    checks.push({
      name: "day distances match plan_route",
      status: ungrounded.length ? "fail" : "pass",
      detail: ungrounded.length
        ? `no tool match for: ${ungrounded.join(", ")} km (routed: ${routedKm.join(", ")})`
        : `${claimedKm.length} day distance(s) checked`,
    });
  } else {
    checks.push({ name: "day distances match plan_route", status: "skip" });
  }

  return { checks, elapsed, reply: text };
}

let failedCases = 0;
const summary: string[] = [];

console.log(`Running ${cases.length} case(s) — mode: ${fast ? "fast (default)" : "detailed"}\n`);

for (const tc of cases) {
  console.log(`━━━ ${tc.id}: ${tc.name}`);
  console.log(`    input: ${tc.input}`);
  const { checks, elapsed, reply } = await runCase(tc);

  let failed = false;
  for (const c of checks) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "−";
    if (c.status === "fail") failed = true;
    console.log(`    ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`    manual review (not auto-scored):`);
  for (const a of tc.assertions) console.log(`      · ${a}`);
  console.log(`    reply preview: ${reply.replace(/\s+/g, " ").slice(0, 160)}…`);
  console.log(`    elapsed: ${elapsed.toFixed(1)}s\n`);

  if (failed) failedCases++;
  summary.push(`${failed ? "✗" : "✓"} ${tc.id} (${elapsed.toFixed(0)}s)`);
}

console.log("━━━ SCORECARD ━━━");
for (const line of summary) console.log(line);
console.log(`\n${cases.length - failedCases}/${cases.length} cases passed`);
process.exit(failedCases ? 1 : 0);
