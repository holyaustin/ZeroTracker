import Logo from "./Logo";

const COPY: Record<string, { title: string; body: string; tone: string }> = {
  REVOKED: { title: "Access revoked by your manager", body: "Location sharing has stopped. Ask your fleet manager for a new link if you need to continue.", tone: "rose" },
  ORG_DISABLED: { title: "Tracking is currently disabled", body: "Your company's account is not active, so location sharing is off. Contact your fleet manager.", tone: "orange" },
  INVALID: { title: "This link isn't valid", body: "Check that you opened the full link you were sent, or ask your fleet manager for a new one.", tone: "slate" },
  RATE_LIMITED: { title: "Too many attempts", body: "Please wait a few minutes and try again.", tone: "slate" },
};
const TONE: Record<string, string> = {
  rose: "bg-rose-400/10 text-rose-300 ring-rose-400/25", orange: "bg-orange-400/10 text-orange-300 ring-orange-400/25", slate: "bg-slate-400/10 text-slate-300 ring-slate-400/25",
};

export default function DriverLocked({ code }: { code: string }) {
  const c = COPY[code] ?? COPY.INVALID;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center" data-driver-state="locked">
      <Logo href="/" />
      <span className={`mt-10 grid h-16 w-16 place-items-center rounded-2xl ring-1 ${TONE[c.tone]}`}>
        <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      </span>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-white">{c.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{c.body}</p>
    </main>
  );
}
