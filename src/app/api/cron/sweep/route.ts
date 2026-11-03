import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { sweepDisconnected } from "@/lib/fleet";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/** Every minute: mark vehicles silent for 60 s as disconnected, for ALL companies (managers' reads also sweep their own). */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, disconnected: await sweepDisconnected() });
}
