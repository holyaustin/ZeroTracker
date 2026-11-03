import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { channels, publish } from "@/lib/realtime";

export const MAX_FUTURE_MS = 5 * 60 * 1000;          // device clocks may run slightly ahead
export const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;   // offline batches may be days old, not weeks
export const PING_LOG_EVERY_MS = 60 * 1000;          // GPS_PING audit entries are sampled to one per minute
export const MAX_BATCH = 200;                        // events per /api/telemetry/batch request (matches the phone's chunk size)
export const OFFLINE_AFTER_MS = 60 * 1000;           // no data for 60s = disconnected

const eventId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const nullNum = (min: number, max: number) => z.number().finite().min(min).max(max).nullish();
const ts = z.number().int().positive();

export const PingEvent = z.object({
  kind: z.literal("ping"), clientEventId: eventId, ts,
  lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  speedKmh: nullNum(0, 400), accuracyM: nullNum(0, 100000), heading: nullNum(0, 360),
  batteryPct: z.number().int().min(0).max(100).nullish(), charging: z.boolean().nullish(),
  appState: z.enum(["FOREGROUND", "BACKGROUNDED"]).default("FOREGROUND"),
});
/** Only these incident types may come from a device. CONNECTED / DISCONNECTED / GPS_PING are server-generated. */
export const CLIENT_INCIDENTS = ["IMPACT", "POTHOLE", "LOW_BATTERY", "BACKGROUNDED", "FOREGROUNDED"] as const;
export const IncidentEvent = z.object({
  kind: z.literal("incident"), clientEventId: eventId, ts,
  type: z.enum(CLIENT_INCIDENTS), gForce: nullNum(0, 100),
  lat: nullNum(-90, 90), lng: nullNum(-180, 180), message: z.string().max(200).optional(),
});
export const ClientEvent = z.discriminatedUnion("kind", [PingEvent, IncidentEvent]);
export type Ping = z.infer<typeof PingEvent>;
export type ClientIncident = z.infer<typeof IncidentEvent>;
export type ClientEventT = z.infer<typeof ClientEvent>;

export const tsInRange = (t: number, now: number) => t <= now + MAX_FUTURE_MS && t >= now - MAX_AGE_MS;

type Who = { vehicleId: string; orgId: string; label: string };
type ServerIncident = { type: "CONNECTED" | "DISCONNECTED" | "GPS_PING"; ts: Date; lat: number | null; lng: number | null; message: string };

/**
 * Persists device events for one vehicle. Safe to call with replays and out-of-order batches:
 *  - events are de-duplicated by (vehicle, clientEventId), so a retry never double-inserts;
 *  - the live "last position" only moves forward in device time;
 *  - identity (vehicle / org) always comes from the authenticated link, never from the payload.
 */
