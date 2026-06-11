import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatDistance, cardinalBearing } from "../utils/format.js";
import { textResult, jsonResult } from "../utils/tool-result.js";

// OpenRouteService routes on the actual cycling network (Dutch fietspaden) and
// returns elevation + human-readable turn instructions. It needs a valid
// ORS_API_KEY. OSRM's public bike profile is the keyless fallback: town/
// major-road level, no elevation, no SLA — but always available.
const ORS_URL = "https://api.openrouteservice.org/v2/directions/cycling-regular/geojson";
const OSRM_URL = "https://router.project-osrm.org/route/v1/bike";

// Realistic recreational cycling pace, used to derive time from distance when
// the routing backend doesn't provide a trustworthy cycling duration (OSRM's
// public demo returns car-speed durations). ~18 km/h is a sensible average that
// accounts for wind, stops, and town crossings; e-bikes are a bit faster, which
// the model notes in the narrative.
const CYCLING_SPEED_KMH = 18;

type Coordinate = { lon: number; lat: number };

interface RouteResult {
  source: string;
  distance: string;
  distance_km: string;
  duration: string;
  duration_hours: string;
  // Cardinal direction of each waypoint-to-waypoint leg ("Rotterdam → Kinderdijk:
  // southeast"). Computed from the input coordinates so the model never has to
  // guess compass directions in its prose.
  leg_bearings: string[];
  ascent_m?: number;
  descent_m?: number;
  instructions?: Array<{ instruction: string; distance: string; name?: string }>;
}

function legBearings(coords: Coordinate[]): string[] {
  const legs: string[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    legs.push(`leg ${i + 1}: heading ${cardinalBearing(a.lat, a.lon, b.lat, b.lon)}`);
  }
  return legs;
}

async function planWithORS(coords: Coordinate[]): Promise<RouteResult> {
  const res = await fetch(ORS_URL, {
    method: "POST",
    headers: {
      Authorization: process.env.ORS_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      coordinates: coords.map((c) => [c.lon, c.lat]),
      instructions: true,
      elevation: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`ORS ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error("ORS returned no route");

  const summary = feature.properties.summary;
  const steps = (feature.properties.segments ?? []).flatMap((seg: any) =>
    (seg.steps ?? [])
      .filter((s: any) => s.distance > 0)
      .map((s: any) => ({
        instruction: s.instruction,
        distance: formatDistance(s.distance),
        name: s.name && s.name !== "-" ? s.name : undefined,
      })),
  );

  return {
    source: "OpenRouteService (cycling network)",
    distance: formatDistance(summary.distance),
    distance_km: (summary.distance / 1000).toFixed(1),
    duration: formatDuration(summary.duration * 1000),
    duration_hours: (summary.duration / 3600).toFixed(1),
    leg_bearings: legBearings(coords),
    ascent_m: feature.properties.ascent != null ? Math.round(feature.properties.ascent) : undefined,
    descent_m: feature.properties.descent != null ? Math.round(feature.properties.descent) : undefined,
    instructions: steps.slice(0, 8),
  };
}

async function planWithOSRM(coords: Coordinate[]): Promise<RouteResult> {
  const coordStr = coords.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `${OSRM_URL}/${coordStr}?overview=false&steps=true&annotations=distance,duration`;

  const res = await fetch(url, {
    headers: { "User-Agent": "VeloGuide/1.0" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    throw new Error(`OSRM ${res.status}: no cycling route may exist between these points.`);
  }

  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM: ${data.code}. ${data.message || "Points may be unreachable by bike."}`);
  }

  const route = data.routes[0];
  const steps = route.legs?.flatMap((leg: any) =>
    leg.steps
      ?.filter((s: any) => s.maneuver?.type !== "arrive" || s.distance > 0)
      .map((step: any) => ({
        instruction: `${step.maneuver?.modifier ? step.maneuver.modifier + " " : ""}${step.maneuver?.type || "continue"}`,
        distance: formatDistance(step.distance),
        name: step.name || undefined,
      })),
  );

  // The public OSRM demo's "bike" profile returns car-speed durations (~60 km/h),
  // so its duration is unusable for a cycling planner. The DISTANCE is accurate;
  // we derive cycling time from it at a realistic recreational pace instead.
  const cyclingSeconds = (route.distance / 1000 / CYCLING_SPEED_KMH) * 3600;

  return {
    source: `OSRM (distance); time estimated at ${CYCLING_SPEED_KMH} km/h cycling pace`,
    distance: formatDistance(route.distance),
    distance_km: (route.distance / 1000).toFixed(1),
    duration: formatDuration(cyclingSeconds * 1000),
    duration_hours: (cyclingSeconds / 3600).toFixed(1),
    leg_bearings: legBearings(coords),
    instructions: steps?.slice(0, 8),
  };
}

export const planRouteTool = defineTool({
  name: "plan_route",
  label: "Plan Cycling Route",
  description:
    "Calculate a cycling route between waypoints. Returns real computed distance, cycling time, elevation gain, per-leg compass bearings, and step-by-step instructions. Routes follow the Dutch cycling network where possible. ALWAYS use this tool instead of estimating distances, times, or directions yourself.",
  parameters: Type.Object({
    coordinates: Type.Array(
      Type.Object({
        lon: Type.Number({ description: "Longitude" }),
        lat: Type.Number({ description: "Latitude" }),
      }),
      { description: "Waypoints in order [start, ...via, end]. Minimum 2 points.", minItems: 2 },
    ),
    target_min_km: Type.Optional(
      Type.Number({
        description:
          "Minimum acceptable distance in km for this leg/day given the traveller's level (e.g. 80 for an experienced cyclist's full day). If the routed distance comes in below this, the result tells you to re-route with more waypoints.",
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const coords = params.coordinates;
    const errors: string[] = [];

    // The distance-adequacy correction lives in the tool result (not only the
    // system prompt) because the model attends far more reliably to tool text:
    // a short route comes back with an explicit re-route instruction attached.
    const withTargetCheck = (route: RouteResult): RouteResult & { distance_check?: string } => {
      const km = parseFloat(route.distance_km);
      if (params.target_min_km && km < params.target_min_km) {
        return {
          ...route,
          distance_check: `TOO SHORT: ${km} km is below the ${params.target_min_km} km minimum for this traveller. Do NOT present this as a full day — call plan_route again with additional waypoints (a wider loop or a detour) until the distance is at least ${params.target_min_km} km.`,
        };
      }
      return route;
    };

    // Prefer ORS (cycling-network + elevation) when a key is configured; fall
    // back to OSRM so routing always works even without/with an invalid key.
    if (process.env.ORS_API_KEY) {
      try {
        return jsonResult(withTargetCheck(await planWithORS(coords)));
      } catch (err: any) {
        errors.push(`ORS failed (${err.message}); fell back to OSRM.`);
      }
    }

    try {
      return jsonResult(withTargetCheck(await planWithOSRM(coords)));
    } catch (err: any) {
      errors.push(`OSRM failed (${err.message}).`);
      return textResult(
        `Could not compute a route. ${errors.join(" ")} This may mean no cycling route exists between these points (e.g. a water crossing without a ferry).`,
      );
    }
  },
});
