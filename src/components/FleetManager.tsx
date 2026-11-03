"use client";
import { useState } from "react";
import type { VehicleRow } from "@/lib/vehicles";

const input = "w-full rounded-xl border border-white/10 bg-slate-950/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-emerald-400/60 focus:ring-4 focus:ring-emerald-400/10";

function ago(iso: string | null) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}

export default function FleetManager({ initial }: { initial: VehicleRow[] }) {
  const [vehicles, setVehicles] = useState(initial);
  const [form, setForm] = useState({ label: "", plateNumber: "", driverName: "" });
  const [reveal, setReveal] = useState<{ label: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "revoke" | "regen"; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/vehicles", { cache: "no-store" }).catch(() => null);
    if (r?.ok) setVehicles((await r.json()).vehicles);
  }
  async function call(url: string, init: RequestInit) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Something went wrong."); return null; }
      return j;
    } catch { setError("Network error. Try again."); return null; }
    finally { setBusy(false); setConfirm(null); }
  }
  function show(label: string, link: string) { setReveal({ label, link }); setCopied(false); }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const j = await call("/api/vehicles", { method: "POST", body: JSON.stringify(form) });
    if (j) { show(j.vehicle.label, j.token.link); setForm({ label: "", plateNumber: "", driverName: "" }); await refresh(); }
  }
  async function regen(v: VehicleRow) {
    const j = await call(`/api/vehicles/${v.id}/token`, { method: "POST" });
    if (j) { show(v.label, j.token.link); await refresh(); }
  }
  async function revoke(v: VehicleRow) {
    if (!v.activeToken) return;
    const j = await call(`/api/tokens/${v.activeToken.id}`, { method: "DELETE" });
    if (j) { if (reveal?.label === v.label) setReveal(null); await refresh(); }
  }

  const waText = (r: { label: string; link: string }) =>
    `https://wa.me/?text=${encodeURIComponent(`Open this link on your phone to share your trip location for ${r.label}: ${r.link}`)}`;

  return (
    <section className="mt-8 rounded-2xl border border-white/10 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-white">Fleet &amp; driver links</h2>
      <p className="mt-1 text-sm text-slate-400">Add a vehicle to get a private link. The driver opens it on their phone and taps Start. No app or account needed.</p>

      <form onSubmit={add} className="mt-5 grid gap-3 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
        <input aria-label="Vehicle label" className={input} placeholder="Vehicle label, e.g. Truck 01" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required maxLength={60} />
        <input aria-label="Plate number" className={input} placeholder="Plate number (optional)" value={form.plateNumber} onChange={(e) => setForm({ ...form, plateNumber: e.target.value })} maxLength={20} />
        <input aria-label="Driver name" className={input} placeholder="Driver name (optional)" value={form.driverName} onChange={(e) => setForm({ ...form, driverName: e.target.value })} maxLength={80} />
        <button disabled={busy || !form.label.trim()} className="rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:opacity-50">Add vehicle</button>
      </form>

      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</p>}

      {reveal && (
        <div data-testid="link-reveal" className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-4">
          <p className="text-sm font-medium text-emerald-200">Driver link for {reveal.label}</p>
          <p className="mt-0.5 text-xs text-slate-400">Copy it now. For security this link is shown only once. If you lose it, create a new one.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input readOnly aria-label="Driver link" value={reveal.link} onFocus={(e) => e.currentTarget.select()} className={`${input} font-mono text-xs`} />
            <button onClick={async () => { setCopied(await copy(reveal.link)); }} className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-slate-200">{copied ? "Copied ✓" : "Copy link"}</button>
            <a href={waText(reveal)} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm font-medium text-slate-200 hover:bg-white/10">WhatsApp</a>
          </div>
          <button onClick={() => setReveal(null)} className="mt-3 text-xs text-slate-500 hover:text-slate-300">Dismiss</button>
        </div>
      )}

      <div className="mt-6 space-y-3">
        {vehicles.length === 0 && <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">No vehicles yet. Add your first one above.</p>}
        {vehicles.map((v) => (
          <article key={v.id} data-vehicle={v.label} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/40 p-4">
            <div className="min-w-0">
              <p className="truncate font-medium text-white">{v.label}{v.plateNumber && <span className="ml-2 rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-xs text-slate-300">{v.plateNumber}</span>}</p>
              <p className="mt-0.5 text-xs text-slate-500">{v.driverName ? `Driver: ${v.driverName} · ` : ""}{v.activeToken ? `Link active · last seen ${ago(v.activeToken.lastSeenAt)}` : "No active link"}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${v.activeToken ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30" : "bg-slate-500/10 text-slate-400 ring-slate-400/30"}`}>{v.activeToken ? "Active" : "Revoked"}</span>
              {confirm?.id === v.id ? (
                <>
                  <button disabled={busy} onClick={() => (confirm.kind === "revoke" ? revoke(v) : regen(v))} className="rounded-lg bg-rose-500/90 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50">{confirm.kind === "revoke" ? "Confirm revoke" : "Confirm replace"}</button>
                  <button onClick={() => setConfirm(null)} className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5">Cancel</button>
                </>
              ) : (
                <>
                  <button disabled={busy} onClick={() => (v.activeToken ? setConfirm({ kind: "regen", id: v.id }) : regen(v))} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-50">New link</button>
                  {v.activeToken && <button disabled={busy} aria-label={`Revoke link for ${v.label}`} title="Revoke link" onClick={() => setConfirm({ kind: "revoke", id: v.id })} className="grid h-8 w-8 place-items-center rounded-lg border border-rose-400/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 disabled:opacity-50">✕</button>}
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
