# Architecture Deep-Dive

Companion to [DECISIONS.md](DECISIONS.md) (the one-page summary). This document explains how the system works and the engineering behind the headline decisions.

## How It Works (Core Architecture)

VeloGuide is a single **pi-agent** session running a ReAct-style agentic loop. The
SDK (`createAgentSession`) supplies the loop, tool-call schema validation,
streaming, image handling, context compaction, and retries. We supply only two
things — the **tools** and the **system prompt** — which keeps the system small
and debuggable.

One turn flows like this:

1. The model receives the system prompt (with the current date injected at
   session creation), the user's text (and any image), and the TypeBox schemas
   of the 7 custom tools (built-in coding tools are disabled via
   `noTools: "builtin"`). Tools are declared with the SDK's `defineTool()`, so
   parameter types are derived from the schemas end-to-end.
2. It emits tool calls as structured JSON; pi-agent validates them against the
   schemas before our `execute` runs.
3. Each tool hits a real data source (OpenRouteService or OSRM / OSM Overpass /
   Open-Meteo / Nominatim) and returns text into the conversation.
4. The model reads the results and either calls more tools or writes the final
   itinerary. The loop repeats until it stops calling tools.

**Input modalities.** Text is primary. Images travel through
`session.prompt(text, { images })` to a vision-capable model. Voice is
transcribed **in the browser** (Web Speech API) and arrives as ordinary text —
the backend never handles audio, so every grounding rule below applies to all
three modalities unchanged.

**Why this makes a good velo guide for a *specific* country.** The
"Netherlands-ness" is not a parameter — it is baked into three layers:

- **The tools encode the country.** `geocode` is hard-scoped to the Netherlands
  (`countrycodes=NL`). `find_knooppunten` queries the Dutch `rcn_ref` node network
  — the fietsknooppunten system is a Dutch institution and the literal way people
  navigate by bike here; the tool would be meaningless elsewhere.
- **The system prompt encodes the domain.** Wind exposure, realistic recreational
  speeds, regions (Veluwe / Waterland / Zeeland), NS bike tickets, pontjes,
  OV-fiets.
- **The data sources are chosen for NL quality.** The whole grounding strategy
  holds because Dutch OSM coverage is among the best in the world. In a
  low-coverage country the same architecture would degrade — that is the explicit
  boundary of the approach.

**The invariant that makes it sound.** The LLM never produces a falsifiable fact.
Distances, cycling times, and compass bearings come only from `plan_route`; POIs
and accommodation only from Overpass; weather only from Open-Meteo; knooppunten
only from `find_knooppunten`. The model's job is reduced to orchestration and
prose — the two things LLMs are reliable at — while every number and place name
is delegated to a deterministic source. This is the core anti-hallucination
strategy, and `make eval` verifies it end-to-end.

## LLM-Specific Issue Handling (full table)

