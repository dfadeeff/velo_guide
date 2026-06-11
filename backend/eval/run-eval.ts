// Runnable eval harness: drives each case in test-cases.json through the
// PRODUCTION pipeline (intake gate + guards — exactly what the server runs)
// and checks the *automatable* half of EVALUATION.md — intake behavior, tool
// usage, and grounding (tool-sourced distances, junction numbers, POI names,
// no fabricated junction sequences). Judgment-call assertions from the JSON
// (e.g. "beginner-friendly advice is given") are printed for manual /
// LLM-as-judge review, not scored.
//
// Usage:
//   npx tsx eval/run-eval.ts             # all cases, programmatic checks
//   npx tsx eval/run-eval.ts --case basic-day-trip
//   FAST=0 npx tsx eval/run-eval.ts      # detailed (non-fast) mode
//   JUDGE=1 npx tsx eval/run-eval.ts     # + LLM-as-judge: scores quality
//                                        #   dimensions and verdicts the
//                                        #   judgment-call assertions (judge
//                                        #   model: JUDGE_MODEL, default Sonnet)
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { verifyRoute, ungroundedEndpoints, type LatLon } from "../src/utils/geo-sanity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

const { createVeloGuidePipeline } = await import("../src/pipeline.js");
const { judgeReply } = await import("./judge.js");
type PipelineEvent = import("../src/pipeline.js").PipelineEvent;
type TurnOutcome = import("../src/pipeline.js").TurnOutcome;
type JudgeResult = import("./judge.js").JudgeResult;

const useJudge = process.env.JUDGE === "1";

