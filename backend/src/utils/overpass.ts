// Public Overpass instances are slow (~2-10s/query) and aggressively
// rate-limited per IP: under burst load overpass-api.de returns 406/429/504 and
// then blocks the IP for a few minutes. The agent issues many POI/knooppunten
// lookups per plan, so we:
//   1. cache results by query (OSM POI data is effectively static for a session,
//      so identical/repeat lookups never re-hit the API — the biggest load cut
//      and what makes demos reproducible),
//   2. serialize all traffic through one queue with a minimum gap,
//   3. retry transient failures with exponential backoff.
// The principled production fix is a self-hosted Overpass with a Dutch extract
// (see DECISIONS.md scaling) — this keeps the prototype usable on the free tier.

// Set OVERPASS_URL (e.g. a self-hosted instance with a Dutch extract) to remove
// the public rate limit entirely — this is the production-grade fix and makes a
// full plan complete in well under 30s. When set, the local instance is tried
// first with overpass-api.de kept as a fallback.
//
// overpass-api.de is the public default. We deliberately avoid public mirrors:
// every one evaluated is unusable — overpass.osm.ch hosts Switzerland-only data
// (empty for NL), and kumi.systems / private.coffee / osm.jp are unreachable and
// HANG until timeout. A dead secondary is worse than none: when the primary
// throttles, retrying into a hanging mirror added ~40s per call and was the
// dominant source of latency. We retry with bounded backoff + a short timeout
// and rely on caching.
const PUBLIC_ENDPOINT = "https://overpass-api.de/api/interpreter";
const ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL, PUBLIC_ENDPOINT]
  : [PUBLIC_ENDPOINT];

const MIN_GAP_MS = 700; // spacing between consecutive Overpass requests
// Bounded backoff: when Overpass is throttling (429), a call fails within
// ~7s (1+2+4) rather than stalling ~30s. Because calls are serialized, long
// per-call backoff stacks across a plan's many lookups and makes the whole
// itinerary crawl — better to fail fast and let the agent degrade gracefully
// (it states "data unavailable" rather than inventing).
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

// Bounded FIFO cache: OSM data is effectively static for a session, but a
// long-running server must not grow without limit. FIFO (Map insertion order)
// is enough — queries don't repeat across trips often enough for LRU to matter.
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, OverpassElement[]>();

// Serialize every request: chain promises so only one Overpass call is in flight
// at a time, each spaced MIN_GAP_MS apart.
let queue: Promise<unknown> = Promise.resolve();
let lastRequestTime = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(query: string): Promise<OverpassElement[]> {
  let lastError = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];

    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed);
    lastRequestTime = Date.now();

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "VeloGuide/1.0 (cycling trip planner)",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(12_000),
      });

      // Any non-OK status (406/429/502/504/...) is a transient rate-limit /
      // overload signal — back off (longer each time) and retry, alternating
      // endpoints so a blocked primary falls through to the secondary.
      if (!res.ok) {
        lastError = `Overpass ${res.status}`;
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        continue;
      }

      const data = await res.json();
      return data.elements ?? [];
    } catch (err: any) {
      // Network error / timeout — also transient.
      lastError = err?.message ?? String(err);
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }

  throw new Error(`Overpass unavailable after ${MAX_RETRIES} attempts: ${lastError}`);
}

export async function queryOverpass(query: string): Promise<OverpassElement[]> {
  const cached = cache.get(query);
  if (cached) return cached;

  const result = queue.then(() => fetchOverpass(query));
  // Keep the chain alive regardless of this call's outcome.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  const elements = await result;
  cache.set(query, elements);
  if (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
  return elements;
}

export function buildBbox(lat: number, lon: number, radiusM: number): string {
  const latDelta = radiusM / 111320;
  const lonDelta = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return `${lat - latDelta},${lon - lonDelta},${lat + latDelta},${lon + lonDelta}`;
}
