import { NextResponse } from "next/server";
import { getSession, unauthorized } from "@/lib/auth";
import { channels, subscribeToken } from "@/lib/realtime";
import { limit } from "@/lib/ratelimit";

/** Issues a subscribe-only Ably token scoped to the caller's own channels. */
export async function POST(req: Request) {
  const rl = await limit(req, "rt-token", 60, 300); if (rl) return rl;
  const s = await getSession();
  if (!s) return unauthorized();
  const token = s.role === "manager"
    ? await subscribeToken(`manager:${s.orgId}`, [`org:${s.orgId}:*`])
    : await subscribeToken("owner", [channels.owner]);
  return NextResponse.json(token, { headers: { "Cache-Control": "no-store" } });
}
