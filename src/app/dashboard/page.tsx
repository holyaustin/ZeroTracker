import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSession } from "@/lib/auth";
import { channels } from "@/lib/realtime";
import Logo from "@/components/Logo";
import LogoutButton from "@/components/LogoutButton";
import StatusBadge from "@/components/StatusBadge";
import LiveStatus from "@/components/LiveStatus";
import VerificationWizard from "@/components/VerificationWizard";
import FleetManager from "@/components/FleetManager";
import LiveFleet from "@/components/LiveFleet";
import { listVehicles } from "@/lib/vehicles";
import { getLiveFleet } from "@/lib/fleet";

export const metadata = { title: "Dashboard — ZeroTracker", robots: { index: false } };
export const dynamic = "force-dynamic";

function Banner({ tone, title, children }: { tone: "amber" | "emerald" | "rose" | "orange"; title: string; children: React.ReactNode }) {
  const t = { amber: "bg-amber-400/10 text-amber-300 ring-amber-400/20", emerald: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
    rose: "bg-rose-400/10 text-rose-300 ring-rose-400/20", orange: "bg-orange-400/10 text-orange-300 ring-orange-400/20" }[tone];
  return (
    <div className="flex items-start gap-4">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ${t}`}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {tone === "emerald" ? <path d="m5 12 5 5 9-10" /> : tone === "amber" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> : <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>}
        </svg>
      </span>
      <div><h2 className="font-semibold text-white">{title}</h2><div className="mt-1 max-w-xl text-sm leading-relaxed text-slate-400">{children}</div></div>
    </div>
  );
}

export default async function Dashboard() {
  const s = await getSession();
  if (!s || s.role !== "manager") redirect("/login");
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, s.orgId)).limit(1);
  if (!org) redirect("/login");
  const [profile] = await db.select().from(schema.companyProfiles).where(eq(schema.companyProfiles.orgId, org.id)).limit(1);

  return (
    <>
      <LiveStatus channel={channels.account(org.id)} pollUrl="/api/company/profile" sig={org.status}
        pollMs={Number(process.env.STATUS_POLL_MS ?? 15000)} realtime={process.env.REALTIME_DRIVER !== "console"} />
      <header className="border-b border-white/5 bg-slate-950/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <Logo href="/dashboard" />
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-400 sm:inline">{org.name}</span>
            <StatusBadge status={org.status} />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-10">
        <p className="text-sm text-slate-400">Command dashboard</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Welcome, {org.name}</h1>

        <section className="mt-8 rounded-2xl border border-white/10 bg-slate-900/50 p-6">
          {(org.status === "UNVERIFIED" || org.status === "REJECTED") && (
            <div className="space-y-6">
              {org.status === "REJECTED" ? (
                <Banner tone="rose" title="Your verification was not approved">
                  <p>Please correct your details and submit again.</p>
                  {profile?.reviewNote && <p className="mt-2 rounded-lg bg-white/5 px-3 py-2 text-slate-200">Reviewer note: {profile.reviewNote}</p>}
                </Banner>
              ) : (
                <Banner tone="amber" title="Verify your company to begin">
                  <p>Vehicle and driver-link provisioning is locked until your company profile is submitted and approved.</p>
                </Banner>
              )}
              <div className="border-t border-white/5 pt-6"><VerificationWizard /></div>
            </div>
          )}

          {org.status === "PENDING" && (
            <div className="space-y-5">
              <Banner tone="amber" title="Your profile is under review">
                <p>Our team is reviewing your details. This page unlocks automatically the moment you are approved. No refresh needed.</p>
              </Banner>
              {profile && (
                <dl className="grid gap-x-8 gap-y-3 border-t border-white/5 pt-5 text-sm sm:grid-cols-2">
                  {([["CAC / BN number", profile.cacOrBnNumber], ["WhatsApp", profile.whatsappNumber], ["Category", profile.operationCategory],
                    ["Estimated fleet", String(profile.estimatedFleetSize)], ["HQ address", profile.hqAddress]] as const).map(([k, v]) => (
                    <div key={k}><dt className="text-xs uppercase tracking-wider text-slate-500">{k}</dt><dd className="mt-0.5 text-slate-200">{v}</dd></div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {org.status === "APPROVED" && (
            <Banner tone="emerald" title="You're approved">
              <p>Your company is verified. Vehicle and driver-link provisioning is now unlocked.</p>
            </Banner>
          )}

          {org.status === "SUSPENDED" && (
            <Banner tone="orange" title="Account suspended">
              <p>Provisioning is disabled and driver links are inactive. Contact ZeroTracker support to resolve this.</p>
              {profile?.reviewNote && <p className="mt-2 rounded-lg bg-white/5 px-3 py-2 text-slate-200">Reason: {profile.reviewNote}</p>}
            </Banner>
          )}
        </section>
        {org.status === "APPROVED" && (
          <>
            <LiveFleet orgId={org.id} initialVehicles={await getLiveFleet(org.id)} pollMs={Number(process.env.STATUS_POLL_MS ?? 15000)} realtime={process.env.REALTIME_DRIVER !== "console"} />
            <FleetManager initial={await listVehicles(org.id)} />
          </>
        )}
      </main>
    </>
  );
}
