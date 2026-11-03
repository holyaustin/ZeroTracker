import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { isOwner, unauthorized } from "@/lib/auth";
import { channels, publish } from "@/lib/realtime";

const Body = z.object({
  action: z.enum(["APPROVE", "REJECT", "SUSPEND"]),
  note: z.string().trim().max(500).optional(),
}).refine((b) => b.action === "APPROVE" || (b.note && b.note.length >= 3), {
  message: "A note is required when rejecting or suspending.", path: ["note"],
});

type Status = "UNVERIFIED" | "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED";
const RULES: Record<"APPROVE" | "REJECT" | "SUSPEND", { to: Status; from: Status[]; audit: string }> = {
  APPROVE: { to: "APPROVED", from: ["PENDING", "SUSPENDED", "REJECTED"], audit: "COMPANY_APPROVED" },
  REJECT: { to: "REJECTED", from: ["PENDING"], audit: "COMPANY_REJECTED" },
  SUSPEND: { to: "SUSPENDED", from: ["APPROVED", "PENDING"], audit: "COMPANY_SUSPENDED" },
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isOwner())) return unauthorized();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid company id" }, { status: 400 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message, fields: p.error.flatten().fieldErrors }, { status: 400 });

  const rule = RULES[p.data.action];
  const note = p.data.note || null;
  const o = schema.organizations;

  type Outcome = { kind: "ok" } | { kind: "missing" } | { kind: "conflict"; status: string };
  const outcome: Outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [updated] = await tx.update(o).set({ status: rule.to })
      .where(and(eq(o.id, id), inArray(o.status, rule.from))).returning({ name: o.name });
    if (!updated) {
      const [exists] = await tx.select({ status: o.status }).from(o).where(eq(o.id, id)).limit(1);
      return exists ? { kind: "conflict", status: exists.status } : { kind: "missing" };
    }
    await tx.update(schema.companyProfiles)
      .set({ reviewedBy: "owner", reviewedAt: new Date(), reviewNote: note })
      .where(eq(schema.companyProfiles.orgId, id));
    await tx.insert(schema.auditLog).values({ actor: "owner", action: rule.audit, targetId: id, note });
    return { kind: "ok" };
  });

  if (outcome.kind === "missing") return NextResponse.json({ error: "Company not found" }, { status: 404 });
  if (outcome.kind === "conflict")
    return NextResponse.json({ error: `Cannot ${p.data.action.toLowerCase()} a company that is ${outcome.status.toLowerCase()}.` }, { status: 409 });

  // Publish only after the change is committed.
  await publish(channels.account(id), "company-status-updated", { status: rule.to, note });
  await publish(channels.owner, "company-updated", { orgId: id, status: rule.to });
  return NextResponse.json({ ok: true, status: rule.to });
}