interface TestCase {
  id: string;
  name: string;
  input: string;
  // The intake gate must hold the first turn: zero tools + a targeted question.
  expect_clarification?: boolean;
  // Follow-up user turns sent after `input` (intake answers or refinements).
  turns?: string[];
  expected_tools: string[];
  assertions: string[];
  image?: string; // path relative to eval/ — sent as multimodal input
  reply_must_match?: string; // regex the final reply must satisfy (case-insensitive)
  fast?: boolean; // per-case mode override (e.g. heavy multi-day planning needs detailed mode)
  model?: string; // per-case model override — measured model routing (see EVALUATION.md)
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function loadImage(relPath: string) {
  const abs = path.resolve(__dirname, relPath);
  return {
    type: "image" as const,
    data: fs.readFileSync(abs).toString("base64"),
    mimeType: MIME[path.extname(abs).toLowerCase()] ?? "image/jpeg",
  };
}

interface Check {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

// Unwrap a pi-agent tool result envelope ({ content: [{ text: "<json>" }] }) to
// the parsed payload the tool returned. Tolerates an already-parsed object.
function unwrapToolJson(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return result ?? null;
}

const TURN_TIMEOUT_MS = 300_000;
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

async function runCase(tc: TestCase): Promise<{ checks: Check[]; elapsed: number; reply: string; judge?: JudgeResult; plannedTrip: boolean }> {
  const toolCalls: string[] = [];
  // Raw stringified result per tool name — grounding checks regex into this.
  const toolOutputs: Record<string, string> = {};
  // Structured captures for the geo-sanity checks: the actual routed geometry
  // (waypoints + distance) per plan_route call, and the names geocode resolved.
  const planRoutes: Array<{ waypoints: LatLon[]; km: number }> = [];
  const geocodedNames: string[] = [];

  const pipeline = await createVeloGuidePipeline({
    model: tc.model,
    onEvent: (event: PipelineEvent) => {
      if (event.type === "tool_start") toolCalls.push(event.name);
      if (event.type === "tool_end") {
        toolOutputs[event.name] = (toolOutputs[event.name] ?? "") + JSON.stringify(event.result ?? "");
        if (event.name === "plan_route") {
          const r = unwrapToolJson(event.result);
          if (r && Array.isArray(r.waypoints)) planRoutes.push({ waypoints: r.waypoints, km: parseFloat(r.distance_km) });
        }
        if (event.name === "geocode") {
          const r = unwrapToolJson(event.result);
          if (Array.isArray(r)) for (const g of r) if (g?.name) geocodedNames.push(String(g.name));
        }
      }
    },
  });

  const caseFast = tc.fast ?? fast;
  const checks: Check[] = [];
  const t0 = Date.now();

  const runTurn = (text: string, images?: ReturnType<typeof loadImage>[]) => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`)), TURN_TIMEOUT_MS),
    );
    return Promise.race([pipeline.runTurn({ text, images, fast: caseFast }), timeout]);
  };

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn(tc.input, tc.image ? [loadImage(tc.image)] : undefined);

    // Intake-gate check on the FIRST turn: held (question, zero tools) when
    // parameters are missing; passed straight through when they are complete.
    if (tc.expect_clarification) {
      const held = outcome.kind === "clarification" && outcome.toolCalls.length === 0;
      checks.push({
        name: "intake gate held before planning (zero tools + question)",
        status: held ? "pass" : "fail",
        detail: held ? undefined : `kind=${outcome.kind}, tools=[${outcome.toolCalls.join(", ")}]`,
      });
    } else if (outcome.kind === "clarification") {
      checks.push({
        name: "no unexpected intake question",
        status: "fail",
        detail: `gate asked despite complete parameters: ${outcome.text.slice(0, 120)}`,
      });
    }

    for (const turn of tc.turns ?? []) {
      outcome = await runTurn(turn);
    }
  } catch (err: any) {
    pipeline.dispose();
    return {
      checks: [...checks, { name: "completed without error", status: "fail", detail: err.message }],
      elapsed: (Date.now() - t0) / 1000,
      reply: "",
      plannedTrip: toolCalls.length > 0,
    };
  }
  const elapsed = (Date.now() - t0) / 1000;
  pipeline.dispose();

  const text = outcome.text;

  // 1. Expected tools were called (subset check across all turns; extra calls are fine).
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

  // 2b. Case-specific content requirement (e.g. image comprehension proxy).
  if (tc.reply_must_match) {
    const re = new RegExp(tc.reply_must_match, "i");
    checks.push({
      name: `reply matches /${tc.reply_must_match}/i`,
      status: re.test(text) ? "pass" : "fail",
    });
  }

  // 3. No fabricated knooppunten sequence ("12 → 45 → 63").
  const fabricated = /\d+\s*(?:→|->)\s*\d+\s*(?:→|->)\s*\d+/.test(text);
  checks.push({ name: "no fabricated junction sequence", status: fabricated ? "fail" : "pass" });

  // 4. Junction-number grounding: numbers in "knooppunten …: 12, 34" lines must
  //    come from find_knooppunten output.
  // Junction numbers are zero-padded inconsistently ("07" vs "7", "00" vs "0")
  // by both OSM and the model — compare leading-zero-insensitively on both sides.
  const normJunction = (s: string) => s.replace(/^0+(?=.)/, "");
  const junctionLists = [...text.matchAll(/knooppunten[^:\n]*:\s*([0-9][0-9,\s]*)/gi)];
  if (junctionLists.length && toolOutputs["find_knooppunten"]) {
    const returned = new Set(
      [...toolOutputs["find_knooppunten"].matchAll(/junction_number\\?":\s*\\?"(\w+)/g)].map((m) => normJunction(m[1])),
    );
    const claimed = junctionLists.flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean));
    const invented = claimed.filter((n) => !returned.has(normJunction(n)));
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
  //    A claim may legitimately be the SUM of several routed legs — a day built
  //    from segments, or the trip total summing days whose re-route attempts
  //    sit between them in call order. Accept any subset sum (legs are few;
  //    capped at 14 → ≤16k subsets), falling back to contiguous runs beyond that.
  const claimedKm = [...text.matchAll(/\|\s*~?([\d.]+)\s*km/g)].map((m) => parseFloat(m[1]));
  const routedKm = [...(toolOutputs["plan_route"] ?? "").matchAll(/distance_km\\?":\s*\\?"([\d.]+)/g)].map((m) =>
    parseFloat(m[1]),
  );
  const routedSums: number[] = [];
  if (routedKm.length <= 14) {
    for (let mask = 1; mask < 1 << routedKm.length; mask++) {
      let sum = 0;
      for (let i = 0; i < routedKm.length; i++) if (mask & (1 << i)) sum += routedKm[i];
      routedSums.push(sum);
    }
  } else {
    for (let i = 0; i < routedKm.length; i++) {
      let sum = 0;
      for (let j = i; j < routedKm.length; j++) {
        sum += routedKm[j];
        routedSums.push(sum);
      }
    }
  }
  if (claimedKm.length && routedKm.length) {
    const ungrounded = claimedKm.filter(
      (c) => !routedSums.some((r) => Math.abs(c - r) <= Math.max(0.5, r * 0.02)),
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

  // 7. Geo-sanity on the routed GEOMETRY itself — the layer grounding misses.
  //    The day-distance check (6) only proves a number matches plan_route; it
  //    can't tell whether the route the model asked for makes geographic sense.
  //    These inspect the waypoints plan_route echoed back.
  if (planRoutes.length) {
    const belowFloor: string[] = [];
    const zigzags: string[] = [];
    for (const pr of planRoutes) {
      if (!Array.isArray(pr.waypoints) || pr.waypoints.length < 2 || !isFinite(pr.km)) continue;
      const v = verifyRoute(pr.waypoints, pr.km);
      // (A) HARD fail: a routed day shorter than the great-circle line between
      //     its endpoints is geometrically impossible (wrong endpoints / bad number).
      if (v.belowFloor) belowFloor.push(`${v.routedKm} km < ${v.floorKm} km straight-line floor`);
      // (B) Zigzag: the path nearly doubles back on itself (the Marken-detour class).
      if (v.zigzags.length) zigzags.push(`${v.zigzags.length}× (~${v.zigzags.map((z) => z.angleDeg + "°").join(", ")})`);
    }
    checks.push({
      name: "routes ≥ straight-line floor (no impossible days)",
      status: belowFloor.length ? "fail" : "pass",
      detail: belowFloor.length ? belowFloor.join("; ") : `${planRoutes.length} route(s) checked`,
    });
    checks.push({
      name: "no route zigzags / backtracking",
      status: zigzags.length ? "fail" : "pass",
      detail: zigzags.length ? zigzags.join("; ") : `${planRoutes.length} route(s) checked`,
    });
  } else {
    checks.push({ name: "geo-sanity (routed geometry)", status: "skip", detail: "no plan_route waypoints" });
  }

  // 8. Endpoint grounding: every place named as a day's start/end must have been
  //    geocoded — catches narrative endpoints that no tool ever resolved.
  const dayEndpoints = [...text.matchAll(/Day\s*\d+\s*:\s*([^→|\n]+?)\s*(?:→|->)\s*([^→|\n]+?)\s*\|/gi)]
    .flatMap((m) => [m[1], m[2]])
    .map((s) => s.replace(/[*_#]/g, "").trim())
    .filter(Boolean);
  if (dayEndpoints.length && geocodedNames.length) {
    const ungrounded = [...new Set(ungroundedEndpoints(dayEndpoints, geocodedNames))];
    checks.push({
      name: "day endpoints are geocoded",
      status: ungrounded.length ? "fail" : "pass",
      detail: ungrounded.length ? `not in geocode output: ${ungrounded.join(", ")}` : `${dayEndpoints.length} endpoint(s) checked`,
    });
  } else {
    checks.push({ name: "day endpoints are geocoded", status: "skip" });
  }

  // Optional LLM-as-judge pass: verdicts the judgment-call assertions (these
  // gate pass/fail — they are concrete yes/no questions) and scores the rubric
  // dimensions (reported as quality signal).
  let judge: JudgeResult | undefined;
  if (useJudge) {
    try {
      // Long tool outputs are truncated for the judge, so hand it the complete
      // routed-distance list separately — day distances may sum any subset of
      // these and the judge must see all of them to verify grounding.
      const judgeOutputs: Record<string, string> = {
        ...toolOutputs,
        _all_routed_distances_km: JSON.stringify(routedKm),
      };
      judge = await judgeReply({ input: tc.input, reply: text, toolOutputs: judgeOutputs, assertions: tc.assertions });
      for (const a of judge.assertions) {
        checks.push({
          name: `judge: ${a.assertion.slice(0, 70)}`,
          status: a.verdict === "pass" ? "pass" : "fail",
          detail: a.verdict === "fail" ? a.reason : undefined,
        });
      }
    } catch (err: any) {
      checks.push({ name: "LLM-as-judge", status: "fail", detail: err.message });
    }
  }

  return { checks, elapsed, reply: text, judge, plannedTrip: toolCalls.length > 0 };
}

let failedCases = 0;
const summary: string[] = [];
const dimensionTotals: Record<string, { sum: number; n: number }> = {};

console.log(`Running ${cases.length} case(s) — mode: ${fast ? "fast (default)" : "detailed"}${useJudge ? ` — judge: ${process.env.JUDGE_MODEL ?? "anthropic/claude-sonnet-4.6"}` : ""}\n`);

for (const tc of cases) {
  console.log(`━━━ ${tc.id}: ${tc.name}`);
  console.log(`    input: ${tc.input}`);
  for (const t of tc.turns ?? []) console.log(`    then:  ${t}`);
  const { checks, elapsed, reply, judge, plannedTrip } = await runCase(tc);

  let failed = false;
  for (const c of checks) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "−";
    if (c.status === "fail") failed = true;
    console.log(`    ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (judge) {
    const scoreLine = Object.entries(judge.scores).map(([k, v]) => `${k} ${v}/5`).join("  ");
    console.log(`    quality scores: ${scoreLine}${plannedTrip ? "" : "  (refusal/clarification case — excluded from averages)"}`);
    // Refusal cases (no tools called) legitimately score 1/5 on trip dimensions;
    // averaging them in would misread correct behavior as poor quality.
    if (plannedTrip) {
      for (const [k, v] of Object.entries(judge.scores)) {
        dimensionTotals[k] = { sum: (dimensionTotals[k]?.sum ?? 0) + v, n: (dimensionTotals[k]?.n ?? 0) + 1 };
      }
    }
    if (judge.soft_hallucinations?.length) {
      console.log(`    ⚠ soft hallucinations: ${judge.soft_hallucinations.join(" | ")}`);
    }
    console.log(`    judge summary: ${judge.summary}`);
  } else {
    console.log(`    manual review (not auto-scored — run with JUDGE=1 to score):`);
    for (const a of tc.assertions) console.log(`      · ${a}`);
  }
  console.log(`    reply preview: ${reply.replace(/\s+/g, " ").slice(0, 160)}…`);
  console.log(`    elapsed: ${elapsed.toFixed(1)}s\n`);

  if (failed) failedCases++;
  summary.push(`${failed ? "✗" : "✓"} ${tc.id} (${elapsed.toFixed(0)}s)`);
}

console.log("━━━ SCORECARD ━━━");
for (const line of summary) console.log(line);
if (useJudge && Object.keys(dimensionTotals).length) {
  console.log("\nQuality dimensions (judge avg across cases, 1-5):");
  for (const [k, { sum, n }] of Object.entries(dimensionTotals)) {
    console.log(`  ${k.padEnd(18)} ${(sum / n).toFixed(1)}`);
  }
}
console.log(`\n${cases.length - failedCases}/${cases.length} cases passed`);
process.exit(failedCases ? 1 : 0);