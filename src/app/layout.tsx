import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "ZeroTracker — Fleet tracking with zero installs",
  description: "Track your vehicles in real time from the driver's phone browser. No app, no sign-up.",
};
export const viewport: Viewport = { themeColor: "#020617", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="relative min-h-screen bg-slate-950 text-slate-100 antialiased selection:bg-emerald-400/30">
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(16,185,129,0.14),transparent),radial-gradient(40%_40%_at_100%_100%,rgba(34,211,238,0.08),transparent)]" />
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 opacity-[0.25] [background-image:linear-gradient(rgba(148,163,184,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.07)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        {children}
      </body>
    </html>
  );
}
