import { NextResponse } from "next/server";
import { z } from "zod";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { requireApproved } from "@/lib/gate";
import { hit, tooMany } from "@/lib/ratelimit";
import { getIncidents } from "@/lib/fleet";
import { INCIDENT_TYPES, type IncidentType } from "@/lib/fleetLogic";

/** GET /api/incidents?type=IMPACT,POTHOLE&vehicleId=&since=<ms>&before=<ts>_<id>&limit=50 */
export async function GET(req: Request) {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const blocked = await requireApproved(orgId); if (blocked) return blocked;
  if (!(await hit(`read:${orgId}`, 600, 60))) return tooMany(60);

  const sp = new URL(req.url).searchParams;
  const typeParam = sp.get("type");
  let types: IncidentType[] | undefined;
  if (typeParam) {
    types = typeParam.split(",").map((s) => s.trim().toUpperCase()) as IncidentType[];
    if (types.some((t) => !(INCIDENT_TYPES as readonly string[]).includes(t))) return NextResponse.json({ error: "Unknown incident type" }, { status: 400 });
  }
  const vehicleId = sp.get("vehicleId") || undefined;
  if (vehicleId && !z.string().uuid().safeParse(vehicleId).success) return NextResponse.json({ error: "Invalid vehicleId" }, { status: 400 });
  const sinceRaw = sp.get("since"); const since = sinceRaw ? Number(sinceRaw) : undefined;
  if (sinceRaw && !Number.isFinite(since)) return NextResponse.json({ error: "since must be epoch milliseconds" }, { status: 400 });
  const before = sp.get("before"); let cursor: { ts: number; id: number } | undefined;
  if (before) {
    const m = /^(\d{10,16})_(\d+)$/.exec(before);
    if (!m) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    cursor = { ts: Number(m[1]), id: Number(m[2]) };
  }
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit") ?? 50) || 50));

  return NextResponse.json(await getIncidents(orgId, { types, vehicleId, since, cursor, limit }), { headers: { "Cache-Control": "no-store" } });
}
