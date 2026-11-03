"use client";
import { useEffect, useState } from "react";

type Entry = { id: number; actor: string; action: string; note: string | null; ts: number; company: string | null };
const TONE: Record<string, string> = { COMPANY_APPROVED: "text-emerald-300", COMPANY_REJECTED: "text-rose-300", COMPANY_SUSPENDED: "text-orange-300", TOKEN_REVOKED: "text-amber-300" };

export default function AuditLog({ sig }: { sig: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/owner/audit?limit=30", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j) setEntries(j.entries); }).catch(() => {});
    return () => { live = false; };
  }, [sig]);
  return (
    <section className="mt-10" data-testid="audit">
      <h2 className="text-lg font-semibold text-white">Audit log</h2>
      <p className="mt-1 text-sm text-slate-400">Every owner decision and every driver-link revocation.</p>
      <ol className="mt-4 divide-y divide-white/5 rounded-2xl border border-white/10 bg-slate-900/50">
        {entries === null && <li className="p-6 text-sm text-slate-500">Loading…</li>}
        {entries?.length === 0 && <li className="p-6 text-sm text-slate-500">Nothing recorded yet.</li>}
        {entries?.map((e) => (
          <li key={e.id} data-action={e.action} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-sm">
            <span className="w-40 shrink-0 font-mono text-xs text-slate-500">{new Date(e.ts).toLocaleString()}</span>
            <span className={`font-medium ${TONE[e.action] ?? "text-slate-200"}`}>{e.action.replace(/_/g, " ").toLowerCase()}</span>
            <span className="text-slate-300">{e.company ?? ""}</span>
            <span className="text-xs text-slate-500">by {e.actor.startsWith("manager:") ? "manager" : e.actor}</span>
            {e.note && <span className="basis-full text-slate-400">“{e.note}”</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
