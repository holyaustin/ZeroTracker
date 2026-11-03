// Pure fleet helpers shared by the server and the live map (unit-tested in test/unit.mjs).

export const OFFLINE_AFTER_MS = 60_000;   // no data for 60 s = disconnected
export const MOVING_KMH = 5;              // at or above this the vehicle counts as moving
export const MAX_ROUTE_POINTS = 2000;     // points drawn for a route (the line is smoothed by sampling, never truncated)

export type LiveStatus = "moving" | "idle" | "backgrounded" | "offline" | "waiting";
export type AppStateName = "FOREGROUND" | "BACKGROUNDED";

export type VehicleLive = {
  id: string; label: string; plateNumber: string | null; driverName: string | null;
  lat: number | null; lng: number | null; speedKmh: number | null; batteryPct: number | null;
  appState: AppStateName; online: boolean; lastSeenAt: number | null; lastTs: number | null;
};

/** Computed on read, so a vehicle goes offline after 60 s of silence even if no job has run yet. */
export function computeStatus(
  v: Pick<VehicleLive, "lat" | "lng" | "speedKmh" | "appState" | "online" | "lastSeenAt">, now: number,
): LiveStatus {
  if (v.lat == null || v.lng == null) return "waiting";                 // never reported a position: not drawn on the map
  const alive = v.online && v.lastSeenAt != null && now - v.lastSeenAt <= OFFLINE_AFTER_MS;
  if (!alive) return "offline";
  if (v.appState === "BACKGROUNDED") return "backgrounded";
  return (v.speedKmh ?? 0) >= MOVING_KMH ? "moving" : "idle";
}

export const STATUS_LABEL: Record<LiveStatus, string> = {
  moving: "Moving", idle: "Idle", backgrounded: "App in background", offline: "Offline", waiting: "Waiting for first position",
};

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Evenly samples down to `max` items, always keeping the first and the last. */
export function downsample<T>(a: T[], max: number): T[] {
  if (a.length <= max || max < 2) return a;
  const step = (a.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => a[Math.round(i * step)]);
}

export type RoutePoint = { t: number; lat: number; lng: number; s: number | null };
export function summarizeRoute(points: RoutePoint[]) {
  let distanceKm = 0, maxSpeedKmh: number | null = null;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) distanceKm += haversineKm(points[i - 1], points[i]);
    const s = points[i].s;
    if (s != null && (maxSpeedKmh == null || s > maxSpeedKmh)) maxSpeedKmh = s;
  }
  return {
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMs: points.length > 1 ? points[points.length - 1].t - points[0].t : 0,
    maxSpeedKmh,
  };
}

export const INCIDENT_TYPES = ["IMPACT", "POTHOLE", "LOW_BATTERY", "BACKGROUNDED", "FOREGROUNDED", "DISCONNECTED", "CONNECTED", "GPS_PING"] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export const FEED_GROUPS: Record<string, { label: string; types: IncidentType[] | null }> = {
  all: { label: "All", types: null },
  impacts: { label: "Impacts", types: ["IMPACT", "POTHOLE"] },
  battery: { label: "Battery", types: ["LOW_BATTERY"] },
  app: { label: "App state", types: ["BACKGROUNDED", "FOREGROUNDED"] },
  connection: { label: "Connection", types: ["CONNECTED", "DISCONNECTED"] },
  gps: { label: "GPS pings", types: ["GPS_PING"] },
};

export type Incident = {
  id?: number; vehicleId: string; label: string; type: IncidentType; gForce: number | null;
  lat: number | null; lng: number | null; message: string | null; ts: number;
};
export const incidentKey = (i: Pick<Incident, "vehicleId" | "type" | "ts">) => `${i.vehicleId}|${i.type}|${i.ts}`;

/** Newest first, de-duplicated (a pushed event and the same row from the API collapse into one). */
export function mergeIncidents(prev: Incident[], incoming: Incident[], cap = 500): Incident[] {
  const map = new Map<string, Incident>();
  for (const i of [...prev, ...incoming]) { const k = incidentKey(i); const old = map.get(k); map.set(k, old && old.id != null && i.id == null ? old : i); }
  return [...map.values()].sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0)).slice(0, cap);
}
