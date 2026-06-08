import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { queryOverpass, buildBbox } from "../utils/overpass.js";
import { haversineDistance } from "../utils/format.js";

const CATEGORY_MAP: Record<string, string> = {
  cafe: 'node["amenity"="cafe"]',
  restaurant: 'node["amenity"="restaurant"]',
  museum: 'node["tourism"="museum"]',
  bicycle_rental: 'node["amenity"="bicycle_rental"]',
  bicycle_repair: 'node["shop"="bicycle"]',
  viewpoint: 'node["tourism"="viewpoint"]',
  windmill: 'node["man_made"="windmill"]',
  supermarket: 'node["shop"="supermarket"]',
  drinking_water: 'node["amenity"="drinking_water"]',
  attraction: 'node["tourism"="attraction"]',
  picnic: 'node["tourism"="picnic_site"]',
  castle: 'node["historic"="castle"]',
  church: 'node["amenity"="place_of_worship"]["building"="church"]',
};

export const findPoisTool: ToolDefinition = {
  name: "find_pois",
  label: "Find Points of Interest",
  description: `Find points of interest near a location. Available categories: ${Object.keys(CATEGORY_MAP).join(", ")}. Returns name, type, coordinates, and distance from the search point. Use this to find cafes, restaurants, attractions, and practical stops along a cycling route.`,
  parameters: Type.Object({
    lat: Type.Number({ description: "Latitude of search center" }),
    lon: Type.Number({ description: "Longitude of search center" }),
    radius_m: Type.Number({
      description: "Search radius in meters (default 2000)",
      default: 2000,
    }),
    categories: Type.Array(Type.String(), {
      description: `Categories to search. Options: ${Object.keys(CATEGORY_MAP).join(", ")}`,
    }),
  }),
  execute: async (_toolCallId, params: any) => {
    const radius = params.radius_m || 2000;
    const bbox = buildBbox(params.lat, params.lon, radius);

    const filters = params.categories
      .filter((c: string) => CATEGORY_MAP[c])
      .map((c: string) => `${CATEGORY_MAP[c]}(${bbox});`);

    if (!filters.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No valid categories provided. Available: ${Object.keys(CATEGORY_MAP).join(", ")}`,
          },
        ],
        details: {},
      };
    }

    const query = `[out:json][timeout:15];(${filters.join("")});out center 60;`;

    try {
      const elements = await queryOverpass(query);

      const pois = elements
        .filter((el) => el.lat || el.center)
        .map((el) => {
          const elLat = el.lat ?? el.center!.lat;
          const elLon = el.lon ?? el.center!.lon;
          return {
            name: el.tags?.name || el.tags?.["name:en"] || "Unnamed",
            type: el.tags?.amenity || el.tags?.tourism || el.tags?.shop || el.tags?.man_made || el.tags?.historic || "unknown",
            lat: elLat,
            lon: elLon,
            distance_m: Math.round(haversineDistance(params.lat, params.lon, elLat, elLon)),
            opening_hours: el.tags?.opening_hours || undefined,
            website: el.tags?.website || undefined,
          };
        })
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 20);

      if (!pois.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No POIs found for categories [${params.categories.join(", ")}] within ${radius}m of (${params.lat}, ${params.lon}).`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(pois, null, 2) }],
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
