import { NextResponse } from "next/server";
import { limit, hit, tooMany } from "@/lib/ratelimit";
import { z } from "zod";
import { createSession, verifySecret } from "@/lib/auth";

const Body = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1) });

export async function POST(req: Request) {
  const rl = await limit(req, "owner-login", 5, 900); if (rl) return rl;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const okEmail = p.data.email === process.env.OWNER_EMAIL?.toLowerCase();
  const okPass = await verifySecret(p.data.password, process.env.OWNER_PASSWORD_HASH ?? "");
  if (!okEmail || !okPass) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  await createSession({ role: "owner" });
  return NextResponse.json({ ok: true });
}
