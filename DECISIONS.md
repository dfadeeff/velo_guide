# Decisions, Assumptions, Limitations & Scaling

## Architecture Decisions

**Single agent with tool-grounded factuality.** One pi-agent session with 7 domain-specific tools. All quantitative data (distances, times, elevation, weather, POI names) comes exclusively from external API tool calls — the LLM is never allowed to estimate or invent these. This is the primary mitigation for hallucination and the core architectural principle.

**Tool selection.** OpenRouteService for cycling-specific routing (free, no key needed), OSM Overpass for POIs/accommodation/knooppunten (comprehensive Dutch coverage), Open-Meteo for weather (free, no key), Nominatim for geocoding. All free-tier, all production-grade data sources.

**Model choice.** Gemini 2.5 Flash via OpenRouter — best cost/quality ratio for this task. Vision-capable (image input), strong tool-calling, fast inference, 1M context window. Claude Sonnet 4 is the production alternative for higher tool-calling reliability.

**Single agent vs. multi-agent.** A single agent with clear tool boundaries is simpler to debug, evaluate, and explain. Multi-agent coordination (route planner → POI finder → itinerary compiler) adds latency and failure modes without clear benefit at this scale.

**Web chat UI.** Minimal Express + WebSocket + vanilla HTML/JS. No React/framework overhead. Image upload for multimodal input. Markdown rendering for structured output. Tool activity indicators for transparency.

## Assumptions

- Users are planning recreational cycling trips, not competitive/racing routes
- Typical daily distance: 40–70 km casual, 80–120 km experienced
- The Dutch knooppunten network is the primary navigation system cyclists use
- OSM data quality for the Netherlands is high (it is — NL has exceptional OSM coverage)
- Weather forecasts beyond 16 days are unreliable; the agent communicates this limitation
- Users may provide images of maps, locations, or route signs for context

## LLM-Specific Issue Handling

| Issue | Mitigation |
|-------|------------|
| Hallucinated distances/times | `plan_route` tool provides computed values; system prompt forbids estimation |
| Invented restaurants/places | All POI names come from OSM; system prompt says "ONLY mention tool-returned places" |
| Weather for far-future dates | `get_weather` tool validates date range, returns clear error message |
| Impossible routes | OpenRouteService errors surfaced with explanation (water crossing, etc.) |
| Over-ambitious daily distances | System prompt includes fitness-level guidelines; agent flags unreasonable plans |
| Stale/missing data | Disclaimer that OSM data may be incomplete; suggest verifying opening hours |

## Limitations

- **Accommodation quality**: OSM has listings but not availability, pricing, or reviews
- **Real-time conditions**: No live traffic, road closures, or construction data
- **Knooppunten routing**: Junction numbers are found near waypoints, but optimal junction-to-junction routes aren't computed (would need a graph of the knooppunten network)
- **Web search**: DuckDuckGo Instant Answer API has limited depth; a dedicated search API (Brave, Google) would improve contextual results
- **No GPX export**: Route data exists but isn't exported as downloadable GPX files
- **Single session**: No persistent conversation history across browser sessions

## Scaling to 100x / 10,000x

### 100x users (~100 concurrent sessions)

- **Session management**: Move from in-memory to Redis-backed sessions with TTL
- **API rate limits**: Pool OpenRouteService requests (2,000/day free tier → paid tier or self-hosted ORS instance). Cache common routes (Amsterdam→Utrecht doesn't change daily)
- **LLM costs**: Gemini Flash at ~$2.80/M output tokens handles 100x well. Add request queuing to smooth bursts
- **Deployment**: Single containerized backend behind a load balancer. WebSocket sticky sessions via IP hash

### 10,000x users (~10,000 concurrent sessions)

- **Architecture shift**: Stateless API servers + message queue (Redis Streams / SQS) + worker pool for LLM calls
- **Caching layer**: Pre-compute and cache popular route corridors, knooppunten graphs, POI clusters. CDN for static frontend
- **Self-hosted routing**: Deploy OpenRouteService with Dutch OSM extracts — eliminates external API limits entirely
- **LLM optimization**: Prompt caching for the system prompt (identical across all users). Shorter tool descriptions. Consider fine-tuned smaller model for common queries
- **Observability**: Structured logging, LLM call tracing, tool latency dashboards, error rate alerting
- **Multi-region**: Deploy in EU regions close to users. Database for session persistence, user preferences, saved trips
- **Cost model**: At 10,000x, LLM inference dominates cost. Implement tiered responses: quick answers from cache, full tool-calling only for novel requests
