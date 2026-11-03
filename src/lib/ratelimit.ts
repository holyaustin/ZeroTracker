import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Fixed-window limiter stored in Postgres, so it holds across serverless instances. */
export async function hit(key: string, max: number, windowSec: number): Promise<boolean> {
  const r = await db.execute(sql`
    INSERT INTO rate_limits (key, count, window_start) VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec}::float8)
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSec}::float8)
                          THEN now() ELSE rate_limits.window_start END
    RETURNING count`);
  return Number((r.rows[0] as { count: number }).count) <= max;
}

export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

export const tooMany = (windowSec: number) =>
  NextResponse.json({ error: "Too many attempts. Please try again later." },
    { status: 429, headers: { "Retry-After": String(windowSec) } });

/** Returns a 429 response when the caller is over the limit, otherwise null. */
export async function limit(req: Request, name: string, max: number, windowSec: number) {
  return (await hit(`${name}:${clientIp(req)}`, max, windowSec)) ? null : tooMany(windowSec);
}
