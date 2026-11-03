// Pure, dependency-free helpers for the driver client (unit-tested in test/unit.mjs).

export const SEND_INTERVAL_MS = 5000;        // position is sent about every 5 seconds
export const STALE_FIX_MS = 30_000;          // never send a position older than this as if it were fresh
export const LOW_BATTERY_PCT = 20;
export const LOW_BATTERY_REARM_PCT = 25;

/** Geolocation gives metres per second (or null). Convert to km/h, one decimal; null stays null. */
export function msToKmh(mps: number | null | undefined): number | null {
  if (typeof mps !== "number" || !Number.isFinite(mps)) return null;
  return Math.round(Math.max(0, mps) * 3.6 * 10) / 10;
}

/**
 * Low-battery warning state machine. `warn` is true only on the transition into low
 * (so one incident per discharge). Plugging in, or recovering above the re-arm level, re-arms it.
 */
export function lowBatteryNext(prevWarned: boolean, pct: number | null, charging: boolean | null) {
  if (pct == null) return { warn: false, warned: prevWarned };
  if (charging || pct >= LOW_BATTERY_REARM_PCT) return { warn: false, warned: false };
  if (pct <= LOW_BATTERY_PCT && !prevWarned) return { warn: true, warned: true };
  return { warn: false, warned: prevWarned };
}

export const cleanNumber = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

/** Heading is only meaningful 0..360. */
export const cleanHeading = (h: number | null | undefined): number | null => {
  const v = cleanNumber(h);
  return v == null || v < 0 || v > 360 ? null : v;
};

export function makeEventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** Server clock minus device clock, so ts is right even when the phone's clock is wrong. */
export const clockSkew = (serverNow: number, deviceNow: number) => serverNow - deviceNow;

// ---------------------------------------------------------------------------------------------------------
// Impact / pothole detection
// ---------------------------------------------------------------------------------------------------------
export const G = 9.81;                    // m/s² per g
export const IMPACT_THRESHOLD_G = 3.6;    // resultant 3-axis force at or above this is flagged
export const IMPACT_COOLDOWN_MS = 3000;   // after a detection, ignore further spikes for 3 seconds
export const SEVERE_IMPACT_G = 6;         // at or above this it's a collision-grade IMPACT; below, a road shock (POTHOLE)

/** Resultant 3-axis force in g. Phone at rest reads ~1 g (gravity). */
export const resultantG = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z) / G;

export const classifyImpact = (g: number): "IMPACT" | "POTHOLE" => (g >= SEVERE_IMPACT_G ? "IMPACT" : "POTHOLE");

/** Debounced detector: feed() returns true for a detection, then stays quiet until the cooldown has passed. */
export function createImpactDetector(thresholdG = IMPACT_THRESHOLD_G, cooldownMs = IMPACT_COOLDOWN_MS) {
  let last = -Infinity;
  return {
    feed(g: number, nowMs: number): boolean {
      if (!Number.isFinite(g) || g < thresholdG) return false;
      if (nowMs - last < cooldownMs) return false;
      last = nowMs;
      return true;
    },
  };
}

/** Exponential backoff with jitter: 1s, 2s, 4s ... capped at 30s (base is injectable for tests). */
export function backoffMs(attempt: number, rand = Math.random(), baseMs = 1000, capMs = 30_000) {
  return Math.round(Math.min(capMs, baseMs * 2 ** attempt) * (0.8 + 0.4 * rand));
}
