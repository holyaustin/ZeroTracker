import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, AppState, View } from "react-native";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { parseDriverLink, type DriverLink } from "./src/core/link";
import type { TripController, TripState } from "./src/core/tripController";
import { connect, endTrip, forget, getController, resumeIfTripActive, startTrip } from "./src/platform/runtime";
import { storage, type Binding } from "./src/platform/storage";
import { c } from "./src/theme";
import { ActiveScreen, ConsentScreen, LinkScreen, LockedScreen, ReadyScreen } from "./src/ui/screens";

const ERRORS: Record<string, string> = {
  INVALID: "This link isn't valid. Check that you pasted the whole link.", REVOKED: "This link was revoked by your manager. Ask for a new one.",
  ORG_DISABLED: "Tracking is disabled for your company right now.", RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
  NETWORK: "Can't reach the server. Check your internet connection.",
};

function useTrip(ctrl: TripController | null): TripState | null {
  const [state, setState] = useState<TripState | null>(ctrl ? ctrl.getState() : null);
  useEffect(() => {
    if (!ctrl) { setState(null); return; }
    setState(ctrl.getState());
    return ctrl.subscribe(() => setState(ctrl.getState()));
  }, [ctrl]);
  return state;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [consented, setConsented] = useState(false);
  const [ctrl, setCtrl] = useState<TripController | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const trip = useTrip(ctrl);

  useEffect(() => {
    (async () => {
      const b = await storage.binding();
      setBinding(b); setConsented(await storage.consent());
      if (b) { setCtrl((await resumeIfTripActive()) ?? (await getController())); setStartedAt(await storage.tripStartedAt()); }
      setBooting(false);
    })();
  }, []);

  const onLink = useCallback(async (link: DriverLink): Promise<string | null> => {
    const r = await connect(link);
    if (!r.ok) return ERRORS[r.code] ?? "Could not connect. Try again.";
    setBinding(r.binding); setConsented(await storage.consent()); setCtrl(await getController()); setStartedAt(null);
    return null;
  }, []);

  // Links tapped outside the app (zerotracker:// deep links) connect straight away.
  useEffect(() => {
    const handle = (url: string | null) => { const l = url ? parseDriverLink(url) : null; if (l) void onLink(l); };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, [onLink]);

  // The manager can revoke at any moment: re-check every 15 s and whenever the app comes to the front.
  useEffect(() => {
    if (!ctrl) return;
    void ctrl.session();
    const t = setInterval(() => void ctrl.session(), 15000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void ctrl.session(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [ctrl]);

  useEffect(() => { if (trip?.phase !== "active") return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [trip?.phase]);

  const start = async () => {
    Alert.alert("Allow location all the time", 'On the next screens choose "Allow all the time" so tracking keeps working when the screen is off. Sharing happens only while a trip is running.',
      [{ text: "Continue", onPress: async () => { await startTrip(); setStartedAt(Date.now()); } }]);
  };
  const newLink = async () => { await forget(); setBinding(null); setCtrl(null); setStartedAt(null); };

  if (booting) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: "center" }}><ActivityIndicator color={c.green} /></View>;
  let screen: React.ReactNode;
  if (!binding) screen = <LinkScreen onSubmit={(t) => { const l = parseDriverLink(t); return l ? onLink(l) : Promise.resolve(ERRORS.INVALID); }} />;
  else if (trip?.phase === "locked") screen = <LockedScreen code={trip.lockCode} onNewLink={newLink} />;
  else if (!consented) screen = <ConsentScreen vehicle={binding.vehicleLabel} org={binding.orgName} onAgree={async () => { await storage.setConsent(); setConsented(true); }} />;
  else if (trip?.phase === "active") screen = <ActiveScreen vehicle={binding.vehicleLabel} org={binding.orgName} trip={trip} now={now} startedAt={startedAt} onEnd={async () => { await endTrip(); setStartedAt(null); }} />;
  else screen = <ReadyScreen vehicle={binding.vehicleLabel} org={binding.orgName} onStart={start} onForget={newLink} />;
  return <><StatusBar style="light" />{screen}</>;
}
