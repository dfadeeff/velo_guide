// LLM-as-judge layer for the eval suite (JUDGE=1 make eval).
//
// Scores the judgment-call half of EVALUATION.md that programmatic checks
// can't reach: completeness, Dutch authenticity, weather handling, fit to the
// traveler profile, and soft hallucinations (claims with no basis in the tool
// outputs). The judge sees the captured tool outputs as ground truth, and runs
// on a DIFFERENT model than the agent (Sonnet judges Haiku by default) to
// reduce self-preference bias. Calibration caveat: the judge is itself an LLM —
// its dimension scores are reported as quality signal, while its verdicts on
// the concrete per-case assertions (e.g. "Keukenhof is suggested") gate
// pass/fail because they are low-variance yes/no questions.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-4.6";

export interface JudgeResult {
  assertions: Array<{ assertion: string; verdict: "pass" | "fail"; reason: string }>;
  scores: Record<string, number>; // 1-5 per dimension
  soft_hallucinations: string[];
  summary: string;
}

const RUBRIC = `Score each dimension 1-5 (5 = excellent):
- completeness: daily distance+time, named lunch/coffee stops, accommodation (multi-day), knooppunten numbers, weather note, practical tips
- dutch_authenticity: knooppunten used correctly (as nearby junctions, never an invented ordered sequence), Dutch terms (fietspad, pontje...), wind awareness, NS train options, region-appropriate suggestions
- weather_handling: forecast reflected in advice; adverse weather acknowledged with adjustments; missing forecast handled honestly
- profile_fit: daily distances and difficulty match the traveler profile/fitness implied by the request
- grounding: every place name, distance, and junction number is traceable to the TOOL OUTPUTS; flag embellishments stated as fact (prices, ratings, "michelin-listed", opening times not in the data)

Calibration rules — do NOT over-fail:
- Rounding and unit conversion are fine (57 min → "~1h"; 1305 m → "1.3 km"; 15.2 → "15 km").
- The Netherlands is flat: cumulative ascent under ~150 m over a day's ride supports calling a route "flat" — do not flag it.
- Knooppunten listed per area or per section ("knooppunten in this area: 12, 45, 63") are CORRECT usage; only an explicit ordered chain ("12 → 45 → 63", "follow 12, then 45") is a violation.
- Omissions (unused tool POIs, missing Dutch terms, unmentioned elevation) lower the relevant dimension score but are NOT soft hallucinations and NOT assertion failures.
- soft_hallucinations must contain ONLY specific factual claims absent from the tool outputs (prices, counts, schedules, invented place features) — never omissions or stylistic gaps.
- A loop trip that returns to the start point needs NO accommodation for the final day (the rider is home); one hotel covering multiple nights in the same town satisfies "accommodation for each overnight stop".
- A day's stated distance may legitimately be the SUM of several plan_route legs ridden that day (morning leg + loop + afternoon leg). The "_all_routed_distances_km" entry in TOOL OUTPUTS is the COMPLETE list of routed legs (other entries may be truncated) — a stated distance is grounded if it matches any single leg or subset sum of that list within rounding; only call it ungrounded if no combination gets close.
- An assertion verdict is "fail" only on a clear, demonstrable violation; when genuinely borderline, pass it and explain the nuance in the reason.
- The "verdict" field MUST match your reason's conclusion: if your reasoning ends at "pass" or "pass with caveat", the verdict is "pass" (put the caveat in the reason or soft_hallucinations).`;

export async function judgeReply(args: {
  input: string;
  reply: string;
  toolOutputs: Record<string, string>;
  assertions: string[];
}): Promise<JudgeResult> {
  const toolDump = Object.entries(args.toolOutputs)
    .map(([name, out]) => `### ${name}\n${out.slice(0, 8000)}`)
    .join("\n\n") || "(no tools were called)";

  const prompt = `You are a strict, skeptical evaluator of an AI cycling-trip planner for the Netherlands. Judge the AGENT REPLY against the ground truth in TOOL OUTPUTS.

${RUBRIC}

Also give a pass/fail verdict for each listed assertion. Be literal: pass only if the reply actually satisfies it.

USER REQUEST:
${args.input}

AGENT REPLY:
${args.reply}

TOOL OUTPUTS (ground truth):
${toolDump}

ASSERTIONS TO VERIFY:
${args.assertions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Respond with ONLY a JSON object, no markdown fences. For each assertion write the "reason" FIRST (work through the evidence), THEN the "verdict" — the verdict must follow from the reason's conclusion:
{"assertions":[{"assertion":"...","reason":"...","verdict":"pass"|"fail"}],"scores":{"completeness":N,"dutch_authenticity":N,"weather_handling":N,"profile_fit":N,"grounding":N},"soft_hallucinations":["claims stated as fact with no basis in tool outputs"],"summary":"one sentence"}`;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`judge call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  // Tolerate fenced or prefixed output: take the outermost JSON object.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`judge returned no JSON: ${content.slice(0, 150)}`);
  return JSON.parse(content.slice(start, end + 1)) as JudgeResult;
}
