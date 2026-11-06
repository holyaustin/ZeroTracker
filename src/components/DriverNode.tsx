"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectAbly, type AblyRealtime } from "@/lib/ablyClient";
import { useTripSensors, type MotionPermission } from "@/lib/useTripSensors";
import { useSyncEngine } from "@/lib/useSyncEngine";
import DriverLocked from "./DriverLocked";
import Logo from "./Logo";

type Phase = "loading" | "consent" | "ready" | "active" | "locked";
type Props = { token: string; tokenId: string; vehicleId: string; label: string; orgName: string; realtime: boolean; pollMs: number };

const K = { consent: "zt:consent:v1", binding: "zt:driver", trip: "zt:trip", motion: "zt:motion" };
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
/** iOS 13+ requires DeviceMotionEvent.requestPermission() inside a user gesture. Elsewhere no permission is needed. */
function requestMotionPermission(): Promise<MotionPermission> {
  const R = typeof DeviceMotionEvent !== "undefined" ? (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission : undefined;
  if (typeof R !== "function") return Promise.resolve("granted");
  return R.call(DeviceMotionEvent).then((r) => (r === "granted" ? "granted" : "denied") as MotionPermission).catch(() => "denied" as MotionPermission);
}
const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? h + ":" : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export default function DriverNode({ token, tokenId, vehicleId, label, orgName, realtime, pollMs }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [lockCode, setLockCode] = useState("REVOKED");
  const [agreed, setAgreed] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phaseRef = useRef<Phase>("loading");
  phaseRef.current = phase;

  const [motionPermission, setMotionPermission] = useState<MotionPermission>("unknown");
  const [appLink, setAppLink] = useState<string | null>(null);
  useEffect(() => { setAppLink(`zerotracker://d/${token}?base=${encodeURIComponent(window.location.origin)}`); }, [token]);

  /** Stops everything and wipes the binding and any queued data. Called on 401/403/410 or a token-revoked push. */
  const lockout = useCallback((code: string) => {
    store.del(K.trip); store.del(K.binding);
    void engineRef.current?.clearQueue();
    setLockCode(code); setPhase("locked"); setStartedAt(null);
  }, []);

  const sync = useSyncEngine(token, lockout);
  const engineRef = sync.engine;
  const sensors = useTripSensors({ active: phase === "active", engine: engineRef, motionPermission });
  const syncClock = useCallback((serverNow: number) => engineRef.current?.syncClock(serverNow), [engineRef]);   // stable: keeps the revalidation timer from resetting

  // Bind this browser to the vehicle and restore state after a refresh (auto-resume).
  useEffect(() => {
    let prev: { tokenId?: string } | null = null;
    try { prev = JSON.parse(store.get(K.binding) ?? "null"); } catch { /* ignore */ }
    if (prev?.tokenId && prev.tokenId !== tokenId) store.del(K.trip);   // a different link was opened: start clean
    store.set(K.binding, JSON.stringify({ token, tokenId, vehicleId, label, orgName }));
    const trip = Number(store.get(K.trip));
    if (trip > 0) {
      setStartedAt(trip); setPhase("active");
      // Android/desktop need no permission. On iOS a silent re-grant works only if the browser remembers it;
      // otherwise we stay "unknown" and the screen offers an Enable button (a tap is mandatory there).
      const needsTap = typeof DeviceMotionEvent !== "undefined" && typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown }).requestPermission === "function";
      if (!needsTap) setMotionPermission("granted");
      else if (store.get(K.motion) === "granted") requestMotionPermission().then((r) => { if (r === "granted") setMotionPermission("granted"); });
    } else setPhase(store.get(K.consent) ? "ready" : "consent");
  }, [token, tokenId, vehicleId, label, orgName]);

  // Every call re-validates the token. 401/403/410 = stop immediately.
  const validate = useCallback(async () => {
    if (phaseRef.current === "locked" || phaseRef.current === "loading") return;
    try {
      const r = await fetch("/api/driver/session", { method: "POST", headers: { "x-driver-token": token }, cache: "no-store" });
      if (r.status === 401 || r.status === 403 || r.status === 410) {
        const j = await r.json().catch(() => ({}));
        lockout(j.code ?? (r.status === 403 ? "ORG_DISABLED" : "REVOKED"));
      } else if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j?.now) syncClock(j.now);      // learn the phone's clock error before the first ping
      }
    } catch { /* offline: keep going, the next tick retries */ }
  }, [token, lockout, syncClock]);

  const firstCheck = useRef(false);
  useEffect(() => { if (phase !== "loading" && !firstCheck.current) { firstCheck.current = true; validate(); } }, [phase, validate]);

  useEffect(() => {
    const t = setInterval(validate, pollMs);
    const onVis = () => { if (document.visibilityState === "visible") validate(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [validate, pollMs]);

  // Instant lockout push from the manager's revoke button.
  useEffect(() => {
    if (!realtime) return;
    let stopped = false; let ably: AblyRealtime | undefined;
    connectAbly({ authUrl: "/api/driver/realtime-token", authHeaders: { "x-driver-token": token } }).then((c) => {
      if (stopped) { c.close(); return; }
      ably = c;
      c.channels.get(`vehicle:${vehicleId}`).subscribe((m) => {
        if (m.name === "token-revoked" && (m.data as { tokenId?: string })?.tokenId === tokenId) lockout("REVOKED");
      });
    }).catch(() => { /* the poll above still catches revocation */ });
    return () => { stopped = true; ably?.close(); };
  }, [realtime, token, tokenId, vehicleId, lockout]);

  useEffect(() => {
    if (phase !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  if (phase === "locked") return <DriverLocked code={lockCode} />;
  if (phase === "loading") return <main className="grid min-h-screen place-items-center text-sm text-slate-500">Loading…</main>;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-8" data-driver-state={phase}>
      <header className="flex items-center justify-between"><Logo href="#" /><span className="text-xs text-slate-500">{orgName}</span></header>

      {phase === "consent" && (
        <section className="flex flex-1 flex-col justify-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Before you start</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            <strong className="text-white">{orgName}</strong> will see this phone&apos;s location, speed, battery level and road-impact readings
            while a trip is running, so they can track <strong className="text-white">{label}</strong>.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-slate-400">
            <li>• Sharing happens only while a trip is ON, with a visible indicator.</li>
            <li>• You can end the trip at any time.</li>
            <li>• Your manager can cancel this link at any time.</li>
            <li>• Read how your data is handled in the <a href="/privacy" target="_blank" rel="noopener" className="underline">Privacy Notice</a>.</li>
          </ul>
          <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5 accent-emerald-400" />
            <span>I understand and agree to share my location and phone sensor data with {orgName} during trips.</span>
          </label>
          <button disabled={!agreed} onClick={() => { store.set(K.consent, String(Date.now())); setPhase("ready"); }}
            className="mt-5 h-14 rounded-2xl bg-gradient-to-r from-emerald-400 to-cyan-400 text-base font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition active:scale-[0.99] disabled:opacity-40">Agree &amp; continue</button>
        </section>
      )}

      {phase === "ready" && (
        <section className="flex flex-1 flex-col justify-center text-center">
          <p className="text-sm text-slate-400">You are assigned to</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">{label}</h1>
          <p className="mx-auto mt-3 max-w-xs text-sm text-slate-400">Tap Start when you begin your trip. Keep this page open and your screen on.</p>
          {appLink && <a href={appLink} data-testid="open-in-app" className="mx-auto mt-3 block max-w-xs text-xs text-slate-500 underline">Need tracking to continue with the screen off? Open in the ZeroTracker Driver app</a>}
          <button onClick={() => {
            const perm = requestMotionPermission();     // must be called inside this tap (iOS)
            perm.then((r) => { setMotionPermission(r); if (r === "granted") store.set(K.motion, "granted"); });
            const t = Date.now(); store.set(K.trip, String(t)); setStartedAt(t); setNow(t); setPhase("active");
          }}
            className="mt-10 h-24 rounded-3xl bg-gradient-to-r from-emerald-400 to-cyan-400 text-2xl font-semibold text-slate-950 shadow-xl shadow-emerald-500/25 transition active:scale-[0.98]">Start Trip</button>
        </section>
      )}

      {phase === "active" && (
        <section className="flex flex-1 flex-col pb-28 pt-6 text-center" data-testid="active-screen">
          <Indicator gps={sensors.gps} onRetry={sensors.retryGps} />
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">{label}</h1>
          <p className="mt-1 font-mono text-4xl tabular-nums text-white">{fmt(now - (startedAt ?? now))}</p>

          <div className="mt-6 grid grid-cols-2 gap-3 text-left">
            <Tile label="Speed" value={sensors.speedKmh == null ? "—" : String(Math.round(sensors.speedKmh))} unit="km/h" testId="tile-speed" />
            <Tile label="GPS accuracy" value={sensors.accuracyM == null ? "—" : `±${Math.round(sensors.accuracyM)}`} unit="m" />
            <Tile label="Battery" value={sensors.battery ? String(sensors.battery.pct) : "n/a"} unit={sensors.battery ? (sensors.battery.charging ? "% ⚡" : "%") : ""} />
            <Tile label="Last sent" value={sync.lastSentAt ? `${Math.max(0, Math.round((now - sync.lastSentAt) / 1000))}s` : "—"} unit={sync.lastSentAt ? "ago" : ""} />
            <MotionTile state={sensors.motion} onEnable={() => requestMotionPermission().then((r) => { setMotionPermission(r); if (r === "granted") store.set(K.motion, "granted"); })} />
          </div>

          <div className="mb-6 mt-4 space-y-2 text-left">
            {sensors.lowBattery && <Notice tone="rose" testId="notice-battery">Battery low ({sensors.battery?.pct}%). Plug in your phone so tracking doesn&apos;t stop.</Notice>}
            {sensors.wasBackgrounded && (
              <Notice tone="amber" testId="notice-background" onClose={sensors.dismissBackground}>
                Tracking may pause while ZeroTracker is in the background. Keep this page open and your screen on.
              </Notice>
            )}
            {sensors.lastImpact && now - sensors.lastImpact.at < 6000 && (
              <Notice tone="rose" testId="notice-impact">{sensors.lastImpact.type === "IMPACT" ? "Severe impact" : "Road shock"} detected ({sensors.lastImpact.g.toFixed(1)} G). Your manager has been alerted.</Notice>
            )}
            {sync.connection === "offline" && (
              <Notice tone="amber" testId="notice-offline">No connection. {sync.queued > 0 ? `${sync.queued} point${sync.queued === 1 ? "" : "s"} saved on your phone and will sync automatically.` : "Reconnecting…"}</Notice>
            )}
            {sync.connection === "online" && sync.queued > 0 && <Notice tone="slate" testId="notice-syncing">Syncing {sync.queued} saved point{sync.queued === 1 ? "" : "s"}…</Notice>}
            {sensors.haptics === "locked" && sensors.lastImpact === null && <Notice tone="slate" testId="notice-haptics">Tap the screen once to enable vibration alerts.</Notice>}
            {sensors.wake === "unsupported" && <Notice tone="slate">This browser can&apos;t keep the screen awake. Turn off auto-lock while driving.</Notice>}
          </div>

          <div className="fixed inset-x-0 bottom-0 z-10 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
            <button onClick={() => { store.del(K.trip); setStartedAt(null); setPhase("ready"); }}
              className="mx-auto block h-16 w-full max-w-md rounded-2xl border border-rose-400/30 bg-rose-500/20 text-lg font-semibold text-rose-100 backdrop-blur transition hover:bg-rose-500/30 active:scale-[0.99]">End trip</button>
          </div>
        </section>
      )}
    </main>
  );
}

function Indicator({ gps, onRetry }: { gps: string; onRetry: () => void }) {
  const cfg: Record<string, { text: string; cls: string; dot: string; ping: boolean }> = {
    ok: { text: "Location sharing is ON", cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", dot: "bg-emerald-400", ping: true },
    waiting: { text: "Waiting for GPS signal…", cls: "border-amber-400/30 bg-amber-400/10 text-amber-300", dot: "bg-amber-400", ping: true },
    unavailable: { text: "GPS signal lost. Searching…", cls: "border-amber-400/30 bg-amber-400/10 text-amber-300", dot: "bg-amber-400", ping: true },
    denied: { text: "Location blocked. Sharing is OFF", cls: "border-rose-400/30 bg-rose-400/10 text-rose-300", dot: "bg-rose-400", ping: false },
    unsupported: { text: "This browser can't share location", cls: "border-rose-400/30 bg-rose-400/10 text-rose-300", dot: "bg-rose-400", ping: false },
    idle: { text: "Starting…", cls: "border-white/10 bg-white/5 text-slate-300", dot: "bg-slate-400", ping: false },
  };
  const c = cfg[gps] ?? cfg.idle;
  return (
    <div>
      <div className={`mx-auto inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium ${c.cls}`} role="status" data-gps={gps}>
        <span className="relative flex h-2.5 w-2.5">
          {c.ping && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${c.dot}`} />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${c.dot}`} />
        </span>
        {c.text}
      </div>
      {gps === "denied" && (
        <div className="mt-3 space-y-3 text-sm text-slate-400">
          <p>Allow location for this site in your browser settings, then tap Try again.</p>
          <button onClick={onRetry} className="rounded-xl bg-white px-4 py-2 font-semibold text-slate-950">Try again</button>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, unit, testId }: { label: string; value: string; unit?: string; testId?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4" data-testid={testId}>
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}<span className="ml-1 text-sm font-normal text-slate-400">{unit}</span></p>
    </div>
  );
}

function Notice({ tone, children, onClose, testId }: { tone: "rose" | "amber" | "slate"; children: React.ReactNode; onClose?: () => void; testId?: string }) {
  const t = { rose: "border-rose-400/25 bg-rose-400/10 text-rose-200", amber: "border-amber-400/25 bg-amber-400/10 text-amber-200", slate: "border-white/10 bg-white/5 text-slate-300" }[tone];
  return (
    <div role="alert" data-testid={testId} className={`flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm ${t}`}>
      <span>{children}</span>
      {onClose && <button onClick={onClose} aria-label="Dismiss" className="shrink-0 text-current opacity-70 hover:opacity-100">✕</button>}
    </div>
  );
}

function MotionTile({ state, onEnable }: { state: string; onEnable: () => void }) {
  const text: Record<string, string> = { on: "Active", waiting: "Starting…", denied: "Blocked", unsupported: "Not available", idle: "—" };
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4" data-testid="tile-motion" data-motion={state}>
      <p className="text-xs uppercase tracking-wider text-slate-500">Impact sensor</p>
      {state === "needs-tap"
        ? <button onClick={onEnable} className="mt-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-950">Enable</button>
        : <p className={`mt-1 text-2xl font-semibold ${state === "on" ? "text-emerald-300" : state === "denied" || state === "unsupported" ? "text-slate-400" : "text-white"}`}>{text[state] ?? "—"}</p>}
    </div>
  );
}
