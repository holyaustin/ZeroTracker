"use client";
/** Browser-side Ably helper. The library is self-hosted at /vendor/ably.min.js (see scripts/copy-ably.mjs). */
export type AblyMessage = { name: string; data: unknown };
export type AblyRealtime = {
  close: () => void;
  channels: { get: (c: string) => { subscribe: (cb: (m: AblyMessage) => void) => void } };
};
type AblyGlobal = {
  Realtime: new (o: { authUrl: string; authMethod: string; authHeaders?: Record<string, string> }) => AblyRealtime;
};

function loadAbly(): Promise<AblyGlobal> {
  const w = window as unknown as { Ably?: AblyGlobal };
  if (w.Ably) return Promise.resolve(w.Ably);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "/vendor/ably.min.js"; el.async = true;
    el.onload = () => (w.Ably ? resolve(w.Ably) : reject(new Error("Ably missing")));
    el.onerror = () => reject(new Error("Ably failed to load"));
    document.head.appendChild(el);
  });
}

export async function connectAbly(opts: { authUrl: string; authHeaders?: Record<string, string> }): Promise<AblyRealtime> {
  const Ably = await loadAbly();
  return new Ably.Realtime({ authUrl: opts.authUrl, authMethod: "POST", authHeaders: opts.authHeaders });
}
