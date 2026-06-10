# Decisions, Assumptions, Limitations & Scaling

## How It Works (Core Architecture)

VeloGuide is a single **pi-agent** session running a ReAct-style agentic loop. The
SDK (`createAgentSession`) supplies the loop, tool-call schema validation,
streaming, image handling, context compaction, and retries. We supply only two
things — the **tools** and the **system prompt** — which keeps the system small
and debuggable.

One turn flows like this:

1. The model receives the system prompt, the user's text (and any image), and the
   TypeBox schemas of the 7 custom tools (built-in coding tools are disabled via
   `noTools: "builtin"`).
2. It emits tool calls as structured JSON; pi-agent validates them against the
   schemas before our `execute` runs.
3. Each tool hits a real data source (OpenRouteService or OSRM / OSM Overpass /
   Open-Meteo / Nominatim) and returns text into the conversation.
4. The model reads the results and either calls more tools or writes the final
   itinerary. The loop repeats until it stops calling tools.

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
Distances and cycling times come only from `plan_route`; POIs and accommodation
only from Overpass; weather only from Open-Meteo; knooppunten only from
`find_knooppunten`. The model's job is reduced to orchestration and prose — the
two things LLMs are reliable at — while every number and place name is delegated
to a deterministic source. This is the core anti-hallucination strategy.

## Architecture Decisions

**Single agent with tool-grounded factuality.** One pi-agent session with 7 domain-specific tools. All quantitative data (distances, times, elevation, weather, POI names) comes exclusively from external API tool calls — the LLM is never allowed to estimate or invent these. This is the primary mitigation for hallucination and the core architectural principle.

**Tool selection.** OpenRouteService for cycling routing (cycling-network-aware profile with elevation; meets the "use Dutch cycling-infrastructure data" goal) with the keyless OSRM bike demo as automatic fallback, OSM Overpass for POIs/accommodation/knooppunten (comprehensive Dutch coverage), Open-Meteo for weather (free, no key), Nominatim for geocoding. All free-tier, all production-grade data sources.

**Data-source hosting (the key latency decision).** POI and knooppunten lookups go through OSM Overpass, and the *public* Overpass endpoint is the single largest latency factor: it is rate-limited per IP and slow under the burst of lookups one plan needs. The recommended setup is therefore a **self-hosted Overpass with a Dutch OSM extract**, run locally via Docker and pointed to with `OVERPASS_URL` in `.env` (one-time ~1.3 GB import; exact command in the README "Fast local Overpass" section). This removes the rate limit and the latency variance entirely and brings a full plan well under 30s. The app uses the local instance first and falls back to the public endpoint automatically, so it still runs with zero setup — just slower. Treat the local Overpass as part of the standard setup, not an optional extra: it is the difference between a sluggish demo and an instant one.

**Model choice.** Claude Haiku 4.5 via OpenRouter is the default. Two findings drove this: (1) Gemini 2.5 Flash intermittently ended a turn *after* gathering all tool data but *before* writing the itinerary (empty completion / premature stop) in roughly half of test runs — unacceptable for the core deliverable; (2) latency is dominated by model generation throughput across the agent's sequential turns, and Haiku measured ~2× Sonnet's throughput (~79 vs ~39 tok/s via OpenRouter) while remaining reliable in tool loops, at ~3× lower cost. So Haiku is the default; `MODEL=anthropic/claude-sonnet-4.6` is available for higher reasoning quality and `MODEL=google/gemini-2.5-flash` for lowest cost. All route through the single `OPENROUTER_API_KEY`, so switching models needs no new credentials. `thinkingLevel` is set to `off` — the task does not need extended reasoning and it slowed every turn.

**Single agent vs. multi-agent.** A single agent with clear tool boundaries is simpler to debug, evaluate, and explain. Multi-agent coordination (route planner → POI finder → itinerary compiler) adds latency and failure modes without clear benefit at this scale.