| Issue | Mitigation |
|-------|------------|
| Premature stop / empty completion | The model occasionally ends a turn after gathering tool data but before writing the plan. Primary mitigation: a model measured reliable in tool loops (Haiku 4.5 default; Sonnet 4.6 as the quality upgrade — Gemini Flash was rejected for exactly this failure). Backstop: a guard that detects a turn producing no itinerary text and re-prompts once to synthesize from the data already in context |
| Hallucinated distances/times | `plan_route` tool provides computed values; system prompt forbids estimation; eval checks every day-header distance against tool output (sums of consecutive legs allowed) |
| Invented restaurants/places | All POI names come from OSM; system prompt says "ONLY mention tool-returned places"; eval checks the reply uses tool-returned names |
| Stale sense of "today" | LLMs resolve "tomorrow" against their training cutoff. The current date (Europe/Amsterdam) is injected into the system prompt at session creation, so relative dates and `get_weather` calls resolve correctly |
| Guessed compass directions | The model invents bearings ("ride northeast to Kinderdijk" — it's southeast). `plan_route` returns a computed per-leg cardinal bearing; the prompt forbids stating directions not present in tool output |
| Unbalanced multi-day plans | A 13 km "day" between two 40 km days reads as a planning failure. Hard prompt rule: days must be roughly comparable (no day < half the longest, full days ≥ ~30 km) unless the user asks for a rest day |
| Clarification loops | Answer-first policy: explicit defaults for date (tomorrow), trip length (1 day), fitness (moderate), destination (chosen, not asked); the only permitted question is a genuinely missing start location. Prompt rules alone proved ~70-90% reliable across eval runs, so a **pipeline guard** backstops them: a zero-tool reply matching the observed asking patterns ("how long", "which year", "I need to clarify") is discarded and re-prompted once with the defaults reminder — same architecture as the empty-turn guard |
| Weather for far-future dates | `get_weather` validates the 16-day horizon, clamps straddling ranges, and instructs the model to plan anyway and advise checking later |
| Impossible routes | Routing errors surfaced with explanation (water crossing, no bike route, etc.) |
| Over-ambitious daily distances | System prompt includes fitness-level guidelines; agent flags unreasonable plans (eval: 200 km casual request) |
| Fabricated knooppunten sequences | `find_knooppunten` returns a *proximity list* (with an explicit `note`), and the prompt forbids presenting junctions as an ordered "12 → 45 → 63" route — the one place the grounding invariant could leak is closed by framing junctions as "in the area". Eval greps for fabricated sequences and verifies every quoted junction number exists in tool output |
| Soft hallucinations (ungrounded prices, counts, frequencies) | Prompt rule: precise figures must be tool-sourced or omitted. Detection: LLM-as-judge eval layer (`JUDGE=1 make eval`) cross-checks every claim against the captured tool outputs — it surfaced "~€5–6 ticket", "19 windmills", "trains every 15–20 min" in practice |
| LLM-as-judge miscalibration | The judge over-failed on rounding, NL-flatness, and per-area junction lists; its prompt now carries explicit calibration rules, concrete assertions gate pass/fail while dimension scores stay advisory, and the judge runs on a different model than the agent |
| Stale/missing data | Disclaimer that OSM data may be incomplete; suggest verifying opening hours |

## Latency Engineering

Profiled end-to-end with a timestamped event trace (`make smoke`). The model and
framework are *not* the bottleneck — Claude Haiku 4.5 runs ~79 tok/s, individual
calls return in 1–4s (even with a 17K-token context), and the final itinerary
synthesis takes ~8–9s. **Essentially all latency variance is in the public OSM
Overpass API calls** (POIs + knooppunten). Findings and fixes:

- A dead secondary mirror (`kumi.systems`) hung for the full 40s timeout on every
  retry when the primary throttled — the single worst offender (~40–60s per
  affected call). **Fixed**: removed; we use only `overpass-api.de` with a 12s
  timeout and bounded backoff. Every public mirror evaluated was unusable
  (Switzerland-only data, or unreachable-and-hanging); a dead secondary is worse
  than none.
- The keyless DuckDuckGo `web_search` had no timeout and returned nothing, so the
  model retried it. **Fixed**: 6s-bounded, single-shot, discouraged in the prompt.
- Public Overpass rate-limits per IP (HTTP 406/429/504, then a multi-minute
  block) under the burst of lookups one plan needs. Mitigated with (a) an
  in-memory query **cache** (repeat lookups never re-hit the API), (b) a
  **serialized queue** with minimum spacing, (c) **bounded exponential backoff**
  (fail in ~7s rather than stalling 30s — the agent degrades gracefully, stating
  the limitation instead of inventing data), (d) prompt guidance to **batch POI
  categories** into single calls.
- The decisive fix is the **self-hosted Overpass with a Dutch extract** (README
  "Fast local Overpass"): measured full plans at ~15–35s (day trips typically
  under 20s; the remainder is model generation). Without it, an un-throttled
  plan is ~1 minute; throttled, several minutes.

## Model Choice Details

Claude Haiku 4.5 via OpenRouter is the default. Two findings drove this:
(1) Gemini 2.5 Flash intermittently ended a turn *after* gathering all tool data
but *before* writing the itinerary (empty completion) in roughly half of test
runs — unacceptable for the core deliverable; (2) latency is dominated by model
generation throughput across the agent's ~5–6 sequential turns, and Haiku
measured ~2× Sonnet's throughput (~79 vs ~39 tok/s via OpenRouter) while
remaining reliable in tool loops, at ~3× lower cost. `MODEL=anthropic/claude-sonnet-4.6`
is available for higher reasoning quality and `MODEL=google/gemini-2.5-flash`
for lowest cost; all route through the single `OPENROUTER_API_KEY`.
`thinkingLevel` is `off` — the task does not need extended reasoning and it
slowed every turn.

## Knooppunten Honesty

We deliberately present junctions as a proximity list ("knooppunten in the
area"), not an ordered route. Junction-to-junction sequencing would require
building a graph of the `rcn` network and routing over it — the principled next
step. We chose honest framing over a fabricated sequence so the grounding
invariant holds end-to-end; turn-by-turn navigation comes from `plan_route`, and
the rider matches the listed junction numbers against on-the-ground signage.

## Code Structure

- `backend/src/agent.ts` — session factory (model selection, auth, compaction/retry settings)
- `backend/src/system-prompt.ts` — domain prompt, built per session (date injection); fast-mode instruction
- `backend/src/tools/` — 7 tools declared with `defineTool()` (schema-derived param types); shared result envelope in `utils/tool-result.ts`
- `backend/src/utils/overpass.ts` — encapsulated Overpass client (cache, serialized queue, backoff) behind a single `queryOverpass()`
- `backend/src/server.ts` — Express + WebSocket transport: streaming, narration strip, heartbeat, per-connection busy guard
- `backend/src/smoke.ts`, `backend/eval/run-eval.ts` — headless harnesses over the same typed `AgentSessionEvent` stream; `backend/eval/judge.ts` — LLM-as-judge scoring (separate judge model, calibrated rubric)
- `backend/test/unit.test.ts` — offline unit tests (geo/format helpers, bearing correctness, prompt invariants, tool registry, eval-case schema); run by CI on every push
- `frontend/` — vanilla JS; streaming render and voice input encapsulated in small classes (`StreamingMessage`, `VoiceInput`)
