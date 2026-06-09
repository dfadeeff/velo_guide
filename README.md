# VeloGuide — AI Cycling Trip Planner for the Netherlands

AI-powered system for planning 1–3 day cycling trips in the Netherlands, built on the [pi-agent](https://github.com/earendil-works/pi) framework.

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

> **⚠️ Strongly recommended for usable latency:** set up a **[local Overpass](#fast-local-overpass-recommended)** (see below) before serious use. Without it, POI/junction lookups hit the rate-limited public OSM endpoint and a full plan can take minutes; with it, well under 30s. The app falls back to the public endpoint automatically if it's not configured.

> **Tip:** Toggle **⚡ Fast** next to the input for quicker, more compact plans (the model batches its tool calls and writes a tighter itinerary). Leave it off for full, detailed multi-day plans.

### Fast local Overpass (recommended)

POI and junction lookups use the public OSM Overpass API, which is rate-limited and slow under load. Running a local Overpass with just the Netherlands extract removes the limit and brings a full plan well under 30s.

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

Single pi-agent with 7 custom tools + web chat UI.

```
Browser (chat) ←WebSocket→ Express server ←SDK→ pi-agent session
                                                     ↓
                                               7 tools
                                                     ↓
              OpenRouteService / OSRM / OSM Overpass / Open-Meteo / Nominatim
```

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

- **LLM**: Claude Sonnet 4.6 via OpenRouter (default; reliable tool-calling). Set `MODEL=google/gemini-2.5-flash` for a low-cost vision-capable alternative.
- **Agent**: pi-agent SDK (`@earendil-works/pi-coding-agent`)
- **Backend**: TypeScript, Express, WebSocket
- **Frontend**: Vanilla HTML/CSS/JS, marked.js for markdown

## Project Structure

```
velo_guide/
├── Makefile
├── .env.example
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── eval/                    # Test cases & evaluation
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
make run     # Start dev server
```
