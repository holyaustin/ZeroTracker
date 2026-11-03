import { NextResponse } from "next/server";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { requireApproved } from "@/lib/gate";
import { hit, tooMany } from "@/lib/ratelimit";
import { getLiveFleet, withStatus } from "@/lib/fleet";

export async function GET() {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const blocked = await requireApproved(orgId); if (blocked) return blocked;
  if (!(await hit(`read:${orgId}`, 600, 60))) return tooMany(60);
  const now = Date.now();
  return NextResponse.json({ vehicles: withStatus(await getLiveFleet(orgId), now), now }, { headers: { "Cache-Control": "no-store" } });
}
