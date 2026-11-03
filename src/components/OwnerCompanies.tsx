"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import StatusBadge from "./StatusBadge";

type Company = {
  id: string; name: string; email: string; status: string; createdAt: string;
  profile: null | { cacOrBnNumber: string; whatsappNumber: string; hqAddress: string; estimatedFleetSize: number;
    operationCategory: string; submittedAt: string; reviewedAt: string | null; reviewNote: string | null };
};
type Action = "APPROVE" | "REJECT" | "SUSPEND";
const TABS = ["ALL", "PENDING", "APPROVED", "SUSPENDED", "REJECTED", "UNVERIFIED"] as const;
const ALLOWED: Record<string, Action[]> = {
  PENDING: ["APPROVE", "REJECT", "SUSPEND"], APPROVED: ["SUSPEND"], SUSPENDED: ["APPROVE"], REJECTED: ["APPROVE"], UNVERIFIED: [],
};
const LABEL: Record<string, string> = { PENDING: "Pending", ALL: "All", APPROVED: "Approved", SUSPENDED: "Suspended", REJECTED: "Rejected", UNVERIFIED: "Unverified" };
const btn: Record<Action, string> = {
  APPROVE: "bg-emerald-400 text-slate-950 hover:bg-emerald-300",
  REJECT: "bg-rose-500/90 text-white hover:bg-rose-500",
  SUSPEND: "bg-orange-500/90 text-white hover:bg-orange-500",
};

export default function OwnerCompanies({ sig }: { sig: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>("ALL");
  const [q, setQ] = useState("");
  const [list, setList] = useState<Company[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; action: Action } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (tab !== "ALL") params.set("status", tab);
    if (q.trim()) params.set("q", q.trim());
    const r = await fetch(`/api/owner/companies?${params}`, { cache: "no-store" }).catch(() => null);
    if (r?.ok) setList((await r.json()).companies);
  }, [tab, q]);

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, sig]);

  async function act(id: string, action: Action, withNote?: string) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/owner/companies/${id}/status`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note: withNote }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Action failed."); return; }
      setPending(null); setNote(""); await load(); router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <section className="mt-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-white">Company verification</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or CAC…" aria-label="Search companies"
          className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-3.5 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:border-emerald-400/60 sm:w-72" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium ring-1 ring-inset transition ${tab === t ? "bg-white text-slate-950 ring-white" : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"}`}>{LABEL[t]}</button>
        ))}
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</p>}

      <div className="mt-4 space-y-3">
        {list === null && <p className="text-sm text-slate-500">Loading…</p>}
        {list?.length === 0 && <p className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">No companies match.</p>}
        {list?.map((c) => {
          const isOpen = open === c.id;
          const actions = ALLOWED[c.status] ?? [];
          return (
            <article key={c.id} data-company={c.name} className="rounded-2xl border border-white/10 bg-slate-900/50 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold text-white">{c.name}</h3>
                  <p className="truncate text-sm text-slate-400">{c.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={c.status} />
                  {c.profile && <button onClick={() => setOpen(isOpen ? null : c.id)} className="text-sm font-medium text-emerald-400 hover:text-emerald-300">{isOpen ? "Hide details" : "View details"}</button>}
                </div>
              </div>

              {isOpen && c.profile && (
                <dl className="mt-4 grid gap-x-8 gap-y-3 border-t border-white/5 pt-4 text-sm sm:grid-cols-2">
                  {([["CAC / BN number", c.profile.cacOrBnNumber], ["WhatsApp", c.profile.whatsappNumber], ["Category", c.profile.operationCategory],
                    ["Estimated fleet", String(c.profile.estimatedFleetSize)], ["HQ address", c.profile.hqAddress],
                    ["Submitted", new Date(c.profile.submittedAt).toLocaleString()]] as const).map(([k, val]) => (
                    <div key={k}><dt className="text-xs uppercase tracking-wider text-slate-500">{k}</dt><dd className="mt-0.5 text-slate-200">{val}</dd></div>
                  ))}
                  {c.profile.reviewNote && <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wider text-slate-500">Last review note</dt><dd className="mt-0.5 text-slate-200">{c.profile.reviewNote}</dd></div>}
                </dl>
              )}

              {actions.length > 0 && (
                <div className="mt-4 border-t border-white/5 pt-4">
                  {pending?.id === c.id ? (
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-slate-300" htmlFor={`note-${c.id}`}>Note to the company (required)</label>
                      <textarea id={`note-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Explain the decision…"
                        className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none focus:border-emerald-400/60" />
                      <div className="flex gap-2">
                        <button disabled={busy || note.trim().length < 3} onClick={() => act(c.id, pending.action, note)}
                          className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${btn[pending.action]}`}>Confirm {pending.action.toLowerCase()}</button>
                        <button onClick={() => { setPending(null); setNote(""); setError(null); }} className="rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-slate-300 hover:bg-white/5">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {actions.map((a) => (
                        <button key={a} disabled={busy}
                          onClick={() => (a === "APPROVE" ? act(c.id, a) : (setPending({ id: c.id, action: a }), setError(null)))}
                          className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${btn[a]}`}>
                          {a === "APPROVE" ? (c.status === "PENDING" ? "Approve" : "Reinstate") : a === "REJECT" ? "Reject" : "Suspend"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
