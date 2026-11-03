import { timingSafeEqual } from "crypto";

/**
 * Scheduled jobs are authenticated with CRON_SECRET (Vercel Cron sends it as "Authorization: Bearer <secret>"
 * automatically when the variable is set). A missing or short secret disables the endpoints entirely.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}