**Web chat UI.** Minimal Express + WebSocket + vanilla HTML/JS. No React/framework overhead. Image upload for multimodal input. Markdown rendering for structured output. Tool activity indicators for transparency. A **Fast mode** toggle (⚡) lets the user trade detail for speed per message — it injects an instruction that tells the model to batch all tool calls into as few turns as possible and write a compact, scannable plan, cutting wall-clock latency.

## Assumptions

- Users are planning recreational cycling trips, not competitive/racing routes
- Typical daily distance: 40–70 km casual, 80–120 km experienced
- The Dutch knooppunten network is the primary navigation system cyclists use
- OSM data quality for the Netherlands is high (it is — NL has exceptional OSM coverage)
- Weather forecasts beyond 16 days are unreliable; the agent communicates this limitation
- **Accommodation booking, pricing, and availability are out of scope** (per the brief). We still surface OSM-listed places to stay, but only as overnight *anchors* a multi-day route needs — the rider books on their own
- **Conversation is multi-turn.** Trip planning is iterative ("make day 2 shorter", "swap the museum for something outdoors"), so each browser connection holds a persistent pi-agent session and the user can refine a plan across turns. Compaction keeps the growing transcript within context.
- **Image input is a secondary modality.** The task names images as "possibly" present, so we support one clear use case — interpreting a photo of a place/landscape to infer region or vibe preferences — rather than over-investing. The multimodal path is wired end-to-end (`session.prompt(text, { images })`), but text is the primary interface.

## LLM-Specific Issue Handling

