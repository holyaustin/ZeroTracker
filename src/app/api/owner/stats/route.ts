import { NextResponse } from "next/server";
import { isOwner, unauthorized } from "@/lib/auth";
import { getStats, statsSig } from "@/lib/stats";

export async function GET() {
  if (!(await isOwner())) return unauthorized();
  const s = await getStats();
  return NextResponse.json({ ...s, sig: statsSig(s) }, { headers: { "Cache-Control": "no-store" } });
}
