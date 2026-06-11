# VeloGuide — AI Cycling Trip Planner for the Netherlands

[![CI](https://github.com/dfadeeff/velo_guide/actions/workflows/ci.yml/badge.svg)](https://github.com/dfadeeff/velo_guide/actions/workflows/ci.yml)

AI-powered system for planning 1–3 day cycling trips in the Netherlands, built on the [pi-agent](https://github.com/earendil-works/pi) framework.

**Input:** text, images (photo of a place you'd like to visit), and voice (browser speech-to-text, Chrome/Edge/Safari). **Output:** a grounded, multi-day itinerary; refine it across turns ("make day 2 shorter").

**Docs:** [DECISIONS.md](DECISIONS.md) (one-page decisions/assumptions/limitations/scaling) · [ARCHITECTURE.md](ARCHITECTURE.md) (deep-dive) · [EVALUATION.md](EVALUATION.md) (quality evaluation plan)

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **OpenRouter API key** — set in `.env` (one key routes to Claude/Gemini/GPT)
- **OpenRouteService API key** *(optional)* — set `ORS_API_KEY` in `.env` for cycling-network routing with elevation; without it, routing falls back to the keyless OSRM demo

## Quick Start

```bash
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY

make setup
make run
```

Open http://localhost:3000 in your browser.

> **⚠️ Strongly recommended for usable latency:** set up a **[local Overpass](#fast-local-overpass-recommended)** (see below) before serious use. Without it, POI/junction lookups hit the rate-limited public OSM endpoint and a full plan takes ~1 minute when un-throttled, several minutes when rate-limited; with it, ~15–35s (day trips typically under 20s). The app falls back to the public endpoint automatically if it's not configured.

> **Tip:** **⚡ Fast** mode (next to the input) is **on by default** — the model batches its tool calls and writes a compact, scannable plan. Uncheck it for a fuller, more detailed multi-day itinerary.

### Fast local Overpass (recommended)

POI and junction lookups use the public OSM Overpass API, which is rate-limited and slow under load. Running a local Overpass with just the Netherlands extract removes the limit and brings a full plan to ~15–35s (measured: day trips 15–20s, 3-day trips up to ~35s).

One-time setup (needs Docker). Budget **~30–60 min** total, mostly hands-off: ~1.3 GB download, then a PBF→OSM-XML conversion (single-threaded bzip2, the slow part), then the database import. It runs in the background in a persistent Docker volume, so you only do it once.

```bash
docker run -d --name overpass_nl \
  -e OVERPASS_META=yes \
  -e OVERPASS_MODE=init \
  -e OVERPASS_PLANET_URL=https://download.geofabrik.de/europe/netherlands-latest.osm.pbf \
  -e OVERPASS_PLANET_PREPROCESS='mv /db/planet.osm.bz2 /db/planet.osm.pbf && osmium cat -o /db/planet.osm.bz2 /db/planet.osm.pbf && rm /db/planet.osm.pbf' \
  -e OVERPASS_RULES_LOAD=10 \
  -v overpass_db_nl:/db \
  -p 12345:80 \
  wiktorn/overpass-api
```

Wait for the import to finish (`docker logs -f overpass_nl`), then add to `.env`:

```
OVERPASS_URL=http://localhost:12345/api/interpreter
```

The app uses the local instance first and falls back to the public endpoint automatically if it's unset or unreachable. (Geofabrik serves the NL extract as `.osm.pbf`; the `PREPROCESS` step converts it to the OSM-XML the Overpass importer expects.)

**Two gotchas with this image** (already accounted for above, but in case you hit them):
- The container runs the import in `init` mode and then **exits**. Once the import is done, `docker start overpass_nl` to serve it.
- If queries return `runtime error: open64: 13 Permission denied /db/db/osm3s_osm_base`, the DB directory is `0700` and the query process (a different user) can't reach the dispatcher socket. Fix once:
  ```bash
  docker exec -u root overpass_nl chmod 755 /db /db/db && docker restart overpass_nl
  ```

Verify it's serving real data:
```bash
curl -s -X POST http://localhost:12345/api/interpreter \
  --data-urlencode 'data=[out:json];node["amenity"="cafe"](52.36,4.88,52.40,4.93);out 3;'
```

## Architecture

Single pi-agent with 7 custom tools, fronted by a deterministic **intake gate**, + web chat UI.

```
Browser (chat) ←WebSocket→ Express server → intake gate ─(start/days/date settled)→ pi-agent session
                                               │                                         ↓
                                  (anything missing/conflicting)                      7 tools
                                               │                                         ↓
                                     one targeted question        OpenRouteService / OSRM / OSM Overpass / Open-Meteo / Nominatim
```

Before any planning, the gate (a tool-free extraction — it cannot route or plan) settles three parameters: **start location** (text or photo), **trip length (days)**, and **start date** (for a real forecast). A missing start or length → one targeted question, and the planning agent is never invoked. A missing date is never asked — tomorrow is assumed and stated at the top of the plan; only *conflicting* dates ("today" vs "from June 20") trigger the question. The gate asks at most once: decline to specify and it plans with stated defaults (1 day, from Amsterdam, starting tomorrow), disclosing the assumption. Refinement turns ("make day 2 shorter") skip the gate.

### Tools

| Tool | API | Purpose |
|------|-----|---------|
| `geocode` | Nominatim | Place names → coordinates |
| `plan_route` | OpenRouteService → OSRM | Cycling-network routes with real distances, elevation, turn-by-turn (ORS when `ORS_API_KEY` set, else OSRM fallback) |
| `get_weather` | Open-Meteo | Daily weather forecast |
| `find_pois` | OSM Overpass | Cafes, restaurants, museums, windmills |
| `find_accommodation` | OSM Overpass | Hotels, B&Bs, campsites |
| `find_knooppunten` | OSM Overpass | Dutch cycling junction network |
| `web_search` | DuckDuckGo | Local tips, events, seasonal info |

### Stack

- **LLM**: Claude Haiku 4.5 via OpenRouter (default; ~2× Sonnet's throughput, reliable tool-calling — see DECISIONS.md). Set `MODEL=anthropic/claude-sonnet-4.6` for higher reasoning quality, or `MODEL=google/gemini-2.5-flash` for the lowest cost.
- **Agent**: pi-agent SDK (`@earendil-works/pi-coding-agent`)
- **Backend**: TypeScript, Express, WebSocket
- **Frontend**: Vanilla HTML/CSS/JS, marked.js for markdown

## Project Structure

```
velo_guide/
├── Makefile
├── .env.example
├── DECISIONS.md                 # 1-page: decisions, assumptions, limitations, scaling
├── ARCHITECTURE.md              # Deep-dive: agent loop, latency engineering, LLM-issue table
├── EVALUATION.md                # Quality evaluation plan (make eval runs the automated half)
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── eval/                    # Test cases + runnable eval harness (make eval)
│   ├── test/                    # Offline unit tests (make test, CI)
│   └── src/
│       ├── main.ts              # Entry point
│       ├── server.ts            # Express + WebSocket
│       ├── agent.ts             # Pi-agent session factory
│       ├── system-prompt.ts     # Dutch cycling domain prompt
│       ├── tools/               # 7 custom tools
│       └── utils/               # Overpass query builder, formatters
└── frontend/
    ├── index.html               # Chat interface
    ├── style.css
    └── app.js                   # WebSocket client
```

## Development

```bash
make lint    # Type-check
make test    # Offline unit tests (no network, no API key)
make run     # Start dev server
make smoke   # One real headless agent turn with tool/latency trace + grounding checks
make eval    # Run the eval suite (backend/eval/test-cases.json) with a pass/fail scorecard
make feedback-report  # Satisfaction rate + downvotes → candidate regression cases (needs FEEDBACK_DB)
```

**Optional feedback loop** (off by default): set `FEEDBACK_DB=./feedback.db` in
`.env` to show a 👍/👎 under each plan and capture it — with the tool trace that
produced it — to a local SQLite file (Node's built-in `node:sqlite`, no extra
dependency). `make feedback-report` turns downvotes into candidate regression
cases for the eval suite. It's an evaluation hook, not session persistence — no
auth, no PII, just an anonymous client id. See [EVALUATION.md](EVALUATION.md).

Add `JUDGE=1` to `make eval` for the LLM-as-judge pass: a second model (Sonnet by
default) verdicts the judgment-call assertions, scores quality dimensions 1–5, and
flags soft hallucinations against the captured tool outputs. See EVALUATION.md.

**CI** (GitHub Actions): every push runs the type-check, unit tests, and a frontend
syntax check. The live agent eval (`make eval`, real LLM + geo API calls) is a
manually dispatched job — it spends API credits and depends on rate-limited public
endpoints, so it's run from the Actions tab (with the `OPENROUTER_API_KEY` repo
secret) before releases or after prompt/model changes.

`make smoke` accepts a custom prompt, an optional follow-up turn (multi-turn
refinement check), and an optional image (multimodal check):

```bash
cd backend && npx tsx src/smoke.ts "Plan a 2-day trip from Utrecht" "make day 2 shorter"
cd backend && IMAGE=eval/fixtures/dutch-windmill.jpg npx tsx src/smoke.ts "I want to cycle somewhere that looks like this"
```
