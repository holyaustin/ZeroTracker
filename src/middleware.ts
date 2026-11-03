import { NextResponse, type NextRequest } from "next/server";

// Cookie-authenticated, state-changing API calls must come from this site. SameSite=Lax cookies already stop
// cross-site POSTs; this closes the remaining gaps (e.g. same-site subdomains, older browsers).
// Driver endpoints and cron are not cookie-authenticated (header token / bearer secret), so they are exempt.
const EXEMPT = [/^\/api\/driver\//, /^\/api\/telemetry/, /^\/api\/cron\//];

export function middleware(req: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return NextResponse.next();
  if (EXEMPT.some((r) => r.test(req.nextUrl.pathname))) return NextResponse.next();

  const allowed = new Set([req.nextUrl.origin]);
  try { if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin); } catch { /* ignore bad APP_URL */ }
  const origin = req.headers.get("origin");
  const crossSite = req.headers.get("sec-fetch-site") === "cross-site";
  if ((origin && !allowed.has(origin)) || (!origin && crossSite))
    return NextResponse.json({ error: "Cross-origin request blocked." }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
