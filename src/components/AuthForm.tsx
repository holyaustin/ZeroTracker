"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Field = { name: string; label: string; type?: string; placeholder?: string; autoComplete?: string; hint?: string };

export default function AuthForm({ endpoint, fields, submit, redirect, hidden }: {
  endpoint: string; fields: Field[]; submit: string; redirect?: string; hidden?: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { ...hidden, ...Object.fromEntries(new FormData(e.currentTarget)) };
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Something went wrong. Please try again."); return; }
      if (redirect) { router.push(redirect); router.refresh(); return; }
      setDone(json.message ?? "Done.");
    } catch { setError("Network error. Check your connection and try again."); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm leading-relaxed text-emerald-200">
        {done}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {fields.map((f) => (
        <div key={f.name}>
          <label htmlFor={f.name} className="mb-1.5 block text-sm font-medium text-slate-300">{f.label}</label>
          <input
            id={f.name} name={f.name} type={f.type ?? "text"} required placeholder={f.placeholder}
            autoComplete={f.autoComplete}
            className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-emerald-400/60 focus:ring-4 focus:ring-emerald-400/10"
          />
          {f.hint && <p className="mt-1.5 text-xs text-slate-500">{f.hint}</p>}
        </div>
      ))}
      {error && <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
      <button
        type="submit" disabled={busy}
        className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >{busy ? "Please wait…" : submit}</button>
    </form>
  );
}
