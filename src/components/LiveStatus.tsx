"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { connectAbly, type AblyRealtime } from "@/lib/ablyClient";

/**
 * Keeps a server-rendered page live. Subscribes to an Ably channel (when realtime is on) and
 * ALSO polls a small endpoint as a safety net, so the page updates even if the socket drops.
 * Any pushed event or a changed `sig` triggers router.refresh() to re-render with fresh data.
 */
export default function LiveStatus({ channel, pollUrl, sig, pollMs, realtime }: {
  channel: string; pollUrl: string; sig: string; pollMs: number; realtime: boolean;
}) {
  const router = useRouter();
  const sigRef = useRef(sig);
  sigRef.current = sig;

  useEffect(() => {
    let stopped = false;
    let ably: AblyRealtime | undefined;

    const poll = async () => {
      try {
        const r = await fetch(pollUrl, { cache: "no-store" });
        if (!r.ok || stopped) return;
        const j = await r.json();
        if (j.sig !== sigRef.current) router.refresh();
      } catch { /* offline: try again next tick */ }
    };
    const timer = setInterval(poll, pollMs);

    if (realtime) {
      connectAbly({ authUrl: "/api/realtime/token" }).then((client) => {
        if (stopped) { client.close(); return; }
        ably = client;
        client.channels.get(channel).subscribe(() => router.refresh());
      }).catch(() => { /* polling still covers us */ });
    }

    return () => { stopped = true; clearInterval(timer); ably?.close(); };
  }, [channel, pollUrl, pollMs, realtime, router]);

  return null;
}
