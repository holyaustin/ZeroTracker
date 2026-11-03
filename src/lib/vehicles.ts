import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newRawToken } from "@/lib/driver";
import { sha256 } from "@/lib/auth";

export type VehicleRow = {
  id: string; label: string; plateNumber: string | null; driverName: string | null; createdAt: string;
  activeToken: { id: string; createdAt: string; lastSeenAt: string | null } | null;
};

/** Never returns token hashes or raw tokens. Scoped to one organization. */
export async function listVehicles(orgId: string): Promise<VehicleRow[]> {
  const v = schema.vehicles, t = schema.driverTokens;
  const rows = await db.select({ v, t }).from(v)
    .leftJoin(t, and(eq(t.vehicleId, v.id), eq(t.status, "ACTIVE")))
    .where(eq(v.orgId, orgId)).orderBy(desc(v.createdAt));
  return rows.map(({ v, t }) => ({
    id: v.id, label: v.label, plateNumber: v.plateNumber, driverName: v.driverName, createdAt: v.createdAt.toISOString(),
    activeToken: t ? { id: t.id, createdAt: t.createdAt.toISOString(), lastSeenAt: t.lastSeenAt?.toISOString() ?? null } : null,
  }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Revokes any ACTIVE link for the vehicle and issues a new one. The raw token is returned once. */
export async function issueToken(tx: Tx, orgId: string, vehicleId: string) {
  const t = schema.driverTokens;
  const revoked = await tx.update(t).set({ status: "REVOKED", revokedAt: new Date() })
    .where(and(eq(t.vehicleId, vehicleId), eq(t.orgId, orgId), eq(t.status, "ACTIVE"))).returning({ id: t.id });
  const raw = newRawToken();
  const [row] = await tx.insert(t).values({ vehicleId, orgId, tokenHash: sha256(raw) }).returning({ id: t.id });
  return { id: row.id, raw, revokedIds: revoked.map((r) => r.id) };
}
