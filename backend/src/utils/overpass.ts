const OVERPASS_API = "https://overpass-api.de/api/interpreter";

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

export async function queryOverpass(query: string): Promise<OverpassElement[]> {
  const res = await fetch(OVERPASS_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.elements ?? [];
}

export function buildBbox(lat: number, lon: number, radiusM: number): string {
  const latDelta = radiusM / 111320;
  const lonDelta = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return `${lat - latDelta},${lon - lonDelta},${lat + latDelta},${lon + lonDelta}`;
}
