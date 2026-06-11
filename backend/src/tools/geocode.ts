import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { textResult, jsonResult } from "../utils/tool-result.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Nominatim usage policy: max 1 request/second per client.
let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - elapsed));
  }
  lastRequestTime = Date.now();
  return fetch(url, {
    headers: { "User-Agent": "VeloGuide/1.0 (cycling trip planner)" },
  });
}

export const geocodeTool = defineTool({
  name: "geocode",
  label: "Geocode Location",
  description:
    "Convert a place name to geographic coordinates (latitude/longitude). Use this to resolve user-mentioned locations before routing or searching for nearby POIs. Restricted to the Netherlands.",
  parameters: Type.Object({
    query: Type.String({ description: "Place name to geocode, e.g. 'Amsterdam', 'Kinderdijk', 'Hoge Veluwe'" }),
  }),
  execute: async (_toolCallId, params) => {
    const url = `${NOMINATIM_URL}?format=json&countrycodes=NL&limit=3&q=${encodeURIComponent(params.query)}`;
    const res = await rateLimitedFetch(url);

    if (!res.ok) {
      return textResult(`Geocoding error: ${res.status} ${res.statusText}`);
    }

    const results = await res.json();

    if (!results.length) {
      return textResult(`No results found for "${params.query}" in the Netherlands.`);
    }

    const formatted = results.map((r: any) => ({
      name: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: r.type,
    }));

    return jsonResult(formatted);
  },
});
