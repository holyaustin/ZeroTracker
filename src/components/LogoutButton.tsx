"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LogoutButton({ to = "/login" }: { to?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        router.push(to); router.refresh();
      }}
      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
    >Sign out</button>
  );
}
