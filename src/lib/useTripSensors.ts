"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { IMPACT_COOLDOWN_MS, IMPACT_THRESHOLD_G, SEND_INTERVAL_MS, STALE_FIX_MS, classifyImpact, cleanHeading, cleanNumber,
  createImpactDetector, lowBatteryNext, makeEventId, msToKmh, resultantG } from "./driverLogic";
import type { Engine } from "./syncEngine";

export type GpsState = "idle" | "waiting" | "ok" | "denied" | "unavailable" | "unsupported";
export type WakeState = "idle" | "on" | "off" | "unsupported";
export type MotionState = "idle" | "waiting" | "on" | "needs-tap" | "denied" | "unsupported";
export type MotionPermission = "unknown" | "granted" | "denied";
type AppState = "FOREGROUND" | "BACKGROUNDED";
type Fix = { lat: number; lng: number; accuracyM: number | null; speedKmh: number | null; heading: number | null; at: number };
type BatteryManagerLike = { level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
export type LastImpact = { g: number; type: "IMPACT" | "POTHOLE"; at: number };

export type TripSensors = {
  gps: GpsState; speedKmh: number | null; accuracyM: number | null;
  battery: { pct: number; charging: boolean } | null; wake: WakeState;
  appState: AppState; lowBattery: boolean; wasBackgrounded: boolean;
  motion: MotionState; lastImpact: LastImpact | null; haptics: "ready" | "locked" | "unsupported";
  retryGps: () => void; dismissBackground: () => void;
};

/**
 * Runs the phone's sensors while a trip is active: GPS, accelerometer (impact/pothole), Screen Wake Lock,
 * Page Visibility and Battery. Everything starts when `active` becomes true and is fully torn down when it
 * becomes false (trip ended, link revoked), so a locked-out driver never keeps sensors running.
 * Every event is handed to the offline-first sync engine.
 */
export function useTripSensors({ active, engine, motionPermission }: {
  active: boolean; engine: MutableRefObject<Engine | null>; motionPermission: MotionPermission;
}): TripSensors {
  const [gps, setGps] = useState<GpsState>("idle");
  const [fix, setFix] = useState<Fix | null>(null);
  const [battery, setBattery] = useState<{ pct: number; charging: boolean } | null>(null);
  const [wake, setWake] = useState<WakeState>("idle");
  const [appState, setAppState] = useState<AppState>("FOREGROUND");
  const [lowBattery, setLowBattery] = useState(false);
  const [wasBackgrounded, setWasBackgrounded] = useState(false);
  const [motion, setMotion] = useState<MotionState>("idle");
  const [lastImpact, setLastImpact] = useState<LastImpact | null>(null);
  const [haptics, setHaptics] = useState<"ready" | "locked" | "unsupported">("ready");

  const latest = useRef<Fix | null>(null);
  const batt = useRef<{ pct: number; charging: boolean } | null>(null);
  const appRef = useRef<AppState>("FOREGROUND");
  const lowWarned = useRef(false);
  const startWatch = useRef<() => void>(() => {});
  const retryGps = () => startWatch.current();
  const dismissBackground = () => setWasBackgrounded(false);

  const sendIncident = (type: string, message: string, extra: Record<string, unknown> = {}, keepalive = false) => {
    const e = engine.current; if (!e) return;
    const f = latest.current;
    void e.send({ kind: "incident", clientEventId: makeEventId(), ts: e.now(), type, message, lat: f?.lat ?? null, lng: f?.lng ?? null, ...extra }, { keepalive });
  };

  // ---- GPS + battery + wake lock + visibility -------------------------------------------------------------------
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let watchId: number | null = null;
    let sentinel: { release: () => Promise<void>; addEventListener: (t: string, f: () => void) => void } | null = null;
    let batteryMgr: BatteryManagerLike | null = null;
    let firstSent = false;

    const sendPing = () => {
      const f = latest.current, e = engine.current;
      if (!f || !e || Date.now() - f.at > STALE_FIX_MS) return;       // no fresh fix: send nothing rather than a stale position
      void e.send({ kind: "ping", clientEventId: makeEventId(), ts: e.now(), lat: f.lat, lng: f.lng, speedKmh: f.speedKmh, accuracyM: f.accuracyM,
        heading: f.heading, batteryPct: batt.current?.pct ?? null, charging: batt.current?.charging ?? null, appState: appRef.current });
    };

    function begin() {
      if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (!("geolocation" in navigator)) { setGps("unsupported"); return; }
      setGps("waiting");
      watchId = navigator.geolocation.watchPosition(
        (p) => {
          const f: Fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: cleanNumber(p.coords.accuracy),
            speedKmh: msToKmh(p.coords.speed), heading: cleanHeading(p.coords.heading), at: Date.now() };
          latest.current = f; setFix(f); setGps("ok");
          if (!firstSent) { firstSent = true; sendPing(); }      // first fix goes out immediately; later ones are throttled
        },
        (e) => setGps(e.code === 1 ? "denied" : "unavailable"),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    }
    startWatch.current = () => { firstSent = false; begin(); };
    begin();
    const timer = setInterval(sendPing, SEND_INTERVAL_MS);

    async function acquireWake() {
      if (stopped) return;
      const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<NonNullable<typeof sentinel>> } }).wakeLock;
      if (!wl) { setWake("unsupported"); return; }
      try {
        const s = await wl.request("screen");
        if (stopped) { s.release().catch(() => {}); return; }
        sentinel = s; setWake("on");
        s.addEventListener("release", () => { if (!stopped) setWake("off"); });
      } catch { if (!stopped) setWake("off"); }
    }
    acquireWake();

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        appRef.current = "BACKGROUNDED"; setAppState("BACKGROUNDED");
        sendIncident("BACKGROUNDED", "Driver switched away from the app", {}, true);
      } else {
        appRef.current = "FOREGROUND"; setAppState("FOREGROUND"); setWasBackgrounded(true);
        sendIncident("FOREGROUNDED", "Driver returned to the app");
        acquireWake();                                         // the browser drops the wake lock whenever the page is hidden
        startWatch.current();                                  // and some browsers stop GPS in the background
      }
    };
    document.addEventListener("visibilitychange", onVis);

    const updateBattery = () => {
      if (!batteryMgr || stopped) return;
      const b = { pct: Math.round(batteryMgr.level * 100), charging: !!batteryMgr.charging };
      batt.current = b; setBattery(b);
      const r = lowBatteryNext(lowWarned.current, b.pct, b.charging);
      lowWarned.current = r.warned; setLowBattery(r.warned);
      if (r.warn) sendIncident("LOW_BATTERY", `Battery low (${b.pct}%)`);
    };
    const gb = (navigator as unknown as { getBattery?: () => Promise<BatteryManagerLike> }).getBattery;
    if (gb) gb.call(navigator).then((m) => {
      if (stopped) return;
      batteryMgr = m; m.addEventListener("levelchange", updateBattery); m.addEventListener("chargingchange", updateBattery); updateBattery();
    }).catch(() => {});

    return () => {
      stopped = true;
      clearInterval(timer);
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      document.removeEventListener("visibilitychange", onVis);
      batteryMgr?.removeEventListener("levelchange", updateBattery); batteryMgr?.removeEventListener("chargingchange", updateBattery);
      sentinel?.release().catch(() => {});
      latest.current = null; batt.current = null; lowWarned.current = false; appRef.current = "FOREGROUND";
      setGps("idle"); setFix(null); setBattery(null); setWake("idle"); setAppState("FOREGROUND"); setLowBattery(false); setWasBackgrounded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---- Accelerometer: impact / pothole detection + haptics -----------------------------------------------------
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") { setMotion("unsupported"); return; }
    const needsPermission = typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown }).requestPermission === "function";   // iOS 13+
    if (needsPermission && motionPermission !== "granted") { setMotion(motionPermission === "denied" ? "denied" : "needs-tap"); return; }

    setMotion("waiting");
    const detector = createImpactDetector(IMPACT_THRESHOLD_G, IMPACT_COOLDOWN_MS);
    let gotData = false;
    const noData = setTimeout(() => { if (!gotData) setMotion("unsupported"); }, 4000);   // e.g. a desktop browser that never fires motion events

    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      if (!gotData) { gotData = true; clearTimeout(noData); setMotion("on"); }
      const g = resultantG(a.x, a.y, a.z);
      if (!detector.feed(g, Date.now())) return;
      const type = classifyImpact(g);
      const rounded = Math.round(g * 100) / 100;
      sendIncident(type, `${type === "IMPACT" ? "Severe impact" : "Pothole / road shock"}: ${rounded.toFixed(1)} G`, { gForce: rounded });
      try { navigator.vibrate?.([200, 100, 200]); } catch { /* vibration blocked or unsupported */ }   // tactile double-buzz (Android; iOS has no Vibration API)
      setLastImpact({ g: rounded, type, at: Date.now() });
    };
    window.addEventListener("devicemotion", onMotion);
    return () => { clearTimeout(noData); window.removeEventListener("devicemotion", onMotion); setMotion("idle"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, motionPermission]);

  // Vibration needs a user gesture: the Start Trip tap unlocks it. After a refresh the page must be tapped once.
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("vibrate" in navigator)) { setHaptics("unsupported"); return; }
    const ua = (navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation;
    setHaptics(ua && !ua.hasBeenActive ? "locked" : "ready");
    const unlock = () => setHaptics("ready");
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [active]);

  return { gps, speedKmh: fix?.speedKmh ?? null, accuracyM: fix?.accuracyM ?? null, battery, wake, appState, lowBattery, wasBackgrounded,
    motion, lastImpact, haptics, retryGps, dismissBackground };
}
