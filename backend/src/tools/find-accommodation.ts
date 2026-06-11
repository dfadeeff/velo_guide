import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { queryOverpass, buildBbox } from "../utils/overpass.js";
import { haversineDistance } from "../utils/format.js";
import { textResult, jsonResult } from "../utils/tool-result.js";

const ACCOMMODATION_TYPES: Record<string, string> = {
  hotel: 'node["tourism"="hotel"]',
  guest_house: 'node["tourism"="guest_house"]',
  hostel: 'node["tourism"="hostel"]',
  camp_site: 'node["tourism"="camp_site"]',
  apartment: 'node["tourism"="apartment"]',
  motel: 'node["tourism"="motel"]',
};

export const findAccommodationTool = defineTool({
  name: "find_accommodation",
  label: "Find Accommodation",
  description:
    "Find places to stay near a location for multi-day cycling trips. Searches OpenStreetMap for hotels, guest houses, hostels, and campsites. Returns name, type, coordinates, distance, and contact info.",
  parameters: Type.Object({
    lat: Type.Number({ description: "Latitude" }),
    lon: Type.Number({ description: "Longitude" }),
    radius_m: Type.Optional(
      Type.Number({
        description: "Search radius in meters (optional, default 5000)",
        default: 5000,
      }),
    ),
    types: Type.Optional(
      Type.Array(Type.String(), {
        description: `Accommodation types to search. Options: ${Object.keys(ACCOMMODATION_TYPES).join(", ")}. Default: all.`,
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const radius = params.radius_m || 5000;
    const types = params.types?.length ? params.types : Object.keys(ACCOMMODATION_TYPES);
    const bbox = buildBbox(params.lat, params.lon, radius);

    const validTypes = types.filter((t) => ACCOMMODATION_TYPES[t]);
    const filters = validTypes.map((t) => `${ACCOMMODATION_TYPES[t]}(${bbox});`);
    const wayFilters = validTypes.map((t) => `way["tourism"="${t}"](${bbox});`);

    const query = `[out:json][timeout:15];(${filters.join("")}${wayFilters.join("")});out center 30;`;

    try {
      const elements = await queryOverpass(query);

      const accommodations = elements
        .filter((el) => el.lat || el.center)
        .map((el) => {
          const elLat = el.lat ?? el.center!.lat;
          const elLon = el.lon ?? el.center!.lon;
          return {
            name: el.tags?.name || "Unnamed accommodation",
            type: el.tags?.tourism || "unknown",
            lat: elLat,
            lon: elLon,
            distance_m: Math.round(haversineDistance(params.lat, params.lon, elLat, elLon)),
            stars: el.tags?.stars || undefined,
            phone: el.tags?.phone || undefined,
            website: el.tags?.website || undefined,
            email: el.tags?.email || undefined,
          };
        })
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 15);

      if (!accommodations.length) {
        return textResult(
          `No accommodation found within ${radius}m of (${params.lat}, ${params.lon}). Try increasing the search radius or searching a nearby town.`,
        );
      }

      return jsonResult(accommodations);
    } catch (err: any) {
      return textResult(`Overpass API error: ${err.message}`);
    }
  },
});
