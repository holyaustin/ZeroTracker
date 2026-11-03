import Link from "next/link";
import Logo from "./Logo";

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <>
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
        <Logo />
        <Link href="/" className="text-sm text-slate-400 hover:text-white">← Back</Link>
      </header>
      <main className="mx-auto max-w-3xl px-5 pb-20">
        <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {updated}</p>
        <div className="mt-8 space-y-5 text-[15px] leading-relaxed text-slate-300 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-white [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-white">{children}</div>
        <p className="mt-12 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200">
          This document is a starting template written for ZeroTracker&apos;s features. Have a qualified lawyer review it, and fill in your company name, address and contact details, before you launch.
        </p>
      </main>
    </>
  );
}
