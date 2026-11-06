import { backoffMs } from "./driverLogic";
import type { QueueStore, QueuedEvent } from "./queueStore";

export const BATCH_SIZE = 200;
export type DeviceEvent = { kind: string; clientEventId: string; ts: number; [k: string]: unknown };
export type SyncState = { queued: number; connection: "online" | "offline"; lastSentAt: number | null };
export type Engine = {
  send: (ev: DeviceEvent, o?: { keepalive?: boolean }) => Promise<void>;
  flush: () => Promise<void>;
  now: () => number;
  syncClock: (serverNow: number) => void;
  clearQueue: () => Promise<void>;
  destroy: () => void;
};
type Result = { kind: "ok"; json: Record<string, unknown> | null } | { kind: "auth"; code: string } | { kind: "retry" } | { kind: "drop" };

/**
 * Offline-first delivery. Fast path: send straight away. If that fails (no signal, 5xx, 429) or events are
 * already waiting, the event goes to the on-phone queue and a flush loop delivers it, oldest first, in
 * batches of 200 to /api/telemetry/batch with exponential backoff. Retries are safe because the server
 * ignores event ids it has already stored. 401/403/410 mean the link is dead: stop and clear everything.
 */
export function createSyncEngine(o: {
  store: QueueStore; token: string; onRevoked: (code: string) => void; onState: (s: Partial<SyncState>) => void;
  fetchImpl?: typeof fetch; isOnline?: () => boolean; target?: { addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void }; baseDelayMs?: number; batchSize?: number;
}): Engine {
  const q = o.store;
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const isOnline = o.isOnline ?? (() => (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" ? true : navigator.onLine));
  const target = o.target ?? (typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : undefined);
  const batchSize = o.batchSize ?? BATCH_SIZE;
  let skew = 0, destroyed = false, flushing = false, attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryPending = false;   // a backoff timer is running: new events must wait for it, not hammer a failing server

  const now = () => Date.now() + skew;
  const syncClock = (serverNow: number) => { skew = serverNow - Date.now(); };
  const headers = { "content-type": "application/json", "x-driver-token": o.token };
  const publishCount = async () => { if (!destroyed) o.onState({ queued: await q.count() }); };

  async function post(url: string, body: unknown, keepalive = false): Promise<Result> {
    try {
      const r = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), keepalive });
      if (r.ok) { const json = await r.json().catch(() => null); if (json?.now) syncClock(json.now); return { kind: "ok", json }; }
      if (r.status === 401 || r.status === 403 || r.status === 410) {
        const j = await r.json().catch(() => ({}));
        return { kind: "auth", code: j.code ?? (r.status === 403 ? "ORG_DISABLED" : "REVOKED") };
      }
      if (r.status === 429 || r.status >= 500) return { kind: "retry" };
      const j = await r.json().catch(() => ({}));
      if (j?.code === "BAD_TIMESTAMP" && j.now) syncClock(j.now);   // learn the clock error, but still drop this event
      return { kind: "drop" };                                      // 400 / 413: retrying can never succeed
    } catch { return { kind: "retry" }; }
  }

  const revoked = async (code: string) => { await q.clear(); await publishCount(); if (!destroyed) o.onRevoked(code); };
  const scheduleRetry = () => {
    if (destroyed) return;
    clearTimeout(timer); retryPending = true;
    timer = setTimeout(flush, backoffMs(attempt++, Math.random(), o.baseDelayMs ?? 1000));
  };

  async function flush(): Promise<void> {
    if (flushing || destroyed) return;
    flushing = true; clearTimeout(timer); retryPending = false;
    try {
      for (;;) {
        const batch = await q.peek(batchSize);
        if (!batch.length) break;
        const events = batch.map(({ seq: _seq, ...rest }: QueuedEvent) => rest);
        const r = await post("/api/telemetry/batch", { events });
        if (destroyed) return;
        if (r.kind === "ok" || r.kind === "drop") {          // accepted, duplicate, or rejected for good: all leave the queue
          await q.remove(batch.map((b) => b.seq as number));
          attempt = 0;
          if (r.kind === "ok") o.onState({ connection: "online", lastSentAt: Date.now() });
          await publishCount();
          continue;
        }
        if (r.kind === "auth") { await revoked(r.code); return; }
        o.onState({ connection: "offline" }); scheduleRetry(); break;   // network / 5xx / 429: back off and try again
      }
    } finally { flushing = false; await publishCount(); }
  }

  async function send(ev: DeviceEvent, opts: { keepalive?: boolean } = {}) {
    if (destroyed) return;
    // Page-hide events must leave immediately; the page may freeze before an IndexedDB read completes.
    const direct = isOnline() && (opts.keepalive || (!flushing && (await q.count()) === 0));
    if (!direct) {
      await q.add(ev as QueuedEvent); await publishCount();
      if (!isOnline()) o.onState({ connection: "offline" });
      else if (!retryPending) void flush();
      return;
    }
    const r = await post("/api/telemetry", ev, opts.keepalive);
    if (destroyed) return;
    if (r.kind === "ok") { o.onState({ connection: "online", lastSentAt: Date.now() }); if (opts.keepalive) void flush(); return; }
    if (r.kind === "auth") { await revoked(r.code); return; }
    if (r.kind === "retry") { await q.add(ev as QueuedEvent); o.onState({ connection: "offline" }); await publishCount(); scheduleRetry(); }
    // "drop": the server says this exact event is invalid, so it is discarded rather than retried forever
  }

  const onOnline = () => { attempt = 0; void flush(); };
  const onOffline = () => o.onState({ connection: "offline" });
  target?.addEventListener("online", onOnline);
  target?.addEventListener("offline", onOffline);
  void publishCount().then(async () => { if ((await q.count()) > 0 && isOnline()) void flush(); });   // deliver anything left from a previous session

  return {
    send, flush, now, syncClock,
    clearQueue: async () => { await q.clear(); await publishCount(); },
    destroy: () => { destroyed = true; clearTimeout(timer); target?.removeEventListener("online", onOnline); target?.removeEventListener("offline", onOffline); },
  };
}
