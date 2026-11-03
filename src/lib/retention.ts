import { sql } from "drizzle-orm";
import { db } from "@/db";

export const RETENTION_DAYS = { telemetry: 30, incidents: 90 } as const;
const BATCH = 10_000;

/** Deletes in batches so a big backlog never holds a long lock; stops at the deadline and resumes on the next run. */
async function purge(table: "telemetry" | "incidents", days: number, deadline: number) {
  let total = 0;
  for (;;) {
    const r = await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE id IN (
      SELECT id FROM ${sql.raw(table)} WHERE ts < now() - make_interval(days => ${days}::int) LIMIT ${BATCH})`);
    const n = r.rowCount ?? 0;
    total += n;
    if (n < BATCH || Date.now() > deadline) return total;
  }
}

/** Data-retention job: location history 30 days, incident log 90 days, plus housekeeping of expired secrets and counters. */
export async function runRetention(budgetMs = 45_000) {
  const t0 = Date.now(), deadline = t0 + budgetMs;
  const telemetry = await purge("telemetry", RETENTION_DAYS.telemetry, deadline);
  const incidents = await purge("incidents", RETENTION_DAYS.incidents, deadline);
  const pr = await db.execute(sql`DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at < now() - interval '1 day'`);
  const rl = await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  return { telemetry, incidents, passwordResets: pr.rowCount ?? 0, rateLimits: rl.rowCount ?? 0, durationMs: Date.now() - t0 };
}
