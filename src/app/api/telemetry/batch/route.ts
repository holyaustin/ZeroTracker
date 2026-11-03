import { NextResponse } from "next/server";
import { driverAuthFromRequest, driverError } from "@/lib/driver";
import { ClientEvent, MAX_BATCH, ingest, tsInRange, type ClientEventT } from "@/lib/telemetry";

/**
 * Offline sync: up to 200 queued events in one request, idempotent by clientEventId.
 * Each event is validated on its own, so one bad event never blocks the rest of a backlog.
 * The response tells the client exactly which ids were rejected so it can stop retrying them.
 */
export async function POST(req: Request) {
  const a = await driverAuthFromRequest(req);
  if (!a.ok) return driverError(a);

  const text = await req.text();
  if (text.length > 400_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const list = (body as { events?: unknown })?.events;
  if (!Array.isArray(list) || list.length === 0) return NextResponse.json({ error: "Send { events: [...] } with at least one event." }, { status: 400 });
  if (list.length > MAX_BATCH) return NextResponse.json({ error: `At most ${MAX_BATCH} events per batch.` }, { status: 413 });

  const now = Date.now();
  const seen = new Set<string>();
  const valid: ClientEventT[] = [];
  const rejectedIds: string[] = [];
  let rejected = 0, repeated = 0;
  for (const raw of list) {
    const p = ClientEvent.safeParse(raw);
    if (!p.success || !tsInRange(p.data.ts, now)) {
      rejected++;
      const id = (raw as { clientEventId?: unknown })?.clientEventId;
      if (typeof id === "string") rejectedIds.push(id.slice(0, 64));
      continue;
    }
    if (seen.has(p.data.clientEventId)) { repeated++; continue; }   // same id twice inside one request
    seen.add(p.data.clientEventId);
    valid.push(p.data);
  }

  const r = valid.length ? await ingest({ vehicleId: a.vehicleId, orgId: a.orgId, label: a.label }, valid, now) : { accepted: 0, duplicates: 0 };
  return NextResponse.json(
    { ok: true, accepted: r.accepted, duplicates: r.duplicates + repeated, rejected, rejectedIds, now },
    { headers: { "Cache-Control": "no-store" } },
  );
}
