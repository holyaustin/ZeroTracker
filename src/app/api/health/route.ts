import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/** Uptime check: confirms the app can reach the database. Reveals nothing else. */
export async function GET() {
  try { await db.execute(sql`SELECT 1`); return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
