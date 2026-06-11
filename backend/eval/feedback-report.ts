// Closes the evaluation loop: reads the production feedback DB (FEEDBACK_DB)
// and turns it into eval signal. It prints the satisfaction rate and — the
// point of the whole exercise — emits every downvoted turn as a candidate
// regression case in the SAME shape as eval/test-cases.json, so a real
// thumbs-down becomes a triageable test: drop it into the suite, fix the
// prompt/tool, and `make eval` guards the regression forever after.
//
//   FEEDBACK_DB=./feedback.db npx tsx eval/feedback-report.ts
//   FEEDBACK_DB=./feedback.db npx tsx eval/feedback-report.ts --write   # also writes eval/regression-candidates.json
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { openFeedbackStore } = await import("../src/feedback.js");

const dbPath = process.env.FEEDBACK_DB;
if (!dbPath) {
  console.error("FEEDBACK_DB not set — nothing to report. Enable feedback capture first (see EVALUATION.md).");
  process.exit(1);
}

const store = await openFeedbackStore(dbPath);
if (!store.enabled) {
  console.error(`Could not open feedback DB at ${dbPath} (node:sqlite unavailable, or bad path).`);
  process.exit(1);
}

const { up, down, total } = store.stats();
const all = store.recent(5000);
const downvoted = all.filter((e) => e.rating === "down");

console.log("━━━ FEEDBACK REPORT ━━━");
console.log(`  total ratings:  ${total}`);
console.log(`  👍 up:          ${up}`);
console.log(`  👎 down:        ${down}`);
console.log(`  satisfaction:   ${total ? ((up / total) * 100).toFixed(0) + "%" : "n/a"}\n`);

if (!downvoted.length) {
  console.log("No downvotes — no regression candidates to triage.");
  process.exit(0);
}

// One downvote → one candidate regression case. expected_tools is the actual
// tool trace that produced the disliked plan (dedup, order-preserved); the
// assertion captures the user's stated reason so a human can turn it into a
// concrete pass/fail check.
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "turn";

const candidates = downvoted.map((e, i) => ({
  id: `regression-${slug(e.turn_text)}-${i + 1}`,
  name: `downvoted: ${e.turn_text.slice(0, 60) || "(no text)"}`,
  input: e.turn_text,
  expected_tools: [...new Set(e.tool_calls)],
  assertions: [
    e.comment ? `addresses the reported problem: "${e.comment}"` : "the plan quality issue behind this downvote is fixed",
  ],
  _meta: { model: e.model, ts: e.ts, comment: e.comment },
}));

console.log(`${downvoted.length} downvote(s) → candidate regression cases:\n`);
console.log(JSON.stringify(candidates, null, 2));

if (process.argv.includes("--write")) {
  const out = path.resolve(__dirname, "regression-candidates.json");
  fs.writeFileSync(out, JSON.stringify(candidates, null, 2));
  console.log(`\nWrote ${candidates.length} candidate(s) to ${path.relative(process.cwd(), out)} — triage into test-cases.json.`);
}

store.close();