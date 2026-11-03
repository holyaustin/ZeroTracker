import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { runRetention } from "@/lib/retention";
import { sweepDisconnected } from "@/lib/fleet";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Daily: delete expired location history / incidents / secrets, and catch any vehicle the live sweep missed. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await runRetention();
  const disconnected = await sweepDisconnected();
  return NextResponse.json({ ok: true, ...result, disconnected });
}
