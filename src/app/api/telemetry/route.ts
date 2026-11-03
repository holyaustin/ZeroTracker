import { NextResponse } from "next/server";
import { driverAuthFromRequest, driverError } from "@/lib/driver";
import { ClientEvent, ingest, tsInRange } from "@/lib/telemetry";

/** One device event (a ping or an incident), authenticated by the driver link in the x-driver-token header. */
export async function POST(req: Request) {
  const a = await driverAuthFromRequest(req);
  if (!a.ok) return driverError(a);

  const text = await req.text();
  if (text.length > 20_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const p = ClientEvent.safeParse(body);
  if (!p.success) return NextResponse.json({ error: "Invalid event", detail: p.error.issues[0]?.message }, { status: 400 });
  const now = Date.now();
  if (!tsInRange(p.data.ts, now)) return NextResponse.json({ error: "Timestamp out of range", code: "BAD_TIMESTAMP", now }, { status: 400 });

  const r = await ingest({ vehicleId: a.vehicleId, orgId: a.orgId, label: a.label }, [p.data], now);
  return NextResponse.json({ ok: true, ...r, now }, { headers: { "Cache-Control": "no-store" } });
}
