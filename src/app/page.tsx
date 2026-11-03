import Link from "next/link";
import Logo from "@/components/Logo";

const features = [
  { t: "Zero installs for drivers", d: "Drivers open a private link and tap Start. No app, no account, no friction.", i: "M13 10V3L4 14h7v7l9-11h-7z" },
  { t: "Live fleet map", d: "Watch every vehicle move in real time, with speed, battery and route history.", i: "M9 20l-5.5-2.5v-13L9 7m0 13 6-3m-6 3V7m6 10 5.5 2.5v-13L15 4m0 13V4M9 7l6-3" },
  { t: "Impact & pothole alerts", d: "The phone's accelerometer flags severe road impacts the moment they happen.", i: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" },
  { t: "Works through dead zones", d: "Offline points are cached on the phone and synced automatically on reconnect.", i: "M8.1 16.1a5.5 5.5 0 0 1 7.8 0M5 13a10 10 0 0 1 14 0M2 9.9a14.5 14.5 0 0 1 20 0M12 20h.01" },
  { t: "Multi-tenant by design", d: "Each company only ever sees its own vehicles. Isolation is enforced on the server.", i: "M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6l-8-3Z" },
  { t: "Instant revocation", d: "Cancel a driver's link in one click and their tracking stops within seconds.", i: "M18 6 6 18M6 6l12 12" },
];

export default function Home() {
  return (
    <>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-1.5 text-slate-300 transition hover:text-white">Sign in</Link>
          <Link href="/register" className="rounded-lg bg-white px-3.5 py-1.5 font-medium text-slate-950 transition hover:bg-slate-200">Get started</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5">
        <section className="py-20 text-center sm:py-28">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Real-time fleet tracking for logistics teams
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-6xl">
            Track every vehicle.{" "}
            <span className="bg-gradient-to-r from-emerald-300 to-cyan-300 bg-clip-text text-transparent">Install nothing.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-slate-400 sm:text-lg">
            ZeroTracker turns any driver's phone browser into a live GPS node. Share a link, see the vehicle on your map seconds later.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-6 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:brightness-110 sm:w-auto">Register your company</Link>
            <Link href="/login" className="w-full rounded-xl border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-white transition hover:bg-white/10 sm:w-auto">Manager sign in</Link>
          </div>
        </section>

        <section className="grid gap-4 pb-24 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.t} className="group rounded-2xl border border-white/10 bg-slate-900/40 p-6 backdrop-blur transition hover:border-emerald-400/30 hover:bg-slate-900/70">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={f.i} /></svg>
              </span>
              <h3 className="mt-4 text-[15px] font-semibold text-white">{f.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{f.d}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-white/5 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} ZeroTracker. Location is only shared with the driver's clear consent. · <Link href="/privacy" className="underline hover:text-slate-300">Privacy</Link> · <Link href="/terms" className="underline hover:text-slate-300">Terms</Link>
      </footer>
    </>
  );
}
