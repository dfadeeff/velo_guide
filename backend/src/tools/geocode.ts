import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

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

export const geocodeTool: ToolDefinition = {
  name: "geocode",
  label: "Geocode Location",
  description:
    "Convert a place name to geographic coordinates (latitude/longitude). Use this to resolve user-mentioned locations before routing or searching for nearby POIs. Restricted to the Netherlands.",
  parameters: Type.Object({
    query: Type.String({ description: "Place name to geocode, e.g. 'Amsterdam', 'Kinderdijk', 'Hoge Veluwe'" }),
  }),
  execute: async (_toolCallId, params: any) => {
    const url = `${NOMINATIM_URL}?format=json&countrycodes=NL&limit=3&q=${encodeURIComponent(params.query)}`;
    const res = await rateLimitedFetch(url);

    if (!res.ok) {
      return {
        content: [{ type: "text" as const, text: `Geocoding error: ${res.status} ${res.statusText}` }],
        details: {},
      };
    }

    const results = await res.json();

    if (!results.length) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${params.query}" in the Netherlands.` }],
        details: {},
      };
    }

    const formatted = results.map((r: any) => ({
      name: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: r.type,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }],
      details: {},
    };
  },
};
