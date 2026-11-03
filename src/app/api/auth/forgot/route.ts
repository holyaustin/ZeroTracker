import { NextResponse } from "next/server";
import { limit, hit, tooMany } from "@/lib/ratelimit";
import crypto from "crypto";
import { z } from "zod";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { sha256 } from "@/lib/auth";
import { sendResetEmail } from "@/lib/email";

const Body = z.object({ email: z.string().email().toLowerCase() });

export async function POST(req: Request) {
  const rl = await limit(req, "forgot", 5, 900); if (rl) return rl;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (p.success) {
    const [org] = await db.select().from(schema.organizations)
      .where(eq(schema.organizations.email, p.data.email)).limit(1);
    if (org) {
      const token = crypto.randomBytes(32).toString("base64url");
      await db.insert(schema.passwordResets).values({
        orgId: org.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      await sendResetEmail(org.email, token).catch(() => {});
    }
  }
  // Always the same response (no account enumeration)
  return NextResponse.json({ ok: true, message: "If that email exists, a reset link was sent." });
}
