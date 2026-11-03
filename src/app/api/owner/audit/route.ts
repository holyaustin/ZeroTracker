import { NextResponse } from "next/server";
import { desc, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { isOwner, unauthorized } from "@/lib/auth";

/** Recent audit entries (owner decisions and token revocations), with company names resolved where the target is a company. */
export async function GET(req: Request) {
  if (!(await isOwner())) return unauthorized();
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50));
  const rows = await db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.ts), desc(schema.auditLog.id)).limit(limit);
  const ids = [...new Set(rows.map((r) => r.targetId).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/.test(x)))];
  const orgs = ids.length ? await db.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations).where(inArray(schema.organizations.id, ids)) : [];
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  return NextResponse.json({
    entries: rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, note: r.note, ts: r.ts.getTime(), targetId: r.targetId, company: r.targetId ? names.get(r.targetId) ?? null : null })),
  }, { headers: { "Cache-Control": "no-store" } });
}
