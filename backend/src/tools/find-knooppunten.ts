import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { queryOverpass, buildBbox } from "../utils/overpass.js";
import { haversineDistance } from "../utils/format.js";

export const findKnooppuntenTool: ToolDefinition = {
  name: "find_knooppunten",
  label: "Find Cycling Junctions (Knooppunten)",
  description:
    "Find Dutch fietsknooppunten (cycling junction network nodes) near a location. The knooppunten system is a network of numbered junctions connected by signed cycling routes — the standard way to navigate by bike in the Netherlands. Returns junction numbers and coordinates.",
  parameters: Type.Object({
    lat: Type.Number({ description: "Latitude of search center" }),
    lon: Type.Number({ description: "Longitude of search center" }),
    radius_m: Type.Number({
      description: "Search radius in meters (default 10000)",
      default: 10000,
    }),
  }),
  execute: async (_toolCallId, params: any) => {
    const radius = params.radius_m || 10000;
    const bbox = buildBbox(params.lat, params.lon, radius);

    const query = `[out:json][timeout:15];node["rcn_ref"](${bbox});out 100;`;

    try {
      const elements = await queryOverpass(query);

      const junctions = elements
        .filter((el) => el.lat && el.tags?.rcn_ref)
        .map((el) => ({
          junction_number: el.tags!.rcn_ref,
          lat: el.lat!,
          lon: el.lon!,
          distance_m: Math.round(haversineDistance(params.lat, params.lon, el.lat!, el.lon!)),
          name: el.tags?.name || undefined,
        }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 40);

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

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${junctions.length} cycling junctions (knooppunten) near (${params.lat}, ${params.lon}):\n${JSON.stringify(junctions, null, 2)}`,
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
