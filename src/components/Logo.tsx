import Link from "next/link";

export default function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-400 shadow-lg shadow-emerald-500/20 ring-1 ring-white/20">
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-slate-950" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 1 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.2" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">Zero<span className="text-emerald-400">Tracker</span></span>
    </Link>
  );
}
