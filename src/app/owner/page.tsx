import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getStats, statsSig } from "@/lib/stats";
import { channels } from "@/lib/realtime";
import Logo from "@/components/Logo";
import LogoutButton from "@/components/LogoutButton";
import LiveStatus from "@/components/LiveStatus";
import OwnerCompanies from "@/components/OwnerCompanies";
import AuditLog from "@/components/AuditLog";

export const metadata = { title: "Owner Central Command — ZeroTracker", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function Owner() {
  const s = await getSession();
  if (!s || s.role !== "owner") redirect("/owner/login");
  const st = await getStats();
  const sig = statsSig(st);

  const kpis = [
    { l: "Registered companies", v: st.total, c: "text-white" },
    { l: "Pending approvals", v: st.pending, c: "text-amber-300" },
    { l: "Approved fleets", v: st.approved, c: "text-emerald-300" },
    { l: "Suspended", v: st.suspended, c: "text-orange-300" },
    { l: "Vehicles provisioned", v: st.vehicles, c: "text-cyan-300" },
  ];

  return (
    <>
      <LiveStatus channel={channels.owner} pollUrl="/api/owner/stats" sig={sig}
        pollMs={Number(process.env.STATUS_POLL_MS ?? 15000)} realtime={process.env.REALTIME_DRIVER !== "console"} />
      <header className="border-b border-white/5 bg-slate-950/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3"><Logo href="/owner" />
            <span className="rounded-md bg-emerald-400/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-400/20">Owner</span>
          </div>
          <LogoutButton to="/owner/login" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Platform overview</h1>
        <p className="mt-1 text-sm text-slate-400">Live totals across every company on ZeroTracker.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {kpis.map((k) => (
            <div key={k.l} className="rounded-2xl border border-white/10 bg-slate-900/50 p-5">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{k.l}</p>
              <p className={`mt-3 text-3xl font-semibold tabular-nums ${k.c}`}>{k.v}</p>
            </div>
          ))}
        </div>
        <OwnerCompanies sig={sig} />
        <AuditLog sig={sig} />
      </main>
    </>
  );
}
