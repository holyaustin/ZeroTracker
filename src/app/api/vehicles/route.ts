import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { requireApproved } from "@/lib/gate";
import { hit, tooMany } from "@/lib/ratelimit";
import { driverLink } from "@/lib/driver";
import { issueToken, listVehicles } from "@/lib/vehicles";
import { channels, publish } from "@/lib/realtime";

const Input = z.object({
  label: z.string().trim().min(1, "Enter a vehicle label").max(60, "Keep the label under 60 characters"),
  plateNumber: z.string().trim().max(20, "Plate number is too long").optional().transform((v) => (v ? v.toUpperCase() : null)),
  driverName: z.string().trim().max(80, "Driver name is too long").optional().transform((v) => v || null),
});
const MAX_VEHICLES = 1000;

export async function GET() {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  return NextResponse.json({ vehicles: await listVehicles(orgId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const blocked = await requireApproved(orgId); if (blocked) return blocked;   // server-side verification gate
  if (!(await hit(`vehicle-write:${orgId}`, 120, 3600))) return tooMany(3600);

  const p = Input.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message, fields: p.error.flatten().fieldErrors }, { status: 400 });
  const [{ n }] = await db.select({ n: count() }).from(schema.vehicles).where(eq(schema.vehicles.orgId, orgId));
  if (Number(n) >= MAX_VEHICLES) return NextResponse.json({ error: "Vehicle limit reached for this account." }, { status: 409 });

  const out = await db.transaction(async (tx) => {
    const [vehicle] = await tx.insert(schema.vehicles).values({ orgId, ...p.data }).returning();
    await tx.insert(schema.vehicleStatus).values({ vehicleId: vehicle.id, online: false });
    return { vehicle, token: await issueToken(tx, orgId, vehicle.id) };
  });

  await publish(channels.fleet(orgId), "vehicle-added", { vehicleId: out.vehicle.id });
  return NextResponse.json({
    vehicle: { id: out.vehicle.id, label: out.vehicle.label, plateNumber: out.vehicle.plateNumber, driverName: out.vehicle.driverName },
    token: { id: out.token.id, link: driverLink(out.token.raw) },   // the raw link is shown only this once
  }, { status: 201 });
}
