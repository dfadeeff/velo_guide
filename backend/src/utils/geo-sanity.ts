// Geo-sanity checks: the validation layer the tool-grounding architecture was
// missing. Grounding guarantees every *fact* comes from a tool — but the model
// still chooses WHICH waypoints to feed plan_route, so a faithful tool can
// return a real distance for a geographically silly route (a zigzag, an
// impossibly short hop). The LLM-as-judge can't catch that: it treats tool
// output as ground truth, so a number that matches plan_route "passes". These
// pure functions inspect the routed geometry itself.
//
// All functions here are pure (no I/O) and unit-tested offline — same posture as
// utils/format.ts. The eval harness runs them on the waypoints plan_route now
// echoes in its result; nothing here calls the network.
import { haversineDistance, bearingDegrees } from "./format.js";

export interface LatLon {
  lat: number;
  lon: number;
}

const km = (a: LatLon, b: LatLon) => haversineDistance(a.lat, a.lon, b.lat, b.lon) / 1000;

// Smallest absolute difference between two compass bearings, in [0, 180].
function angleDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// (A) Straight-line floor — a HARD geometric impossibility. You cannot cycle a
// shorter distance than the great-circle line between the day's endpoints, so a
// routed day distance below that floor means wrong endpoints or a fabricated
// number. For a loop (start ≈ end) the floor is ~0, so this never false-fires on
// loops — it only flags point-to-point days that are physically too short.
export function straightLineFloor(waypoints: LatLon[]): { floorKm: number; ok: (routedKm: number) => boolean } {
  const floorKm = waypoints.length >= 2 ? km(waypoints[0], waypoints[waypoints.length - 1]) : 0;
  // 1% slack absorbs rounding and the great-circle vs WGS84 difference.
  return { floorKm, ok: (routedKm: number) => routedKm >= floorKm * 0.99 };
}

export interface Reversal {
  index: number; // the waypoint where the path doubles back
  angleDeg: number; // turn angle (180° = a full U-turn)
}

// (B) Zigzag / backtrack detection. At each interior waypoint, compare the
// incoming leg's bearing to the outgoing leg's. A near-U-turn (the path arrives
// heading NE and leaves heading SW) is the signature of a detour that wandered
// out and back — the Purmerend → Marken → Volendam zigzag. Tiny legs (< minLegKm)
// are ignored: a 200 m wiggle through a town isn't a planning error. This is a
// REVIEW signal, not a hard fail — a deliberate out-and-back to a viewpoint is a
// legitimate (if rare) sharp reversal.
export function detectZigzags(waypoints: LatLon[], thresholdDeg = 135, minLegKm = 1): Reversal[] {
  const out: Reversal[] = [];
  for (let i = 1; i < waypoints.length - 1; i++) {
    const prev = waypoints[i - 1];
    const here = waypoints[i];
    const next = waypoints[i + 1];
    if (km(prev, here) < minLegKm || km(here, next) < minLegKm) continue;
    const inBearing = bearingDegrees(prev.lat, prev.lon, here.lat, here.lon);
    const outBearing = bearingDegrees(here.lat, here.lon, next.lat, next.lon);
    // Heading change of 180° = reverse direction. Flag when the turn exceeds the
    // threshold (i.e. the route nearly comes back the way it went).
    const turn = angleDelta(inBearing, outBearing);
    if (turn >= thresholdDeg) out.push({ index: i, angleDeg: Math.round(turn) });
  }
  return out;
}

// (C) Endpoint grounding. Every place named as a day's start/end ("Day 1:
// Amsterdam → Enkhuizen") must have been geocoded — otherwise the route's
// endpoints are narrative, not tool-sourced. `geocoded` is the set of place
// names the geocode tool actually resolved. Matching is loose (case-insensitive
// substring either direction) to tolerate "Den Haag" vs "The Hague" style
// variance without inventing matches.
export function ungroundedEndpoints(endpoints: string[], geocoded: string[]): string[] {
  const known = geocoded.map((g) => g.toLowerCase().trim()).filter(Boolean);
  return endpoints.filter((place) => {
    const p = place.toLowerCase().trim();
    if (!p) return false;
    return !known.some((g) => g.includes(p) || p.includes(g));
  });
}

// Convenience: run the geometric checks (A + B) on one routed day.
export interface RouteVerdict {
  floorKm: number;
  routedKm: number;
  belowFloor: boolean;
  zigzags: Reversal[];
}

export function verifyRoute(waypoints: LatLon[], routedKm: number): RouteVerdict {
  const { floorKm, ok } = straightLineFloor(waypoints);
  return {
    floorKm: Math.round(floorKm * 10) / 10,
    routedKm,
    belowFloor: !ok(routedKm),
    zigzags: detectZigzags(waypoints),
  };
}