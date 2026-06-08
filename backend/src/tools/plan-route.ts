import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatDistance } from "../utils/format.js";

const ORS_URL = "https://api.openrouteservice.org/v2/directions/cycling-regular";
const ORS_API_KEY = process.env.ORS_API_KEY ?? "";

export const planRouteTool: ToolDefinition = {
  name: "plan_route",
  label: "Plan Cycling Route",
  description:
    "Calculate a cycling route between waypoints using OpenRouteService. Returns real computed distance, cycling time, elevation gain/loss, and step-by-step instructions. ALWAYS use this tool instead of estimating distances or times yourself.",
  parameters: Type.Object({
    coordinates: Type.Array(
      Type.Object({
        lon: Type.Number({ description: "Longitude" }),
        lat: Type.Number({ description: "Latitude" }),
      }),
      { description: "Waypoints in order [start, ...via, end]. Minimum 2 points.", minItems: 2 },
    ),
  }),
  execute: async (_toolCallId, params: any) => {
    const coords = params.coordinates.map((p: any) => [p.lon, p.lat]);

    const res = await fetch(ORS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: ORS_API_KEY,
      },
      body: JSON.stringify({
        coordinates: coords,
        instructions: true,
        elevation: true,
        units: "km",
        language: "en",
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      return {
        content: [
          {
            type: "text" as const,
            text: `Routing error (${res.status}): ${errorBody}. This may mean no cycling route exists between these points (e.g., separated by water without a bridge/ferry).`,
          },
        ],
        details: {},
      };
    }

    const data = await res.json();
    const route = data.routes?.[0];

    if (!route) {
      return {
        content: [{ type: "text" as const, text: "No route found between the given points." }],
        details: {},
      };
    }

    const summary = route.summary;
    const steps = route.segments?.flatMap((seg: any) =>
      seg.steps?.map((step: any) => ({
        instruction: step.instruction,
        distance: formatDistance(step.distance * 1000),
        name: step.name || undefined,
      })),
    );

    const result = {
      distance: formatDistance(summary.distance * 1000),
      distance_km: summary.distance.toFixed(1),
      duration: formatDuration(summary.duration * 1000),
      duration_hours: (summary.duration / 3600).toFixed(1),
      ascent_m: Math.round(route.summary.ascent ?? 0),
      descent_m: Math.round(route.summary.descent ?? 0),
      bbox: route.bbox,
      instructions: steps?.slice(0, 30),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      details: {},
    };
  },
};
