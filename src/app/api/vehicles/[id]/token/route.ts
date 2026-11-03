import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { requireApproved } from "@/lib/gate";
import { hit, tooMany } from "@/lib/ratelimit";
import { driverLink } from "@/lib/driver";
import { issueToken } from "@/lib/vehicles";
import { channels, publish } from "@/lib/realtime";

/** Issues a fresh driver link for a vehicle, revoking the previous one. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const blocked = await requireApproved(orgId); if (blocked) return blocked;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid vehicle id" }, { status: 400 });
  if (!(await hit(`vehicle-write:${orgId}`, 120, 3600))) return tooMany(3600);

  // Ownership comes from the session's orgId, never from the request.
  const [vehicle] = await db.select({ id: schema.vehicles.id }).from(schema.vehicles)
    .where(and(eq(schema.vehicles.id, id), eq(schema.vehicles.orgId, orgId))).limit(1);
  if (!vehicle) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });

  let issued;
  try { issued = await db.transaction((tx) => issueToken(tx, orgId, vehicle.id)); }
  catch { return NextResponse.json({ error: "Another change is in progress. Try again." }, { status: 409 }); }

  for (const tokenId of issued.revokedIds) {
    await db.insert(schema.auditLog).values({ actor: `manager:${orgId}`, action: "TOKEN_REVOKED", targetId: tokenId, note: "Replaced by a new link" });
    await publish(channels.vehicle(vehicle.id), "token-revoked", { tokenId });
  }
  return NextResponse.json({ token: { id: issued.id, link: driverLink(issued.raw) } }, { status: 201 });
}
