import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { channels, publish } from "@/lib/realtime";

/** Instant revocation. Allowed even while suspended: cutting off a driver is never blocked by the gate. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid token id" }, { status: 400 });

  const t = schema.driverTokens;
  const outcome = await db.transaction(async (tx) => {
    const [mine] = await tx.select({ status: t.status, vehicleId: t.vehicleId }).from(t)
      .where(and(eq(t.id, id), eq(t.orgId, orgId))).limit(1);
    if (!mine) return { kind: "missing" as const };              // also covers other tenants' tokens
    if (mine.status === "REVOKED") return { kind: "already" as const };
    await tx.update(t).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(t.id, id));
    await tx.update(schema.vehicleStatus).set({ online: false }).where(eq(schema.vehicleStatus.vehicleId, mine.vehicleId));
    await tx.insert(schema.auditLog).values({ actor: `manager:${orgId}`, action: "TOKEN_REVOKED", targetId: id, note: "Revoked by manager" });
    return { kind: "ok" as const, vehicleId: mine.vehicleId };
  });

  if (outcome.kind === "missing") return NextResponse.json({ error: "Link not found" }, { status: 404 });
  if (outcome.kind === "already") return NextResponse.json({ error: "This link is already revoked." }, { status: 409 });

  await publish(channels.vehicle(outcome.vehicleId), "token-revoked", { tokenId: id });     // locks out the driver's client
  await publish(channels.fleet(orgId), "vehicle-removed", { vehicleId: outcome.vehicleId }); // wipes it from the live map
  return NextResponse.json({ ok: true });
}
