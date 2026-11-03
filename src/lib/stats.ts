import { count, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export type Stats = {
  total: number; unverified: number; pending: number; approved: number;
  suspended: number; rejected: number; vehicles: number;
};

export async function getStats(): Promise<Stats> {
  const rows = await db.select({ status: schema.organizations.status, n: count() })
    .from(schema.organizations).groupBy(schema.organizations.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const [{ v }] = await db.select({ v: sql<number>`count(*)::int` }).from(schema.vehicles);
  return {
    total: rows.reduce((a, r) => a + Number(r.n), 0),
    unverified: by.UNVERIFIED ?? 0, pending: by.PENDING ?? 0, approved: by.APPROVED ?? 0,
    suspended: by.SUSPENDED ?? 0, rejected: by.REJECTED ?? 0, vehicles: v,
  };
}
export const statsSig = (s: Stats) => `${s.total}:${s.unverified}:${s.pending}:${s.approved}:${s.suspended}:${s.rejected}`;
