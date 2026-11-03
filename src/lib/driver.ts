import crypto from "crypto";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sha256 } from "@/lib/auth";
import { clientIp, hit } from "@/lib/ratelimit";

export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
/** 192 bits of entropy, URL-safe. Only its SHA-256 is ever stored. */
export const newRawToken = () => crypto.randomBytes(24).toString("base64url");
export const driverLink = (raw: string) => `${process.env.APP_URL}/d/${raw}`;

export type DriverCode = "INVALID" | "REVOKED" | "ORG_DISABLED" | "RATE_LIMITED";
export type DriverAuth =
  | { ok: true; tokenId: string; vehicleId: string; orgId: string; label: string; orgName: string }
  | { ok: false; status: 401 | 403 | 410 | 429; code: DriverCode };

const MESSAGES: Record<DriverCode, string> = {
  INVALID: "This tracking link is not valid.",
  REVOKED: "Access revoked by your manager.",
  ORG_DISABLED: "Tracking is currently disabled for your company.",
  RATE_LIMITED: "Too many attempts. Try again in a few minutes.",
};
export const driverError = (a: Extract<DriverAuth, { ok: false }>) =>
  NextResponse.json({ error: MESSAGES[a.code], code: a.code }, { status: a.status });

/** Failed lookups are counted per IP so tokens can't be guessed by brute force. */
async function failure(ip: string): Promise<DriverAuth> {
  const allowed = await hit(`driver-fail:${ip}`, 30, 600);
  return allowed ? { ok: false, status: 401, code: "INVALID" } : { ok: false, status: 429, code: "RATE_LIMITED" };
}

/**
 * Authenticates a driver by token-hash lookup. Rejects unknown and REVOKED tokens, and tokens of any
 * organization that is not currently APPROVED (suspended, rejected, ...). Status is read from the
 * database on every call, so revocation and suspension take effect immediately.
 */
export async function authenticateDriver(raw: string | null | undefined, ip: string): Promise<DriverAuth> {
  if (!raw || !TOKEN_RE.test(raw)) return failure(ip);
  const [row] = await db.select({
    tokenId: schema.driverTokens.id, tokenStatus: schema.driverTokens.status,
    vehicleId: schema.vehicles.id, label: schema.vehicles.label,
    orgId: schema.organizations.id, orgName: schema.organizations.name, orgStatus: schema.organizations.status,
  }).from(schema.driverTokens)
    .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.driverTokens.vehicleId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.driverTokens.orgId))
    .where(eq(schema.driverTokens.tokenHash, sha256(raw))).limit(1);

  if (!row) return failure(ip);
  if (row.tokenStatus === "REVOKED") return { ok: false, status: 410, code: "REVOKED" };
  if (row.orgStatus !== "APPROVED") return { ok: false, status: 403, code: "ORG_DISABLED" };
  if (!(await hit(`driver:${row.tokenId}`, 60, 60))) return { ok: false, status: 429, code: "RATE_LIMITED" };

  await db.execute(sql`UPDATE driver_tokens SET last_seen_at = now()
    WHERE id = ${row.tokenId} AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds')`);
  return { ok: true, tokenId: row.tokenId, vehicleId: row.vehicleId, orgId: row.orgId, label: row.label, orgName: row.orgName };
}

export const driverAuthFromRequest = (req: Request) =>
  authenticateDriver(req.headers.get("x-driver-token"), clientIp(req));
