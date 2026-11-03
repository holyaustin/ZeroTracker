import { NextResponse } from "next/server";
import { limit, hit, tooMany } from "@/lib/ratelimit";
import { z } from "zod";
import { db, schema } from "@/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashSecret, sha256 } from "@/lib/auth";

const Body = z.object({ token: z.string().min(20), newKey: z.string().min(12).max(128) });

export async function POST(req: Request) {
  const rl = await limit(req, "reset", 10, 900); if (rl) return rl;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const r = schema.passwordResets;
  const [row] = await db.select().from(r).where(and(
    eq(r.tokenHash, sha256(p.data.token)), isNull(r.usedAt), gt(r.expiresAt, new Date()),
  )).limit(1);
  if (!row) return NextResponse.json({ error: "Invalid or expired link" }, { status: 400 });
  await db.update(r).set({ usedAt: new Date() }).where(eq(r.id, row.id));
  await db.update(schema.organizations).set({ passwordHash: await hashSecret(p.data.newKey) })
    .where(eq(schema.organizations.id, row.orgId));
  return NextResponse.json({ ok: true, message: "Access key updated. You can now sign in with your new key." });
}
