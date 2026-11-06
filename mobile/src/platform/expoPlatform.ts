import { AppState, Vibration } from "react-native";
import * as Location from "expo-location";
import * as Battery from "expo-battery";
import { Accelerometer } from "expo-sensors";
import NetInfo from "@react-native-community/netinfo";
import type { Platform, RawFix } from "../core/tripController";
import { LOCATION_TASK, setFixHandler } from "./locationBridge";

export const expoPlatform: Platform = {
  async startLocation(onFix, onError) {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== "granted") { onError(true); throw new Error("location permission denied"); }
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: "denied" }));

    if (bg.status === "granted") {
      // Background-capable: an Android foreground service (persistent notification) / iOS background location keeps GPS running with the screen off.
      setFixHandler(onFix);
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation, timeInterval: 5000, distanceInterval: 0,
        pausesUpdatesAutomatically: false, activityType: Location.ActivityType.AutomotiveNavigation, showsBackgroundLocationIndicator: true,
        foregroundService: { notificationTitle: "ZeroTracker is sharing your location", notificationBody: "Trip in progress. Tap to open.", notificationColor: "#34d399" },
      });
      return { background: true, stop: async () => { setFixHandler(null); if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK); } };
    }
    // "All the time" not granted: foreground-only tracking (stops when the screen turns off). The UI tells the driver.
    const sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 5000, distanceInterval: 0 }, (l) => onFix(l.coords as RawFix));
    return { background: false, stop: () => sub.remove() };
  },

  startMotion(onSample) {
    Accelerometer.setUpdateInterval(20);
    const sub = Accelerometer.addListener(({ x, y, z }) => onSample(Math.sqrt(x * x + y * y + z * z)));   // expo reports g, gravity included
    return () => sub.remove();
  },

  async startBattery(onChange) {
    const read = async () => {
      const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
      if (level >= 0) onChange({ pct: Math.round(level * 100), charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL });
    };
    await read();
    const a = Battery.addBatteryLevelListener(() => void read()), b = Battery.addBatteryStateListener(() => void read());
    return () => { a.remove(); b.remove(); };
  },

  watchAppState(onChange) {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") onChange("FOREGROUND"); else if (s === "background") onChange("BACKGROUNDED"); });
    return () => sub.remove();   // "inactive" (iOS transitions, e.g. Control Centre) is deliberately ignored
  },

  vibrate: (pattern) => Vibration.vibrate([0, ...pattern]),
};

/** Connectivity as the sync engine wants it: a yes/no plus online/offline events. */
export function createNetwork() {
  let online = true;
  const listeners = { online: new Set<() => void>(), offline: new Set<() => void>() };
  NetInfo.addEventListener((s) => {
    const now = !!s.isConnected && s.isInternetReachable !== false;
    if (now === online) return;
    online = now; (now ? listeners.online : listeners.offline).forEach((f) => f());
  });
  return {
    isOnline: () => online,
    target: {
      addEventListener: (t: string, f: () => void) => { (t === "online" ? listeners.online : listeners.offline).add(f); },
      removeEventListener: (t: string, f: () => void) => { (t === "online" ? listeners.online : listeners.offline).delete(f); },
    },
  };
}
