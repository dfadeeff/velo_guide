# Quality Evaluation Plan

## Evaluation Dimensions

### 1. Factual Accuracy (Critical)
Are distances, cycling times, and elevation values sourced from the `plan_route` tool, not hallucinated by the LLM?

**Method**: For each response, verify that every distance/time claim appears in the preceding tool call result. Flag any numeric claim without a tool source.

**Metric**: `factual_grounding_rate` = claims with tool source / total numeric claims. Target: >95%.

### 2. POI Validity
Do mentioned restaurants, cafes, and attractions actually exist?

**Method**: Cross-reference every named POI against the `find_pois` or `find_accommodation` tool result in the conversation trace. Sample-check 10% against Google Maps.

**Metric**: `poi_existence_rate` = verifiable POIs / total mentioned POIs. Target: >90%.

### 3. Route Feasibility
Is the proposed route actually cyclable? No highways, no missing water crossings, reasonable daily distances?

**Method**: Check that `plan_route` returned success (not an error). Verify daily distance is within the stated fitness level guidelines (casual <80 km, experienced <130 km).

**Metric**: `route_feasibility_rate`. Target: 100% (tool-computed routes are inherently feasible).

### 4. Weather Appropriateness
Does the itinerary acknowledge adverse weather? Are indoor alternatives suggested when it rains?

**Method**: Check `get_weather` tool output. If precipitation >5mm or wind >30 km/h, verify the response acknowledges it and adjusts recommendations.

**Metric**: `weather_acknowledgment_rate` for adverse conditions. Target: >90%.

### 5. Completeness
Does a multi-day plan include all essential elements?

**Checklist** (score 1 point each):
- [ ] Daily distance and estimated cycling time
- [ ] Lunch stop with a specific named place
- [ ] Coffee/rest stop
- [ ] Accommodation for overnight (multi-day only)
- [ ] Knooppunten junction numbers mentioned
- [ ] Weather advisory
- [ ] Practical tip (water, bike repair, train connection)

**Metric**: `completeness_score` = items checked / total items. Target: >80%.

### 6. Graceful Degradation
How does the system handle edge cases and failures?

**Test cases**:
- API timeout/failure → should communicate limitation, not crash
- Dates too far ahead → should explain forecast limitation
- No POIs found in area → should say so, not invent
- Unreasonable distance request → should flag and suggest alternatives
- Non-Netherlands location → should redirect to NL scope

**Metric**: `graceful_handling_rate`. Target: 100%.

### 7. Dutch Cycling Authenticity
Does the output demonstrate genuine Netherlands cycling knowledge?

**Checklist**:
- [ ] Knooppunten mentioned with actual junction numbers
- [ ] Dutch cycling terms used (fietspad, pontje, etc.)
- [ ] Wind direction considered in route planning
- [ ] NS train connections mentioned for one-way routes
- [ ] Region-appropriate suggestions (Veluwe for nature, Kinderdijk for windmills, etc.)

## Test Scenarios

### Scenario 1: Basic Day Trip
**Input**: "Plan a one-day cycling trip from Amsterdam"
**Expected**: Geocode Amsterdam → get weather for today → plan route to a nearby destination → find POIs along route → find knooppunten → structured itinerary with 40-60 km.

### Scenario 2: Multi-Day Experienced
**Input**: "Plan a 3-day trip through the Veluwe for an experienced cyclist"
**Expected**: Longer daily distances (80-100 km), forest routes, accommodation each night, Veluwe-specific attractions (Hoge Veluwe park, Kröller-Müller museum).

### Scenario 3: Specific Destination
**Input**: "I want to cycle from Rotterdam to Kinderdijk to see the windmills. I'm a beginner."
**Expected**: Short route (~30 km round trip), windmill-specific POIs, beginner-friendly advice, ferry crossing mentioned.

### Scenario 4: Image Input
**Input**: Photo of a Dutch landscape + "I want to cycle somewhere that looks like this"
**Expected**: Agent describes the image, identifies landscape type, suggests matching region.
**Automated**: the `image-input` eval case sends a CC0 Kinderdijk windmill photo (`backend/eval/fixtures/`) through the multimodal path and checks the reply identifies the windmill/polder landscape and plans a grounded route to a matching region.

### Scenario 5: Unreasonable Request
**Input**: "I want to cycle 200 km in one day, I'm a casual cyclist"
**Expected**: Agent flags this as unreasonable (~12+ hours cycling), suggests splitting into 2-3 days.

### Scenario 6: Far-Future Date
**Input**: "Plan a trip for December 2027"
**Expected**: Agent plans route and POIs but explains weather forecast is unavailable beyond 16 days.

