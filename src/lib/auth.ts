import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const COOKIE = "zt_session";
const secret = () => new TextEncoder().encode(process.env.JWT_SECRET!);

export type Session = { role: "manager"; orgId: string } | { role: "owner" };

export async function createSession(s: Session) {
  const jwt = await new SignJWT({ ...s }).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt().setExpirationTime("7d").sign(secret());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSession(): Promise<Session | null> {
  const c = (await cookies()).get(COOKIE)?.value;
  if (!c) return null;
  try { return (await jwtVerify(c, secret())).payload as unknown as Session; } catch { return null; }
}

export async function clearSession() { (await cookies()).delete(COOKIE); }

/** orgId ALWAYS comes from the verified JWT, never from client input. Returns null when not a manager. */
export async function managerOrgId(): Promise<string | null> {
  const s = await getSession();
  return s && s.role === "manager" ? s.orgId : null;
}
export async function isOwner(): Promise<boolean> {
  const s = await getSession();
  return !!s && s.role === "owner";
}
export const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export const generateAccessKey = () => "ZT-" + crypto.randomBytes(24).toString("base64url");
export const hashSecret = (v: string) => bcrypt.hash(v, 12);
export const verifySecret = (v: string, h: string) => bcrypt.compare(v, h);
export const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
