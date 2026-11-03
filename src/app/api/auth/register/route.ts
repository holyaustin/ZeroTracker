import { NextResponse } from "next/server";
import { limit, hit, tooMany } from "@/lib/ratelimit";
import { z } from "zod";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { generateAccessKey, hashSecret } from "@/lib/auth";
import { sendAccessKeyEmail } from "@/lib/email";

const Body = z.object({ name: z.string().min(2).max(120), email: z.string().email().toLowerCase() });

export async function POST(req: Request) {
  const rl = await limit(req, "register", 10, 3600); if (rl) return rl;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { name, email } = p.data;

  const [exists] = await db.select({ id: schema.organizations.id }).from(schema.organizations)
    .where(eq(schema.organizations.email, email)).limit(1);
  if (exists) return NextResponse.json({ error: "Email already registered" }, { status: 409 });

  const key = generateAccessKey();
  await db.insert(schema.organizations).values({ name, email, passwordHash: await hashSecret(key) });
  try { await sendAccessKeyEmail(email, name, key); }
  catch { return NextResponse.json({ error: "Registered, but email failed. Use 'forgot key'." }, { status: 502 }); }
  return NextResponse.json({ ok: true, message: "Access key sent to your email." }, { status: 201 });
}
