# VeloGuide — AI Cycling Trip Planner for the Netherlands

AI-powered system for planning 1–3 day cycling trips in the Netherlands, built on the [pi-agent](https://github.com/earendil-works/pi) framework.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **OpenRouter API key** — set in `.env`

## Quick Start

```bash
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY

make setup
make run
```

Open http://localhost:3000 in your browser.

## Architecture

Single pi-agent with 7 custom tools + web chat UI.

```
Browser (chat) ←WebSocket→ Express server ←SDK→ pi-agent session
                                                     ↓
                                               7 tools
                                                     ↓
                           OSRM / OSM Overpass / Open-Meteo / Nominatim
```

### Tools

| Tool | API | Purpose |
|------|-----|---------|
| `geocode` | Nominatim | Place names → coordinates |
| `plan_route` | OSRM | Cycling routes with real distances and turn-by-turn |
| `get_weather` | Open-Meteo | Daily weather forecast |
| `find_pois` | OSM Overpass | Cafes, restaurants, museums, windmills |
| `find_accommodation` | OSM Overpass | Hotels, B&Bs, campsites |
| `find_knooppunten` | OSM Overpass | Dutch cycling junction network |
| `web_search` | DuckDuckGo | Local tips, events, seasonal info |

### Stack

- **LLM**: Gemini 2.5 Flash via OpenRouter (vision-capable, tool-calling)
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
