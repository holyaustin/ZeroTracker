import { NextResponse } from "next/server";
import { and, desc, eq, ilike, or, SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { isOwner, unauthorized } from "@/lib/auth";

const STATUSES = ["UNVERIFIED", "PENDING", "APPROVED", "SUSPENDED", "REJECTED"] as const;

export async function GET(req: Request) {
  if (!(await isOwner())) return unauthorized();
  const url = new URL(req.url);
  const status = url.searchParams.get("status")?.toUpperCase();
  const q = url.searchParams.get("q")?.trim().slice(0, 100);
  const o = schema.organizations, c = schema.companyProfiles;

  const conds: SQL[] = [];
  if (status) {
    if (!(STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
    conds.push(eq(o.status, status as (typeof STATUSES)[number]));
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    conds.push(or(ilike(o.name, like), ilike(o.email, like), ilike(c.cacOrBnNumber, like))!);
  }

  const rows = await db.select({ org: o, profile: c }).from(o).leftJoin(c, eq(c.orgId, o.id))
    .where(conds.length ? and(...conds) : undefined).orderBy(desc(o.createdAt)).limit(200);

  return NextResponse.json({
    companies: rows.map(({ org, profile }) => ({
      id: org.id, name: org.name, email: org.email, status: org.status, createdAt: org.createdAt,
      profile: profile && {
        cacOrBnNumber: profile.cacOrBnNumber, whatsappNumber: profile.whatsappNumber, hqAddress: profile.hqAddress,
        estimatedFleetSize: profile.estimatedFleetSize, operationCategory: profile.operationCategory,
        submittedAt: profile.submittedAt, reviewedAt: profile.reviewedAt, reviewNote: profile.reviewNote,
      },
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
