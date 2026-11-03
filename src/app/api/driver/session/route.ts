import { NextResponse } from "next/server";
import { driverAuthFromRequest, driverError } from "@/lib/driver";

/** Driver clients call this to (re)validate their token. 401/403/410 mean "stop tracking now". */
export async function POST(req: Request) {
  const a = await driverAuthFromRequest(req);
  if (!a.ok) return driverError(a);
  return NextResponse.json(
    { ok: true, tokenId: a.tokenId, vehicle: { id: a.vehicleId, label: a.label }, org: { name: a.orgName }, now: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