export async function ingest(who: Who, events: ClientEventT[], now = Date.now()) {
  const vid = who.vehicleId;
  const cid = (id: string) => `${vid}:${id}`;   // namespaced, so one tenant can never suppress another's events
  const pings = events.filter((e): e is Ping => e.kind === "ping");
  const incs = events.filter((e): e is ClientIncident => e.kind === "incident");
  const nowDate = new Date(now);

  const out = await db.transaction(async (tx) => {
    await tx.insert(schema.vehicleStatus).values({ vehicleId: vid, online: false }).onConflictDoNothing();
    const [st] = await tx.select().from(schema.vehicleStatus).where(eq(schema.vehicleStatus.vehicleId, vid)).for("update");

    let newPings: Ping[] = [];
    if (pings.length) {
      const rows = await tx.insert(schema.telemetry).values(pings.map((p) => ({
        vehicleId: vid, orgId: who.orgId, ts: new Date(p.ts), lat: p.lat, lng: p.lng,
        speedKmh: p.speedKmh ?? null, accuracyM: p.accuracyM ?? null, heading: p.heading ?? null,
        batteryPct: p.batteryPct ?? null, charging: p.charging ?? null, appState: p.appState, clientEventId: cid(p.clientEventId),
      }))).onConflictDoNothing({ target: schema.telemetry.clientEventId }).returning({ c: schema.telemetry.clientEventId });
      const ok = new Set(rows.map((r) => r.c));
      newPings = pings.filter((p) => ok.has(cid(p.clientEventId)));
    }

    let newIncs: ClientIncident[] = [];
    if (incs.length) {
      const rows = await tx.insert(schema.incidents).values(incs.map((i) => ({
        vehicleId: vid, orgId: who.orgId, type: i.type, gForce: i.gForce ?? null, lat: i.lat ?? null, lng: i.lng ?? null,
        message: i.message ?? null, ts: new Date(i.ts), clientEventId: cid(i.clientEventId),
      }))).onConflictDoNothing({ target: schema.incidents.clientEventId }).returning({ c: schema.incidents.clientEventId });
      const ok = new Set(rows.map((r) => r.c));
      newIncs = incs.filter((i) => ok.has(cid(i.clientEventId)));
    }

    const latest = newPings.reduce<Ping | undefined>((m, p) => (!m || p.ts > m.ts ? p : m), undefined);
    const advanced = !!latest && (!st.lastTs || latest.ts > st.lastTs.getTime());
    const wasOnline = st.online && !!st.lastSeenAt && now - st.lastSeenAt.getTime() <= OFFLINE_AFTER_MS;

    const server: ServerIncident[] = [];
    if (st.online && st.lastSeenAt && !wasOnline)
      server.push({ type: "DISCONNECTED", ts: new Date(st.lastSeenAt.getTime() + OFFLINE_AFTER_MS), lat: st.lastLat, lng: st.lastLng, message: "No data received for 60 seconds" });
    if (!wasOnline)
      server.push({ type: "CONNECTED", ts: nowDate, lat: latest?.lat ?? st.lastLat, lng: latest?.lng ?? st.lastLng, message: "Driver connected" });
    // GPS_PING audit entries: one per minute of device time, across the whole batch (an offline backlog logs a trail, not one point).
    let loggedAt: Date | undefined;
    let lastLog = st.lastLoggedAt ? st.lastLoggedAt.getTime() : null;
    for (const p of [...newPings].sort((a, b) => a.ts - b.ts)) {
      if (lastLog === null || p.ts - lastLog >= PING_LOG_EVERY_MS) {
        lastLog = p.ts; loggedAt = new Date(p.ts);
        server.push({ type: "GPS_PING", ts: loggedAt, lat: p.lat, lng: p.lng, message: p.speedKmh != null ? `${Math.round(p.speedKmh)} km/h` : "Position update" });
      }
    }
    if (server.length) await tx.insert(schema.incidents).values(server.map((s) => ({ vehicleId: vid, orgId: who.orgId, type: s.type, lat: s.lat, lng: s.lng, message: s.message, ts: s.ts })));

    // App state: the newest of (latest ping, newest background/foreground incident) wins.
    let appState = advanced ? latest!.appState : st.appState;
    const stateInc = newIncs.filter((i) => i.type === "BACKGROUNDED" || i.type === "FOREGROUNDED").sort((a, b) => b.ts - a.ts)[0];
    const stateRef = advanced ? latest!.ts : st.lastTs?.getTime() ?? 0;
    if (stateInc && stateInc.ts >= stateRef) appState = stateInc.type === "BACKGROUNDED" ? "BACKGROUNDED" : "FOREGROUND";

    await tx.update(schema.vehicleStatus).set({
      online: true, lastSeenAt: nowDate, appState,
      ...(advanced ? { lastLat: latest!.lat, lastLng: latest!.lng, lastSpeedKmh: latest!.speedKmh ?? null, lastBatteryPct: latest!.batteryPct ?? null, lastTs: new Date(latest!.ts) } : {}),
      ...(loggedAt ? { lastLoggedAt: loggedAt } : {}),
    }).where(eq(schema.vehicleStatus.vehicleId, vid));

    return { latest, advanced, newPings, newIncs, server, wasOnline, appState, changedState: appState !== st.appState };
  });

  // Publish only after the data is committed. A failed publish never fails the request (see lib/realtime).
  const ch = channels.fleet(who.orgId);
  if (out.advanced && out.latest) {
    const p = out.latest;
    await publish(ch, "position", { vehicleId: vid, label: who.label, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh ?? null, accuracyM: p.accuracyM ?? null,
      heading: p.heading ?? null, batteryPct: p.batteryPct ?? null, charging: p.charging ?? null, appState: p.appState, ts: p.ts });
  }
  const all = [
    ...out.newIncs.map((i) => ({ type: i.type, gForce: i.gForce ?? null, lat: i.lat ?? null, lng: i.lng ?? null, message: i.message ?? null, ts: i.ts })),
    ...out.server.map((s) => ({ type: s.type, gForce: null, lat: s.lat, lng: s.lng, message: s.message, ts: s.ts.getTime() })),
  ].slice(0, 50);
  for (const i of all) await publish(ch, "incident", { vehicleId: vid, label: who.label, ...i });
  if (!out.wasOnline || out.changedState) await publish(ch, "vehicle-status", { vehicleId: vid, label: who.label, online: true, appState: out.appState });

  const accepted = out.newPings.length + out.newIncs.length;
  return { accepted, duplicates: events.length - accepted };
}
