# Architecture Deep-Dive

Companion to [DECISIONS.md](DECISIONS.md) (the one-page summary). This document explains how the system works and the engineering behind the headline decisions.

## How It Works (Core Architecture)

VeloGuide is a single **pi-agent** session running a ReAct-style agentic loop. The
SDK (`createAgentSession`) supplies the loop, tool-call schema validation,
streaming, image handling, context compaction, and retries. We supply only two
things — the **tools** and the **system prompt** — which keeps the system small
and debuggable.

 The conversation is multi-turn over a persistent session; each turn flows like
this:

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

**Input modalities.** Text is primary. **Images** are handled in two places: the
intake step identifies the start city from a photo using a vision model
(`VISION_MODEL`, default Gemini 2.5 Flash — see "Photo identification" below),
and the planning agent receives the image via `session.prompt(text, { images })`.
**Voice** is transcribed to text *before* the agent sees it — by default in the
browser (Web Speech API), or, when `STT_BACKEND` is set, by a server STT backend
(Deepgram, or Gemini on the same OpenRouter key): the browser records audio,
re-encodes it to WAV, and POSTs it to `/transcribe`. Either way the agent's input
is **text + image only**, so every grounding rule below applies to all modalities
unchanged.

**Photo identification.** A photo's city is a *guess*, so it is treated as one.
The intake extractor (which can use a stronger `VISION_MODEL` than the default
chat model, because small models misname Dutch canal towns and even return
foreign cities) identifies the place; the plan then **discloses it for
confirmation** ("I identified the photo as Groningen — tell me if that's wrong")
rather than committing silently, and a clearly non-Dutch photo is **redirected**
("which Dutch city?") instead of coerced into an NL location.

**Cancellation & session reset.** A long multi-turn conversation replays its
growing history each turn, so latency climbs. Two affordances address this: a
**Stop** button cancels an in-flight plan via the SDK's `session.abort()` (the
reliability guards are skipped so no extra model call fires after a cancel), and
**New trip** disposes the session and starts a fresh one — the explicit way to
separate a new trip from continuing a conversation. To keep genuine multi-turn
chats fast without a manual reset, the intake extractor re-sends only the current
turn's image and carries a photo-resolved location forward as cheap text instead
of re-processing every uploaded photo each turn.