| Issue | Mitigation |
|-------|------------|
| Premature stop / empty completion | The model occasionally ends a turn after gathering tool data but before writing the plan. Primary mitigation: a model measured reliable in tool loops (Haiku 4.5 default; Sonnet 4.6 as the quality upgrade — Gemini Flash was rejected for exactly this failure). Backstop: a guard that detects a turn producing no itinerary text and re-prompts once to synthesize from the data already in context |
| Hallucinated distances/times | `plan_route` tool provides computed values; system prompt forbids estimation |
| Invented restaurants/places | All POI names come from OSM; system prompt says "ONLY mention tool-returned places" |
| Weather for far-future dates | `get_weather` tool validates date range, returns clear error message |
| Impossible routes | OSRM errors surfaced with explanation (water crossing, no bike route, etc.) |
| Over-ambitious daily distances | System prompt includes fitness-level guidelines; agent flags unreasonable plans |
| Fabricated knooppunten sequences | `find_knooppunten` returns a *proximity list* (with an explicit `note`), and the prompt forbids presenting junctions as an ordered "12 → 45 → 63" route — the one place the grounding invariant could leak is closed by framing junctions as "in the area" |
| Stale sense of "today" | LLMs resolve "tomorrow" against their training cutoff. The current date (Europe/Amsterdam) is injected into the system prompt at session creation, so relative dates and `get_weather` calls resolve correctly |
| Guessed compass directions | The model invents bearings ("ride northeast to Kinderdijk" — it's southeast). `plan_route` now returns a computed per-leg cardinal bearing; the prompt forbids stating directions not present in tool output |
| Unbalanced multi-day plans | A 13 km "day" between two 40 km days reads as a planning failure. Hard prompt rule: days must be roughly comparable (no day < half the longest, full days ≥ ~30 km) unless the user asks for a rest day |
| Stale/missing data | Disclaimer that OSM data may be incomplete; suggest verifying opening hours |

## Limitations

- **Accommodation quality**: OSM has listings but not availability, pricing, or reviews
- **Real-time conditions**: No live traffic, road closures, or construction data
- **Knooppunten routing**: We deliberately present junctions as a proximity list ("knooppunten in the area"), not an ordered route. Junction-to-junction sequencing would require building a graph of the `rcn` network and routing over it — the principled next step. We chose honest framing over a fabricated sequence so the grounding invariant holds end-to-end; turn-by-turn navigation comes from `plan_route`, and the rider matches the listed junction numbers against on-the-ground signage.
- **External API reliability**: The free public OSM Overpass instances are slow and rate-limit per IP (HTTP 406/429/504, then a multi-minute block) under the burst of lookups a single plan generates. Mitigated in the prototype with (a) an in-memory query **cache** so repeat/identical lookups never re-hit the API, (b) a **serialized request queue** with spacing, (c) **retry with exponential backoff**, and (d) prompt guidance to **batch POI categories** into single calls. Under heavy use the principled fix is a self-hosted Overpass with a Dutch extract (see Scaling). When data still can't be fetched, the agent degrades gracefully — it states the limitation rather than inventing POIs, preserving the grounding invariant.
- **Latency**: Profiled end-to-end with a timestamped event trace. The model and framework are *not* the bottleneck — Claude Haiku 4.5 runs ~79 tok/s, individual calls return in 1–4s (even with a 17K-token context), and the final itinerary synthesis takes ~8–9s. **Essentially all latency is in the public OSM Overpass API calls** (POIs + knooppunten). Causes and fixes:
  - A dead secondary mirror (`kumi.systems`) hung for the full 40s timeout on every retry when the primary throttled — this was the single worst offender (~40–60s per affected call). **Fixed**: removed; we now use only `overpass-api.de` with a 12s timeout and bounded backoff.
  - The keyless DuckDuckGo `web_search` had no timeout and returned nothing, so the model retried it. **Fixed**: 6s-bounded, single-shot, discouraged in the prompt.
  - Public Overpass rate-limits per IP (HTTP 429) under burst; throttled calls then take ~10–30s. Mitigated by an in-memory query **cache** (repeat lookups are instant) and a serialized queue. A plan issues several Overpass calls, so under throttling this still stacks to ~60–100s; un-throttled it is ~30–50s.
  - The decisive production fix is a **self-hosted Overpass with a Dutch extract** (see Scaling) — eliminates the rate limit and the variance entirely. Note the prototype's measured numbers are inflated by heavy local load-testing having throttled the shared endpoint.
- **Web search**: DuckDuckGo Instant Answer API has limited depth; a dedicated search API (Brave, Google) would improve contextual results
- **No GPX export**: Route data exists but isn't exported as downloadable GPX files
- **Single session**: No persistent conversation history across browser sessions

## Scaling to 100x / 10,000x

### 100x users (~100 concurrent sessions)

- **Session management**: Move from in-memory to Redis-backed sessions with TTL
- **API rate limits**: Cache common routes (Amsterdam→Utrecht doesn't change daily). OSRM public demo has soft rate limits; self-host for guaranteed throughput
- **LLM costs**: Claude Haiku 4.5 (~$5/M output tokens, ~3× cheaper than Sonnet) handles 100x well; per-plan cost is cents. Add request queuing to smooth bursts
- **Deployment**: Single containerized backend behind a load balancer. WebSocket sticky sessions via IP hash

### 10,000x users (~10,000 concurrent sessions)

- **Architecture shift**: Stateless API servers + message queue (Redis Streams / SQS) + worker pool for LLM calls
- **Caching layer**: Pre-compute and cache popular route corridors, knooppunten graphs, POI clusters. CDN for static frontend
- **Self-hosted routing**: Deploy OSRM with Dutch OSM extracts — eliminates external API limits entirely
- **LLM optimization**: Prompt caching for the system prompt (identical across all users). Shorter tool descriptions. Consider fine-tuned smaller model for common queries
- **Observability**: Structured logging, LLM call tracing, tool latency dashboards, error rate alerting
- **Multi-region**: Deploy in EU regions close to users. Database for session persistence, user preferences, saved trips
- **Cost model**: At 10,000x, LLM inference dominates cost. Implement tiered responses: quick answers from cache, full tool-calling only for novel requests
