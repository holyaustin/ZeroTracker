"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES, ProfileInput } from "@/lib/validation";

type Key = "cacOrBnNumber" | "hqAddress" | "whatsappNumber" | "estimatedFleetSize" | "operationCategory";
type Values = Record<Key, string>;
const STEPS: { title: string; blurb: string; keys: Key[] }[] = [
  { title: "Business identity", blurb: "Tell us who you are so we can verify your registration.", keys: ["cacOrBnNumber", "hqAddress"] },
  { title: "Fleet operations", blurb: "How we reach you and the scale of your fleet.", keys: ["whatsappNumber", "estimatedFleetSize", "operationCategory"] },
];
const input = "w-full rounded-xl border border-white/10 bg-slate-950/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-emerald-400/60 focus:ring-4 focus:ring-emerald-400/10";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-300">{label}</label>
      {children}
      {error ? <p role="alert" className="mt-1.5 text-xs text-rose-300">{error}</p> : hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default function VerificationWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [v, setV] = useState<Values>({ cacOrBnNumber: "", hqAddress: "", whatsappNumber: "", estimatedFleetSize: "", operationCategory: "" });
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const on = (k: Key) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV((p) => ({ ...p, [k]: e.target.value }));

  function validate(keys: Key[]) {
    const errs: Partial<Record<Key, string>> = {};
    for (const k of keys) {
      const r = ProfileInput.shape[k].safeParse(v[k]);
      if (!r.success) errs[k] = r.error.issues[0].message;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function submit() {
    if (!validate(STEPS[1].keys)) return;
    setBusy(true); setFormError(null);
    try {
      const res = await fetch("/api/company/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
      const json = await res.json().catch(() => ({}));
      if (res.ok || res.status === 409) { router.refresh(); return; }
      if (json.fields) {
        const errs: Partial<Record<Key, string>> = {};
        for (const [k, m] of Object.entries(json.fields as Record<string, string[]>)) errs[k as Key] = m[0];
        setErrors(errs);
        if (STEPS[0].keys.some((k) => errs[k])) setStep(0);
      }
      setFormError(json.error ?? "Something went wrong. Please try again.");
    } catch { setFormError("Network error. Check your connection and try again."); }
    finally { setBusy(false); }
  }

  const s = STEPS[step];
  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        {STEPS.map((x, i) => (
          <div key={x.title} className="flex flex-1 items-center gap-3">
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ring-1 ${i <= step ? "bg-emerald-400 text-slate-950 ring-emerald-300" : "bg-white/5 text-slate-400 ring-white/10"}`}>{i + 1}</span>
            <div className={`h-1 flex-1 rounded-full ${i < step ? "bg-emerald-400" : "bg-white/10"} ${i === STEPS.length - 1 ? "hidden" : ""}`} />
          </div>
        ))}
      </div>
      <h3 className="text-lg font-semibold text-white">{s.title}</h3>
      <p className="mt-1 text-sm text-slate-400">Step {step + 1} of {STEPS.length} · {s.blurb}</p>

      <div className="mt-5 space-y-4">
        {step === 0 && (<>
          <Field id="cacOrBnNumber" label="CAC registration / BN number" hint="e.g. RC1234567 or BN1234567" error={errors.cacOrBnNumber}>
            <input id="cacOrBnNumber" className={input} value={v.cacOrBnNumber} onChange={on("cacOrBnNumber")} placeholder="RC1234567" autoComplete="off" />
          </Field>
          <Field id="hqAddress" label="Headquarters address" error={errors.hqAddress}>
            <textarea id="hqAddress" rows={3} className={input} value={v.hqAddress} onChange={on("hqAddress")} placeholder="12 Airport Road, Benin City, Edo State" />
          </Field>
        </>)}
        {step === 1 && (<>
          <Field id="whatsappNumber" label="WhatsApp phone number" hint="Include the country code" error={errors.whatsappNumber}>
            <input id="whatsappNumber" type="tel" className={input} value={v.whatsappNumber} onChange={on("whatsappNumber")} placeholder="+234 801 234 5678" autoComplete="tel" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="estimatedFleetSize" label="Estimated fleet size" error={errors.estimatedFleetSize}>
              <input id="estimatedFleetSize" inputMode="numeric" className={input} value={v.estimatedFleetSize} onChange={on("estimatedFleetSize")} placeholder="25" />
            </Field>
            <Field id="operationCategory" label="Operation category" error={errors.operationCategory}>
              <select id="operationCategory" className={input} value={v.operationCategory} onChange={on("operationCategory")}>
                <option value="" className="bg-slate-900">Select…</option>
                {CATEGORIES.map((c) => <option key={c} value={c} className="bg-slate-900">{c}</option>)}
              </select>
            </Field>
          </div>
        </>)}
      </div>

      {formError && <p role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{formError}</p>}

      <div className="mt-6 flex items-center justify-between gap-3">
        <button type="button" onClick={() => { setErrors({}); setStep(0); }} disabled={step === 0 || busy}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-white/10 disabled:invisible">Back</button>
        {step === 0 ? (
          <button type="button" onClick={() => validate(STEPS[0].keys) && setStep(1)}
            className="rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110">Continue</button>
        ) : (
          <button type="button" onClick={submit} disabled={busy}
            className="rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:opacity-60">{busy ? "Submitting…" : "Submit for review"}</button>
        )}
      </div>
    </div>
  );
}
