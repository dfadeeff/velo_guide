import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatDistance } from "../utils/format.js";

const OSRM_URL = "https://router.project-osrm.org/route/v1/bike";

export const planRouteTool: ToolDefinition = {
  name: "plan_route",
  label: "Plan Cycling Route",
  description:
    "Calculate a cycling route between waypoints. Returns real computed distance, cycling time, and step-by-step instructions. ALWAYS use this tool instead of estimating distances or times yourself.",
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
    const coordStr = params.coordinates
      .map((p: any) => `${p.lon},${p.lat}`)
      .join(";");

    const url = `${OSRM_URL}/${coordStr}?overview=false&steps=true&annotations=distance,duration`;

    const res = await fetch(url, {
      headers: { "User-Agent": "VeloGuide/1.0" },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      return {
        content: [
          {
            type: "text" as const,
            text: `Routing error (${res.status}): ${errorBody}. This may mean no cycling route exists between these points.`,
          },
        ],
        details: {},
      };
    }

    const data = await res.json();

    if (data.code !== "Ok" || !data.routes?.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No route found: ${data.code}. ${data.message || "The points may be unreachable by bike."}`,
          },
        ],
        details: {},
      };
    }

    const route = data.routes[0];
    const totalDistanceM = route.distance;
    const totalDurationS = route.duration;

    const steps = route.legs?.flatMap((leg: any) =>
      leg.steps
        ?.filter((s: any) => s.maneuver?.type !== "arrive" || s.distance > 0)
        .map((step: any) => ({
          instruction: `${step.maneuver?.modifier ? step.maneuver.modifier + " " : ""}${step.maneuver?.type || "continue"}`,
          distance: formatDistance(step.distance),
          name: step.name || undefined,
        })),
    );

    const result = {
      distance: formatDistance(totalDistanceM),
      distance_km: (totalDistanceM / 1000).toFixed(1),
      duration: formatDuration(totalDurationS * 1000),
      duration_hours: (totalDurationS / 3600).toFixed(1),
      instructions: steps?.slice(0, 30),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      details: {},
    };
  },
};
