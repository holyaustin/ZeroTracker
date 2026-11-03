import { headers } from "next/headers";
import { authenticateDriver } from "@/lib/driver";
import DriverLocked from "@/components/DriverLocked";
import DriverNode from "@/components/DriverNode";

export const dynamic = "force-dynamic";
// The token is in the URL, so never index it and never leak it through the Referer header.
export const metadata = { title: "ZeroTracker Driver", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function DriverPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  const a = await authenticateDriver(token, ip);
  if (!a.ok) return <DriverLocked code={a.code} />;
  return (
    <DriverNode token={token} tokenId={a.tokenId} vehicleId={a.vehicleId} label={a.label} orgName={a.orgName}
      realtime={process.env.REALTIME_DRIVER !== "console"} pollMs={Number(process.env.STATUS_POLL_MS ?? 15000)} />
  );
}
