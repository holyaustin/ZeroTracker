import { IMPACT_COOLDOWN_MS, IMPACT_THRESHOLD_G, SEND_INTERVAL_MS, STALE_FIX_MS, classifyImpact, cleanHeading, cleanNumber, createImpactDetector, lowBatteryNext, makeEventId, msToKmh } from "../shared/driverLogic";
import { createSyncEngine, type Engine, type SyncState } from "../shared/syncEngine";
import type { QueueStore } from "../shared/queueStore";

export type RawFix = { latitude: number; longitude: number; accuracy?: number | null; speed?: number | null; heading?: number | null };
export type AppStateName = "FOREGROUND" | "BACKGROUNDED";
export type Phase = "idle" | "active" | "locked";
export type GpsState = "idle" | "waiting" | "ok" | "denied" | "unavailable";
export type MotionState = "idle" | "waiting" | "on" | "unsupported";

/** Everything that touches the phone is behind this interface, so the logic below runs (and is tested) without a phone. */
export interface Platform {
  /** Start GPS (background-capable). Fixes are delivered by calling the supplied callback. Returns a stop function. */
  startLocation(onFix: (f: RawFix) => void, onError: (denied: boolean) => void): Promise<{ stop: () => void | Promise<void>; background: boolean }>;
  /** Resultant 3-axis acceleration in g (a resting phone reads ~1). Return undefined if there is no accelerometer. */
  startMotion?(onSample: (g: number) => void): (() => void) | undefined;
  startBattery?(onChange: (b: { pct: number; charging: boolean }) => void): Promise<() => void>;
  watchAppState(onChange: (s: AppStateName) => void): () => void;
  vibrate(pattern: number[]): void;
}

export type TripState = {
  phase: Phase; lockCode: string | null; gps: GpsState; backgroundTracking: boolean;
  speedKmh: number | null; accuracyM: number | null; battery: { pct: number; charging: boolean } | null;
  appState: AppStateName; lowBattery: boolean; motion: MotionState;
  lastImpact: { g: number; type: "IMPACT" | "POTHOLE"; at: number } | null;
} & SyncState;

export type SessionResult = { ok: true; vehicleLabel: string; orgName: string } | { ok: false; code: string; status: number };

