import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { queryOverpass, buildBbox } from "../utils/overpass.js";
import { haversineDistance } from "../utils/format.js";

export const findKnooppuntenTool: ToolDefinition = {
  name: "find_knooppunten",
  label: "Find Cycling Junctions (Knooppunten)",
  description:
    "Find Dutch fietsknooppunten (cycling junction network nodes) near a location. The knooppunten system is a network of numbered junctions connected by signed cycling routes — the standard way to navigate by bike in the Netherlands. Returns the junction numbers that EXIST NEAR the given point, sorted by distance. IMPORTANT: this is a proximity list, NOT a routed sequence — it does not tell you which junctions connect to which, nor in what order to ride them. Do not present these numbers as a turn-by-turn route (e.g. '12 → 45 → 63').",
  parameters: Type.Object({
    lat: Type.Number({ description: "Latitude of search center" }),
    lon: Type.Number({ description: "Longitude of search center" }),
    radius_m: Type.Optional(
      Type.Number({
        description: "Search radius in meters (optional, default 10000)",
        default: 10000,
      }),
    ),
  }),
  execute: async (_toolCallId, params: any) => {
    const radius = params.radius_m || 10000;
    const bbox = buildBbox(params.lat, params.lon, radius);

    const query = `[out:json][timeout:15];node["rcn_ref"](${bbox});out 100;`;

    try {
      const elements = await queryOverpass(query);

      // Compact output: junction number + distance is enough to list "knooppunten
      // in the area". Coordinates are dropped to keep the context small (verbose
      // tool results slow the model's final generation sharply).
      const junctions = elements
        .filter((el) => el.lat && el.tags?.rcn_ref)
        .map((el) => ({
          junction_number: el.tags!.rcn_ref,
          distance_m: Math.round(haversineDistance(params.lat, params.lon, el.lat!, el.lon!)),
        }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 15);

      if (!junctions.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No knooppunten found within ${radius}m of (${params.lat}, ${params.lon}). The knooppunten network may not cover this area, or try a larger radius.`,
            },
          ],
          details: {},
        };
      }

      const result = {
        note: "These are knooppunten NEAR the given point, sorted by distance. This is a proximity list, not a connected route — adjacency between junctions is unknown. Mention these as 'knooppunten in the area' or 'near this segment'; do NOT invent an ordered sequence.",
        count: junctions.length,
        junctions,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: {},
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Overpass API error: ${err.message}` }],
        details: {},
      };
    }
  },
};