### Scenario 7: Seasonal Query
**Input**: "Where should I cycle to see tulips in April?"
**Expected**: Suggest Keukenhof/Lisse area and plan a route there for the next April (the model knows today's date). If that is beyond the 16-day forecast window, note that weather must be checked closer to the date. `web_search` is optional (e.g. for festival dates) — the prompt deliberately discourages it.

## Automated Evaluation (`make eval`)

The grounding-related half of this plan is **implemented and runnable**: `make eval`
drives every case in `backend/eval/test-cases.json` through a real headless agent
session and scores it programmatically (exit code is CI-usable). Per case it checks:

1. **Expected tools were called** (trace analysis of the agent event stream)
2. **No fabricated knooppunten sequences** (`12 → 45 → 63` pattern)
3. **Junction numbers are grounded**: every number in a "knooppunten …:" list appears in `find_knooppunten` output
4. **POI usage**: the reply names places returned by `find_pois`/`find_accommodation`
5. **Day distances match `plan_route`** within 2% — catches estimated-not-computed numbers
6. **Latency** per case is reported (target: <30s with a local Overpass)

The suite also covers **multimodal input** (the `image-input` case sends a real
windmill photo and checks the reply identifies the landscape — see Scenario 4)
and per-case **`reply_must_match`** content assertions. **Voice input** is
transcribed to text in the browser before it reaches the agent, so every text
check above covers the voice path; the browser-side recognition itself is
verified manually (mic button, Chrome/Edge/Safari).

Run a single case with `CASE=basic-day-trip make eval`; `FAST=0` evaluates the
detailed (non-fast) mode. Cases may pin a mode: `multi-day-experienced` sets
`"fast": false` because hitting 80–130 km/day requires the iterative re-routing
that fast mode's batch-everything instruction suppresses — judged runs showed
42–56 km/day in fast mode vs in-range days in detailed mode (which is the mode a
user planning a serious multi-day trip would use). The judgment-call assertions in `test-cases.json`
(e.g. "beginner-friendly advice is given") are printed alongside each case for
manual review. `make smoke` runs one ad-hoc prompt with the same checks plus a
timestamped latency trace; it also exercises **multi-turn refinement** (second
CLI arg = a follow-up turn; reports whether the agent adjusted with few tool
calls or re-asked/re-planned) and **image input** (`IMAGE=eval/fixtures/dutch-windmill.jpg`).

### LLM-as-judge (`JUDGE=1 make eval`)

The judgment-call half is also runnable. With `JUDGE=1`, every reply is scored by a
**different model** than the agent (Sonnet judges Haiku by default; `JUDGE_MODEL`
overrides) against the dimensions above, using the captured tool outputs as ground
truth:

- **Per-case assertion verdicts** (e.g. "Keukenhof is suggested", "beginner-friendly
  advice is given") — these gate pass/fail because they are concrete yes/no questions.
- **Dimension scores 1–5** (completeness, Dutch authenticity, weather handling,
  profile fit, grounding) — reported and averaged across the suite as a quality trend,
  not a gate.
- **Soft-hallucination detection** — specific factual claims with no basis in the tool
  outputs (prices, monument counts, train frequencies). This is the class programmatic
  checks structurally cannot catch; in practice the judge surfaced exactly these (a
  "~€5–6" ticket price, "19 windmills", "trains every 15–20 min"), which drove a
  numbers-grounding rule in the system prompt.

The judge prompt carries explicit **calibration rules** (rounding is fine; <150 m
cumulative ascent counts as "flat" in NL; per-area junction lists are correct usage;
omissions lower scores but are not hallucinations; loop trips need no final-night
hotel; the verdict field must match the reason's conclusion) — each added after
observing the judge over-fail on exactly that. Caveat: the judge is itself an LLM;
treat dimension scores as trend signal across runs, not absolute truth, and
spot-check its verdicts.

**What the judged eval has already driven** (evaluation working as intended):
a numbers-grounding prompt rule (after the judge caught "~€5–6 ticket", "19
windmills"), flagship-sight anchoring for famous regions (after a Veluwe plan
missed Hoge Veluwe), the clarification pipeline guard (after zero-tool question
replies recurred), a `target_min_km` feedback signal in `plan_route` results,
and **measured model routing**: across 7 judged runs Haiku hit the 80–130 km/day
experienced-rider target only once (typical: 40–65 km days) even with the prompt
rule and tool feedback; Sonnet lands ~80–100 km/day. The eval therefore pins
`multi-day-experienced` to detailed mode + Sonnet (`"fast"`/`"model"` fields),
and the product guidance follows the same data: ambitious multi-day trips are
where `MODEL=anthropic/claude-sonnet-4.6` earns its ~3× cost; Haiku stays the
default for everything else.

### Future automation

1. **A/B model comparison**: run the same judged suite across Claude Haiku (default) vs Claude Sonnet (quality upgrade) vs Gemini Flash (cost floor), compare dimension averages

## Evaluation Cadence

- **Every push (CI)**: type-check + offline unit tests (`make test` — formatting/geo helpers, bearing correctness, prompt invariants like date injection and grounding rules, tool registry, eval-case schema). Deterministic, no API key.
- **Pre-release / per prompt or model change**: `make eval` (locally, or the manually dispatched `live-eval` CI job) + manual scoring of the judgment dimensions
- **Weekly**: `make eval` regression (automated checks on all scenarios)
