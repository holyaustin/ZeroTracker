import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { managerOrgId, unauthorized } from "@/lib/auth";
import { ProfileInput } from "@/lib/validation";
import { limit } from "@/lib/ratelimit";
import { channels, publish } from "@/lib/realtime";

export async function GET() {
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  if (!org) return unauthorized();
  const [profile] = await db.select().from(schema.companyProfiles).where(eq(schema.companyProfiles.orgId, orgId)).limit(1);
  return NextResponse.json(
    { status: org.status, sig: org.status, profile: profile ?? null, reviewNote: profile?.reviewNote ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const rl = await limit(req, "profile", 10, 3600); if (rl) return rl;
  const orgId = await managerOrgId();
  if (!orgId) return unauthorized();

  const p = ProfileInput.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Please correct the highlighted fields.", fields: p.error.flatten().fieldErrors }, { status: 400 });

  const result = await db.transaction(async (tx) => {
    // Atomic claim: only UNVERIFIED or REJECTED companies may (re)submit.
    const [org] = await tx.update(schema.organizations).set({ status: "PENDING" })
      .where(and(eq(schema.organizations.id, orgId), inArray(schema.organizations.status, ["UNVERIFIED", "REJECTED"])))
      .returning({ name: schema.organizations.name });
    if (!org) return null;
    const values = { ...p.data, submittedAt: new Date(), reviewedBy: null, reviewedAt: null, reviewNote: null };
    await tx.insert(schema.companyProfiles).values({ orgId, ...values })
      .onConflictDoUpdate({ target: schema.companyProfiles.orgId, set: values });
    return org;
  });
  if (!result) return NextResponse.json({ error: "Your profile can't be submitted in its current state." }, { status: 409 });

  await publish(channels.owner, "company-submitted", { orgId, name: result.name });
  await publish(channels.account(orgId), "company-status-updated", { status: "PENDING" });
  return NextResponse.json({ ok: true, status: "PENDING" });
}
