import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { requireApproved } from "@/lib/gate";
import { hit, tooMany } from "@/lib/ratelimit";
import { getHistory } from "@/lib/fleet";

const MAX_RANGE_MS = 31 * 24 * 3600 * 1000;
const parseTime = (v: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(/^\d{10,16}$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? undefined as never : d;
};

/** GET /api/vehicles/:id/history?from=&to=  (ISO strings or epoch ms; defaults to the last 24 hours). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const blocked = await requireApproved(orgId); if (blocked) return blocked;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid vehicle id" }, { status: 400 });
  if (!(await hit(`read:${orgId}`, 600, 60))) return tooMany(60);

  const url = new URL(req.url);
  const f = parseTime(url.searchParams.get("from")), t = parseTime(url.searchParams.get("to"));
  if (f === undefined || t === undefined) return NextResponse.json({ error: "from/to must be ISO dates or epoch milliseconds" }, { status: 400 });
  const to = t ?? new Date(), from = f ?? new Date(to.getTime() - 24 * 3600 * 1000);
  if (from >= to) return NextResponse.json({ error: "from must be earlier than to" }, { status: 400 });
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) return NextResponse.json({ error: "Range can be at most 31 days" }, { status: 400 });

  // Ownership is decided by the session's orgId, never by the request.
  const [vehicle] = await db.select({ id: schema.vehicles.id, label: schema.vehicles.label }).from(schema.vehicles)
    .where(and(eq(schema.vehicles.id, id), eq(schema.vehicles.orgId, orgId))).limit(1);
  if (!vehicle) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });

  const h = await getHistory(vehicle.id, from, to);
  return NextResponse.json({ vehicle, from: from.getTime(), to: to.getTime(), ...h }, { headers: { "Cache-Control": "no-store" } });
}
