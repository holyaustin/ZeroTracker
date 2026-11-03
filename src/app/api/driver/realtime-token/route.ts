import { NextResponse } from "next/server";
import { driverAuthFromRequest, driverError } from "@/lib/driver";
import { subscribeToken } from "@/lib/realtime";

/** Short-lived, subscribe-only token for the driver's own vehicle channel (used to receive token-revoked). */
export async function POST(req: Request) {
  const a = await driverAuthFromRequest(req);
  if (!a.ok) return driverError(a);
  const token = await subscribeToken(`driver:${a.tokenId}`, [`vehicle:${a.vehicleId}`], 10 * 60 * 1000);
  return NextResponse.json(token, { headers: { "Cache-Control": "no-store" } });
}