**Why three LLM calls bypass pi-agent.** The *planner* is a full pi-agent session
(the deliverable's "pi-agent" requirement). Three auxiliary calls deliberately use
a plain OpenRouter chat request instead: the **intake extraction** (`intake.ts`),
**Gemini STT** (`stt.ts`), and the **LLM-as-judge** (`judge.ts`). The reason is
that these are single-shot, tool-free classification/transcription calls — not
agentic loops. The intake gate in particular *must not* be a planning agent: it
runs with **no tools attached so it is structurally incapable of routing or
planning**, which is the whole safety property. Spinning up a full coding-agent
session (loop, compaction, retries, tool registry) for one JSON extraction would
add latency and surface area for no benefit. They share one shape — a temperature-0
completion whose JSON is parsed defensively — and could be unified behind a single
thin client (or pi-ai's `getModel`) as a refactor; today they are three small,
independent `fetch` calls.

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
| Leaked planning monologue | The model (especially on refinement turns) opens with deliberation — "That's too long… Let me go with… Actually, given the user hasn't specified…" — or draft distance math before the plan. Mitigation: an explicit prompt rule, plus a deterministic backstop (`stripReasoningPreamble`) that removes any prose before the itinerary proper (the real `Day N: … \| XX km` header or weather note); draft `= 55 km ✓` lines have no pipe and don't survive, so only the finished plan reaches the user |
| Geographically silly routes (grounded but wrong) | Grounding guarantees every *number* comes from a tool, but the model chooses which waypoints to feed `plan_route`, so a faithful tool returns a real distance for a zigzag or an impossibly short hop. The LLM-as-judge can't catch this (the number matches the tool). `plan_route` echoes its waypoints; **geo-sanity checks** (`utils/geo-sanity.ts`, run in `make eval`) flag a day below the straight-line floor (impossible) and near-U-turn backtracks (the Purmerend→Marken→Volendam class), plus day endpoints not present in `geocode` output |
| Wrong photo-city identification | A small text model misnames Dutch canal towns and even returns foreign cities. Mitigation: image identification uses a stronger `VISION_MODEL` (default Gemini 2.5 Flash); the prompt is conservative (confident Dutch place or `null` → ask, never guess); the result is disclosed for confirmation; a non-NL photo is redirected, not coerced |
| Hallucinated distances/times | `plan_route` tool provides computed values; system prompt forbids estimation; eval checks every day-header distance against tool output (sums of consecutive legs allowed) |
| Invented restaurants/places | All POI names come from OSM; system prompt says "ONLY mention tool-returned places"; eval checks the reply uses tool-returned names |
| Stale sense of "today" | LLMs resolve "tomorrow" against their training cutoff. The current date (Europe/Amsterdam) is injected into the system prompt at session creation, so relative dates and `get_weather` calls resolve correctly |
| Guessed compass directions | The model invents bearings ("ride northeast to Kinderdijk" — it's southeast). `plan_route` returns a computed per-leg cardinal bearing; the prompt forbids stating directions not present in tool output |
| Unbalanced multi-day plans | A 13 km "day" between two 40 km days reads as a planning failure. Hard prompt rule: days must be roughly comparable (no day < half the longest, full days ≥ ~30 km) unless the user asks for a rest day |
| Planning on missing/ambiguous parameters | A **deterministic intake gate** (`intake.ts`) runs before the agent on every turn: a tool-free extraction call (it has no tools attached, so it structurally cannot plan) resolves three parameters — start location (text **or photo**), trip length, start date — and classifies the turn (new trip / refinement / out-of-scope). A new trip missing its start or length, or carrying CONFLICTING dates ("today" + "from June 20" — a real voice-input failure: browser speech-to-text garbles words), gets one templated question and `session.prompt()` is never reached. A merely absent date is not worth a question: tomorrow is assumed and the plan opens by stating it. The gate asks at most once: if the user declines, stated defaults fill the gaps (1 day / Amsterdam / tomorrow), disclosed the same way. Refinements bypass the gate |
| Clarification loops (post-gate) | With start/days/date settled upstream, everything else (destination, direction, fitness) is answer-first with explicit defaults. A **pipeline guard** backstops the prompt rules: a zero-tool reply matching the observed asking patterns ("how long", "which year", "I need to clarify") is discarded and re-prompted once — same architecture as the empty-turn guard |
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
  "Fast local Overpass"): with it, the tool calls total ~5s and a *fresh* plan is
  ~30s (measured: 1-day ~30s, 3-day ~32s) — **the remainder is model generation**
  across the agent's ~5 sequential turns, which is now the dominant cost, not the
  geo lookups. Without local Overpass, an un-throttled plan is ~1 minute;
  throttled, several minutes.
- **Multi-turn growth.** Each turn replays the whole conversation to the model, so
  a long session slows turn-over-turn — a single fresh plan is ~30s, but a 4-turn
  image-heavy session was observed at 130–170s. Mitigations: the intake extractor
  no longer re-sends old photos each turn (carrying a resolved location as text),
  and **New trip** disposes the session for a clean slate. The base ~30s per fresh
  plan is model-bound; further wins would come from provider pinning, shorter
  outputs, or fewer sequential turns.

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

## Scalability: where it breaks first

The one-page summary is in [DECISIONS.md → Scaling](DECISIONS.md#scaling); this is
the reasoning behind it. The useful question isn't "how do we scale" in the
abstract — it's *what breaks first at each tier, and what's the cheapest fix*.

**Today (prototype, ~1 user).** One Node process: in-memory pi-agent session per
WebSocket, in-memory Overpass cache + per-turn buffer, feedback in a local SQLite
file. A single point of everything — correct for a demo, deliberately not built
for more (the brief puts infrastructure out of scope).

**The two binding constraints — neither is the LLM.**
1. **Stateful WebSocket sessions.** Conversation state lives in the process, so a
   second instance can't serve a reconnecting user. This is what forces the first
   architectural change, well before model cost matters.
2. **External API rate limits.** Nominatim (1 req/s), ORS free tier, and public
   Overpass all throttle under a single plan's burst. The local Overpass already
   proves the fix; the others need the same treatment.

**×100 (~100 concurrent plans).**
- *Sessions* → move state to **Redis with TTL** so any node serves any user (or
  keep sticky-WebSocket routing and accept the smaller blast radius). This is the
  step the in-memory design is explicitly a placeholder for.
- *Geo APIs* → **self-host OSRM + Overpass** (removes the rate limits entirely),
  cache common route corridors; paid tiers or self-hosting for Nominatim.
- *LLM* → cost is **cents per plan at Haiku**, so spend isn't the issue at this
  tier — throughput is; a **request queue** smooths bursts. Feedback SQLite →
  Postgres.
- *Shape*: a containerised backend behind a load balancer with sticky WebSockets.

**×10,000.**
- *Decouple the slow part.* A 90s plan must not occupy a connection slot: a
  **stateless API tier + message queue + LLM worker pool** so planning runs
  out-of-band and the front tier stays light.
- *Cache hit rate becomes THE cost lever.* Here LLM inference dominates spend, so:
  **prompt caching** (the system prompt is identical across users), **precomputed
  popular corridors / knooppunten graph / POI clusters**, and **tiered responses**
  (serve cached or templated plans for common requests; full tool-calling only for
  novel ones).
- *Observability* — LLM-call tracing, tool-latency dashboards, rate-limit/error
  alerting. You cannot tune a cache hit rate you cannot measure.
- *Data & region* — EU multi-region, Postgres for sessions and saved trips; the
  **feedback loop becomes the continuous-eval pipeline** (downvotes → regression
  suite → prompt/model iteration), which is how quality is held while scaling.

**What does *not* change with scale.** The tool-grounding invariant is
scale-invariant: the tools get faster/cheaper backends, but "the LLM never emits a
falsifiable fact" holds identically at 1 user or 10,000. The intake gate, the
eval harness, and the geo-sanity checks are stateless and scale trivially. That
the core correctness story is independent of the scaling story is the point — we
scale the *plumbing*, not the *guarantees*.

## Code Structure

- `backend/src/agent.ts` — session factory (model selection via parameter or env, auth, compaction/retry settings)
- `backend/src/system-prompt.ts` — domain prompt, built per session (date injection); fast-mode instruction
- `backend/src/intake.ts` — intake gate: tool-free parameter extraction (start/days/date, photo-aware) parsed through a **TypeBox data model** (`IntakeExtractionSchema`: one definition yields the JSON Schema, the inferred TS type, and the runtime validator — junk normalizes to null = "ask the user", and `Value.Check` enforces the contract on every extraction); templated clarifying question; refusal defaults — pure helpers unit-tested offline
- `backend/src/pipeline.ts` — the single shared conversation pipeline (intake gate → planning agent → reliability guards, narration strip, reasoning-preamble strip) used by server, smoke, and eval, so the eval measures exactly what production runs; one long-lived instance per connection carries the multi-turn session, and exposes `abort()` for the Stop button
- `backend/src/stt.ts` — server speech-to-text dispatcher (`browser` / `gemini` via OpenRouter / `deepgram`); the agent only ever receives the resulting text
- `backend/src/feedback.ts` — off-by-default 👍/👎 capture over `node:sqlite` (no dependency; enabled via `FEEDBACK_DB`), with TypeBox-validated submissions
- `backend/src/tools/` — 7 tools declared with `defineTool()` (schema-derived param types); shared result envelope in `utils/tool-result.ts`
- `backend/src/utils/overpass.ts` — encapsulated Overpass client (bounded cache, serialized queue, backoff) behind a single `queryOverpass()`; `utils/images.ts` — validation caps for untrusted client images; `utils/geo-sanity.ts` — pure route-geometry checks (straight-line floor, zigzag/backtrack, endpoint grounding)
- `backend/src/server.ts` — Express + WebSocket transport (streaming relay, heartbeat, per-connection busy guard, Stop/cancel + New-trip reset) plus the `/transcribe`, `/feedback`, and `/config` HTTP endpoints; all conversation logic lives in the pipeline
- `backend/src/smoke.ts`, `backend/eval/run-eval.ts` — headless harnesses over the same pipeline; `backend/eval/judge.ts` — LLM-as-judge scoring (separate judge model, calibrated rubric); `backend/eval/feedback-report.ts` — turns captured downvotes into candidate regression cases
- `backend/test/unit.test.ts` — offline unit tests (geo/format helpers, bearing correctness, prompt invariants, intake gate, geo-sanity, feedback store, tool registry, eval-case schema); run by CI on every push
- `frontend/` — vanilla JS; streaming render, voice input, and server-STT recording encapsulated in small classes (`StreamingMessage`, `VoiceInput`, `ServerVoiceInput`); Stop / New-trip / feedback controls
