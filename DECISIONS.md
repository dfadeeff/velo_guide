# Decisions, Assumptions, Limitations & Scaling

*One page, per the brief. Engineering deep-dive (agent loop, latency profiling, full LLM-issue table): [ARCHITECTURE.md](ARCHITECTURE.md). Test plan: [EVALUATION.md](EVALUATION.md).*

## Decisions

- **Single pi-agent session + 7 domain tools.** The SDK supplies the agentic loop, schema validation, streaming, compaction, retries; we supply only tools and prompt. A multi-agent split (router → POI finder → compiler) adds latency and failure modes with no benefit at this scale.
- **Deterministic intake gate before planning.** A tool-free extraction step (no tools attached — it structurally cannot plan) settles three parameters on every new trip request: start location (text or photo), trip length, start date — parsed through a typed, runtime-validated data model (TypeBox schema: malformed LLM output normalizes to "missing", never to a guess). Missing start/length or conflicting dates → one targeted question, and the planning agent is never invoked, so no plan is ever built on guessed parameters. A merely absent date is never asked: tomorrow is assumed and disclosed at the top of the plan. Asked once and refused → stated defaults (1 day, Amsterdam, tomorrow), likewise disclosed. Refinement turns bypass the gate.
- **Tool-grounded factuality — the core invariant.** The LLM never produces a falsifiable fact: distances/times/bearings only from `plan_route` (OpenRouteService cycling network; keyless OSRM fallback), POIs/stays/knooppunten only from OSM Overpass, weather only from Open-Meteo, geocoding NL-scoped Nominatim. Junctions are framed as a proximity list, never a fabricated "12 → 45 → 63" sequence. A runnable eval (`make eval`) verifies this end-to-end; CI runs the type-check and offline unit tests on every push.
- **Self-hosted Overpass for latency.** The public Overpass endpoint (rate-limited per IP) dominates latency. A local Docker instance with the Dutch extract brings a full plan to ~15–35s; without it the app still works, just slower (~1 min un-throttled).
- **Model: Claude Haiku 4.5 via OpenRouter.** ~2× Sonnet's measured throughput at ~3× lower cost, reliable in tool loops; Gemini Flash was rejected (intermittent empty completions). One env var switches models on the same key.
- **Interface: minimal web chat** (Express + WebSocket + vanilla JS): streaming, tool-activity chips, Fast mode (default), image upload, and voice input (browser Web Speech API → text; an extra beyond the brief — the backend stays text+image, so all grounding rules apply to every modality).
- **Off-by-default feedback capture, not session persistence.** A 👍/👎 on each plan, stored with the trace that produced it (`node:sqlite`, no dependency, enabled only via `FEEDBACK_DB`), exists to make evaluation *self-feeding*: `make feedback-report` turns downvotes into candidate regression cases. Conscious scope line — this is an evaluation hook, NOT conversation persistence or user identity (those stay in the scaling tier below); it carries only an anonymous client id, no auth/PII. See EVALUATION.md "Production feedback loop".

## Assumptions

- Recreational trips, not racing; ~40–70 km/day casual, 80–120 km experienced; traveler profile and fitness drive daily distances.
- **Multi-turn conversation**: each connection holds a persistent session; refinements adjust the existing plan rather than re-planning.
- **Accommodation booking/pricing/availability is out of scope** (per the brief); OSM-listed places to stay are surfaced only as overnight anchors for multi-day routing.
- Images are a secondary modality (one use case: infer region/preferences from a photo); Dutch OSM coverage is excellent — the grounding strategy depends on it.

## LLM-Specific Issues Handled

Hallucinated numbers → tool-computed only, eval-checked · Invented places → OSM names only, eval-checked · Fabricated junction routes → proximity framing + eval regex · Stale sense of "today" → current date injected per session · Guessed compass directions → computed per-leg bearings · Premature stop/empty turn → re-prompt guard · Unbalanced days → hard balance rule · Planning on missing/ambiguous parameters (days, start, date) → deterministic intake gate, ask-once, stated defaults on refusal · Post-gate clarification loops → answer-first defaults + pipeline guard (zero-tool question replies re-prompted once) · Far-future weather → 16-day clamp, plan anyway, limitation stated · Impossible routes/API failures → graceful degradation, never invented data.

## Limitations

- Knooppunten are listed near the route, not sequence-routed (requires building the `rcn` graph — the principled next step).
- Public free-tier APIs throttle under burst; mitigated by cache + serialized queue + bounded backoff, removed entirely by the local Overpass.
- Soft hallucinations (ungrounded prices, counts, frequencies) slip past programmatic checks — caught by the LLM-as-judge layer (`JUDGE=1 make eval`), which also scores quality dimensions 1–5; residual risk is judge miscalibration (it is an LLM too) — measurable against real 👍/👎 once the feedback sink is enabled.
- No GPX export, live closures, or cross-session persistence; web search (DuckDuckGo) is shallow — a real search API would improve seasonal context.

## Scaling

**×100 (~100 concurrent):** Redis-backed sessions with TTL; cache common route corridors; self-host OSRM + Overpass (removes all external rate limits); request queuing to smooth bursts — Haiku at ~$5/M output tokens keeps per-plan cost at cents; single containerized backend behind an LB with sticky WebSockets.

**×10,000:** Stateless API tier + message queue + LLM worker pool; precomputed popular corridors, knooppunten graph, POI clusters; CDN for the frontend; prompt caching (system prompt identical across users) and tiered responses (cache-first, full tool-calling only for novel requests); observability (LLM call tracing, tool latency dashboards, error alerting); EU multi-region with a database for sessions and saved trips. LLM inference dominates cost at this scale — cache hit rate is the main lever.