export class TripController {
  private state: TripState = {
    phase: "idle", lockCode: null, gps: "idle", backgroundTracking: false, speedKmh: null, accuracyM: null, battery: null,
    appState: "FOREGROUND", lowBattery: false, motion: "idle", lastImpact: null, queued: 0, connection: "online", lastSentAt: null,
  };
  private listeners = new Set<() => void>();
  private engine: Engine;
  private latest: { lat: number; lng: number; accuracyM: number | null; speedKmh: number | null; heading: number | null; at: number } | null = null;
  private battery: { pct: number; charging: boolean } | null = null;
  private lowWarned = false;
  private lastPingAt = 0;
  private stoppers: (() => void | Promise<void>)[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private detector = createImpactDetector(IMPACT_THRESHOLD_G, IMPACT_COOLDOWN_MS);
  private gotMotion = false;
  private minPingMs: number;
  private heartbeatMs: number;
  private fetchImpl: typeof fetch;

  constructor(private o: {
    token: string; baseUrl: string; store: QueueStore; platform: Platform; fetchImpl?: typeof fetch;
    isOnline?: () => boolean; target?: { addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
    minPingMs?: number; heartbeatMs?: number; baseDelayMs?: number;
  }) {
    this.minPingMs = o.minPingMs ?? SEND_INTERVAL_MS - 500;
    this.heartbeatMs = o.heartbeatMs ?? SEND_INTERVAL_MS;
    const base = o.baseUrl.replace(/\/+$/, "");
    const raw = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.fetchImpl = (url, init) => raw(typeof url === "string" && url.startsWith("/") ? base + url : url, init);
    this.engine = createSyncEngine({
      store: o.store, token: o.token, fetchImpl: this.fetchImpl, isOnline: o.isOnline, target: o.target, baseDelayMs: o.baseDelayMs,
      onRevoked: (code) => void this.lock(code),
      onState: (s) => this.set(s),
    });
  }

  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(p: Partial<TripState>) { this.state = { ...this.state, ...p }; this.listeners.forEach((l) => l()); }

  /** Checks the link with the server (also teaches us the phone's clock error). Any of 401/403/410 means: stop. */
  async session(): Promise<SessionResult> {
    try {
      const r = await this.fetchImpl("/api/driver/session", { method: "POST", headers: { "x-driver-token": this.o.token } });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { if (j.now) this.engine.syncClock(j.now); return { ok: true, vehicleLabel: j.vehicle?.label ?? "", orgName: j.org?.name ?? "" }; }
      if (r.status === 401 || r.status === 403 || r.status === 410) { await this.lock(j.code ?? (r.status === 403 ? "ORG_DISABLED" : "REVOKED")); }   // finish locking before reporting, so callers never see a half-locked phone
      return { ok: false, code: j.code ?? "ERROR", status: r.status };
    } catch { return { ok: false, code: "NETWORK", status: 0 }; }
  }

  async start(): Promise<void> {
    if (this.state.phase === "active") return;
    this.set({ phase: "active", lockCode: null, gps: "waiting" });
    const p = this.o.platform;
    try {
      const loc = await p.startLocation((f) => this.onLocation(f), (denied) => this.set({ gps: denied ? "denied" : "unavailable" }));
      this.stoppers.push(loc.stop); this.set({ backgroundTracking: loc.background });
    } catch { this.set({ gps: "denied" }); }

    this.stoppers.push(p.watchAppState((s) => this.onAppState(s)));
    const stopMotion = p.startMotion?.((g) => this.onMotion(g));
    if (stopMotion) {
      this.set({ motion: "waiting" }); this.stoppers.push(stopMotion);
      const t = setTimeout(() => { if (!this.gotMotion && this.state.phase === "active") this.set({ motion: "unsupported" }); }, 4000);   // device never reports motion
      this.stoppers.push(() => clearTimeout(t));
    } else this.set({ motion: "unsupported" });
    if (p.startBattery) { try { this.stoppers.push(await p.startBattery((b) => this.onBattery(b))); } catch { /* no battery info */ } }
    this.heartbeat = setInterval(() => this.maybePing(this.heartbeatMs - 100), this.heartbeatMs);
    void this.engine.flush();
  }

  /** Ends the trip. Anything still queued keeps uploading in the background. */
  async stop() {
    clearInterval(this.heartbeat);
    for (const s of this.stoppers.splice(0)) { try { await s(); } catch { /* already stopped */ } }
    this.latest = null; this.battery = null; this.lowWarned = false; this.gotMotion = false;
    this.set({ phase: "idle", gps: "idle", speedKmh: null, accuracyM: null, battery: null, lowBattery: false, motion: "idle", backgroundTracking: false });
  }

  /** Link revoked / company suspended: stop every sensor, wipe saved data, show the lock screen. */
  async lock(code: string) {
    if (this.state.phase === "locked") return;
    await this.stop();
    await this.engine.clearQueue();
    this.set({ phase: "locked", lockCode: code });
  }

  destroy() { clearInterval(this.heartbeat); this.engine.destroy(); }

  // ---- inputs -------------------------------------------------------------------------------------------------------
  onLocation(raw: RawFix) {
    if (this.state.phase !== "active") return;
    const speed = typeof raw.speed === "number" && raw.speed >= 0 ? msToKmh(raw.speed) : null;   // iOS reports -1 when unknown
    this.latest = { lat: raw.latitude, lng: raw.longitude, accuracyM: cleanNumber(raw.accuracy), speedKmh: speed, heading: cleanHeading(raw.heading), at: Date.now() };
    this.set({ gps: "ok", speedKmh: speed, accuracyM: this.latest.accuracyM });
    this.maybePing(this.minPingMs);                       // also runs while the screen is off, driven by the location service
  }

  private maybePing(minGapMs: number) {
    const f = this.latest;
    if (!f || Date.now() - f.at > STALE_FIX_MS) return;   // never send a stale position as if it were fresh
    if (Date.now() - this.lastPingAt < minGapMs) return;
    this.lastPingAt = Date.now();
    void this.engine.send({ kind: "ping", clientEventId: makeEventId(), ts: this.engine.now(), lat: f.lat, lng: f.lng, speedKmh: f.speedKmh,
      accuracyM: f.accuracyM, heading: f.heading, batteryPct: this.battery?.pct ?? null, charging: this.battery?.charging ?? null, appState: this.state.appState });
  }

  private incident(type: string, message: string, extra: Record<string, unknown> = {}) {
    const f = this.latest;
    void this.engine.send({ kind: "incident", clientEventId: makeEventId(), ts: this.engine.now(), type, message, lat: f?.lat ?? null, lng: f?.lng ?? null, ...extra });
  }

  private onAppState(s: AppStateName) {
    if (this.state.phase !== "active" || s === this.state.appState) return;
    this.set({ appState: s });
    this.incident(s === "BACKGROUNDED" ? "BACKGROUNDED" : "FOREGROUNDED", s === "BACKGROUNDED" ? "Driver switched away from the app" : "Driver returned to the app");
  }

  private onBattery(b: { pct: number; charging: boolean }) {
    this.battery = b; this.set({ battery: b });
    const r = lowBatteryNext(this.lowWarned, b.pct, b.charging);
    this.lowWarned = r.warned; this.set({ lowBattery: r.warned });
    if (r.warn) this.incident("LOW_BATTERY", `Battery low (${b.pct}%)`);
  }

  private onMotion(g: number) {
    if (!this.gotMotion) { this.gotMotion = true; this.set({ motion: "on" }); }
    if (!this.detector.feed(g, Date.now())) return;
    const type = classifyImpact(g), rounded = Math.round(g * 100) / 100;
    this.incident(type, `${type === "IMPACT" ? "Severe impact" : "Pothole / road shock"}: ${rounded.toFixed(1)} G`, { gForce: rounded });
    try { this.o.platform.vibrate([200, 100, 200]); } catch { /* no vibrator */ }
    this.set({ lastImpact: { g: rounded, type, at: Date.now() } });
  }
}
