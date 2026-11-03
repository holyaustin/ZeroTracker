import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { channels, publish } from "@/lib/realtime";
import { MAX_ROUTE_POINTS, OFFLINE_AFTER_MS, computeStatus, downsample, summarizeRoute, type Incident, type IncidentType, type VehicleLive } from "@/lib/fleetLogic";

/**
 * Marks vehicles that have been silent for 60 s as offline and logs DISCONNECTED, exactly once (the UPDATE is atomic).
 * Runs lazily whenever a manager reads the fleet, and from the scheduled job for every company (orgId omitted).
 */
export async function sweepDisconnected(orgId?: string): Promise<number> {
  const stale = await db.transaction(async (tx) => {
    const r = await tx.execute(sql`
      WITH stale AS (
        UPDATE vehicle_status vs SET online = false
        FROM vehicles v
        WHERE vs.vehicle_id = v.id AND vs.online = true AND vs.last_seen_at < now() - make_interval(secs => ${OFFLINE_AFTER_MS / 1000}::float8)
          ${orgId ? sql`AND v.org_id = ${orgId}` : sql``}
        RETURNING vs.vehicle_id, v.org_id, v.label, vs.last_seen_at, vs.last_lat, vs.last_lng
      ) SELECT * FROM stale`);
    const rows = r.rows as { vehicle_id: string; org_id: string; label: string; last_seen_at: Date; last_lat: number | null; last_lng: number | null }[];
    if (rows.length) await tx.insert(schema.incidents).values(rows.map((x) => ({
      vehicleId: x.vehicle_id, orgId: x.org_id, type: "DISCONNECTED" as const, lat: x.last_lat, lng: x.last_lng,
      message: "No data received for 60 seconds", ts: new Date(new Date(x.last_seen_at).getTime() + OFFLINE_AFTER_MS),
    })));
    return rows;
  });
  for (const x of stale) {
    const ts = new Date(x.last_seen_at).getTime() + OFFLINE_AFTER_MS;
    await publish(channels.fleet(x.org_id), "incident", { vehicleId: x.vehicle_id, label: x.label, type: "DISCONNECTED", gForce: null, lat: x.last_lat, lng: x.last_lng, message: "No data received for 60 seconds", ts });
    await publish(channels.fleet(x.org_id), "vehicle-status", { vehicleId: x.vehicle_id, label: x.label, online: false });
  }
  return stale.length;
}

/** Vehicles that currently have an ACTIVE driver link. A revoked vehicle disappears from the live map. */
export async function getLiveFleet(orgId: string): Promise<VehicleLive[]> {
  await sweepDisconnected(orgId);
  const v = schema.vehicles, t = schema.driverTokens, s = schema.vehicleStatus;
  const rows = await db.select({ v, s }).from(v)
    .innerJoin(t, and(eq(t.vehicleId, v.id), eq(t.status, "ACTIVE")))
    .leftJoin(s, eq(s.vehicleId, v.id))
    .where(eq(v.orgId, orgId)).orderBy(asc(v.label), asc(v.id));
  return rows.map(({ v, s }) => ({
    id: v.id, label: v.label, plateNumber: v.plateNumber, driverName: v.driverName,
    lat: s?.lastLat ?? null, lng: s?.lastLng ?? null, speedKmh: s?.lastSpeedKmh ?? null, batteryPct: s?.lastBatteryPct ?? null,
    appState: s?.appState ?? "FOREGROUND", online: s?.online ?? false,
    lastSeenAt: s?.lastSeenAt?.getTime() ?? null, lastTs: s?.lastTs?.getTime() ?? null,
  }));
}
export const withStatus = (list: VehicleLive[], now = Date.now()) => list.map((x) => ({ ...x, status: computeStatus(x, now) }));

const RAW_CAP = 20_000;

/** Route for one vehicle (already ownership-checked by the caller): positions, summary and impact points in [from, to]. */
export async function getHistory(vehicleId: string, from: Date, to: Date) {
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM telemetry WHERE vehicle_id = ${vehicleId} AND ts >= ${from} AND ts <= ${to}`)).rows as { n: number }[];
  const k = Math.max(1, Math.ceil(n / RAW_CAP));   // very long ranges are thinned evenly in SQL first
  const rows = (await db.execute(sql`
    SELECT ts, lat, lng, speed_kmh FROM (
      SELECT ts, lat, lng, speed_kmh, row_number() OVER (ORDER BY ts, id) AS rn, count(*) OVER () AS total
      FROM telemetry WHERE vehicle_id = ${vehicleId} AND ts >= ${from} AND ts <= ${to}
    ) x WHERE ${k} = 1 OR rn % ${k} = 1 OR rn = total ORDER BY ts, rn`)).rows as { ts: Date; lat: number; lng: number; speed_kmh: number | null }[];
  const all = rows.map((r) => ({ t: new Date(r.ts).getTime(), lat: r.lat, lng: r.lng, s: r.speed_kmh }));
  const summary = summarizeRoute(all);
  const points = downsample(all, MAX_ROUTE_POINTS);

  const i = schema.incidents;
  const imp = await db.select().from(i).where(and(eq(i.vehicleId, vehicleId), inArray(i.type, ["IMPACT", "POTHOLE"]), gte(i.ts, from), lte(i.ts, to), sql`${i.lat} is not null`))
    .orderBy(desc(i.ts)).limit(500);
  return {
    points, totalPoints: n, sampled: points.length < n,
    summary: { ...summary, pointCount: n, impactCount: imp.length },
    impacts: imp.map((x) => ({ id: x.id, type: x.type, gForce: x.gForce, lat: x.lat as number, lng: x.lng as number, ts: x.ts.getTime(), message: x.message })),
  };
}

export type IncidentQuery = { types?: IncidentType[]; vehicleId?: string; since?: number; cursor?: { ts: number; id: number }; limit: number };

/** Company-scoped incident feed, newest first, keyset-paginated on (ts, id). */
export async function getIncidents(orgId: string, q: IncidentQuery): Promise<{ incidents: Incident[]; nextCursor: string | null }> {
  await sweepDisconnected(orgId);
  const i = schema.incidents, v = schema.vehicles;
  const conds: SQL[] = [eq(i.orgId, orgId)];
  if (q.types?.length) conds.push(inArray(i.type, q.types));
  if (q.vehicleId) conds.push(eq(i.vehicleId, q.vehicleId));
  if (q.since) conds.push(gte(i.ts, new Date(q.since)));
  if (q.cursor) conds.push(sql`(${i.ts}, ${i.id}) < (${new Date(q.cursor.ts)}, ${q.cursor.id})`);
  const rows = await db.select({ i, label: v.label }).from(i).leftJoin(v, eq(v.id, i.vehicleId))
    .where(and(...conds)).orderBy(desc(i.ts), desc(i.id)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const out: Incident[] = page.map(({ i, label }) => ({ id: i.id, vehicleId: i.vehicleId, label: label ?? "Removed vehicle", type: i.type, gForce: i.gForce, lat: i.lat, lng: i.lng, message: i.message, ts: i.ts.getTime() }));
  const last = out[out.length - 1];
  return { incidents: out, nextCursor: rows.length > q.limit && last ? `${last.ts}_${last.id}` : null };
}
