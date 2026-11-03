import { NextResponse } from "next/server";
import { limit, hit, tooMany } from "@/lib/ratelimit";
import { z } from "zod";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { createSession, verifySecret } from "@/lib/auth";

const Body = z.object({ email: z.string().email().toLowerCase(), accessKey: z.string().min(8) });

export async function POST(req: Request) {
  const rl = await limit(req, "login", 30, 900); if (rl) return rl;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  if (!(await hit(`login:${p.data.email}`, 8, 900))) return tooMany(900);
  const [org] = await db.select().from(schema.organizations)
    .where(eq(schema.organizations.email, p.data.email)).limit(1);
  // Same error for unknown email and wrong key
  if (!org || !(await verifySecret(p.data.accessKey, org.passwordHash)))
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  await createSession({ role: "manager", orgId: org.id });
  return NextResponse.json({ ok: true, status: org.status });
}
