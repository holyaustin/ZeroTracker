import React, { useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { c } from "../theme";
import type { TripState } from "../core/tripController";
import { Brand, DangerButton, Notice, PrimaryButton, Screen, Tile, s } from "./widgets";

export function LinkScreen({ onSubmit }: { onSubmit: (text: string) => Promise<string | null> }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <Screen>
      <Brand />
      <Text style={s.h1}>Connect your vehicle</Text>
      <Text style={s.p}>Paste the tracking link your fleet manager sent you (for example from WhatsApp). You only need to do this once.</Text>
      <TextInput value={text} onChangeText={setText} placeholder="https://…/d/…" placeholderTextColor={c.faint} autoCapitalize="none" autoCorrect={false}
        multiline style={{ marginTop: 22, minHeight: 90, color: c.text, borderColor: c.border, borderWidth: 1, borderRadius: 14, padding: 14, fontSize: 15, backgroundColor: "rgba(2,6,23,0.6)" }} />
      {err ? <View style={{ marginTop: 12 }}><Notice tone="rose">{err}</Notice></View> : null}
      <View style={{ marginTop: 16 }}>
        <PrimaryButton label={busy ? "Checking…" : "Connect"} disabled={busy || !text.trim()}
          onPress={async () => { setBusy(true); setErr(null); const e = await onSubmit(text); setBusy(false); if (e) setErr(e); }} />
      </View>
    </Screen>
  );
}

export function ConsentScreen({ vehicle, org, onAgree }: { vehicle: string; org: string; onAgree: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <Screen>
      <Brand org={org} />
      <Text style={s.h1}>Before you start</Text>
      <Text style={s.p}><Text style={{ color: c.text, fontWeight: "700" }}>{org}</Text> will see this phone's location, speed, battery level and road-impact readings while a trip is running, so they can track <Text style={{ color: c.text, fontWeight: "700" }}>{vehicle}</Text>.</Text>
      <Text style={[s.p, { marginTop: 14 }]}>• Sharing happens only while a trip is ON. A notification stays visible while sharing.{"\n"}• You can end the trip at any time.{"\n"}• Your manager can cancel this link at any time.</Text>
      <Pressable onPress={() => setOk(!ok)} accessibilityRole="checkbox" accessibilityState={{ checked: ok }}
        style={{ flexDirection: "row", gap: 12, marginTop: 22, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.card }}>
        <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: ok ? c.green : c.faint, backgroundColor: ok ? c.green : "transparent", alignItems: "center", justifyContent: "center" }}>
          {ok ? <Text style={{ color: c.onAccent, fontWeight: "800" }}>✓</Text> : null}
        </View>
        <Text style={{ color: c.text, flex: 1, fontSize: 14, lineHeight: 20 }}>I understand and agree to share my location and phone sensor data with {org} during trips.</Text>
      </Pressable>
      <View style={{ marginTop: 18 }}><PrimaryButton label="Agree & continue" disabled={!ok} onPress={onAgree} /></View>
    </Screen>
  );
}

export function ReadyScreen({ vehicle, org, onStart, onForget }: { vehicle: string; org: string; onStart: () => void; onForget: () => void }) {
  return (
    <Screen>
      <Brand org={org} />
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text style={{ color: c.muted, fontSize: 15 }}>You are assigned to</Text>
        <Text style={[s.h1, { fontSize: 32, marginTop: 4, textAlign: "center" }]}>{vehicle}</Text>
        <Text style={[s.p, { textAlign: "center", maxWidth: 300 }]}>Tap Start when you begin your trip. When asked, allow location <Text style={{ color: c.text, fontWeight: "700" }}>"all the time"</Text> so tracking keeps working with the screen off.</Text>
      </View>
      <PrimaryButton big label="Start Trip" onPress={onStart} />
      <Pressable onPress={onForget} style={{ marginTop: 18, alignItems: "center" }}><Text style={{ color: c.faint, fontSize: 13, textDecorationLine: "underline" }}>Use a different link</Text></Pressable>
    </Screen>
  );
}

const fmt = (ms: number) => { const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return `${h ? h + ":" : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(t % 60).padStart(2, "0")}`; };

const GPS: Record<string, { text: string; col: string }> = {
  ok: { text: "Location sharing is ON", col: c.green }, waiting: { text: "Waiting for GPS signal…", col: c.amber }, unavailable: { text: "GPS signal lost. Searching…", col: c.amber },
  denied: { text: "Location blocked. Sharing is OFF", col: c.rose }, idle: { text: "Starting…", col: c.slate },
};

export function ActiveScreen({ vehicle, org, trip, now, startedAt, onEnd }: { vehicle: string; org: string; trip: TripState; now: number; startedAt: number | null; onEnd: () => void }) {
  const g = GPS[trip.gps] ?? GPS.idle;
  const motionText = { on: "Active", waiting: "Starting…", unsupported: "Not available", idle: "—" }[trip.motion];
  return (
    <Screen style={{ paddingBottom: 0 }}>
      <Brand org={org} />
      <ScrollView contentContainerStyle={{ paddingBottom: 130 }} showsVerticalScrollIndicator={false}>
        <View style={{ alignItems: "center" }}>
          <View accessibilityRole="header" style={{ flexDirection: "row", gap: 8, alignItems: "center", borderRadius: 999, borderWidth: 1, borderColor: g.col + "55", backgroundColor: g.col + "18", paddingHorizontal: 16, paddingVertical: 8 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: g.col }} />
            <Text style={{ color: g.col, fontWeight: "600", fontSize: 14 }}>{g.text}</Text>
          </View>
          <Text style={[s.h1, { marginTop: 20 }]}>{vehicle}</Text>
          <Text style={{ color: c.text, fontSize: 40, fontWeight: "600", marginTop: 2, fontVariant: ["tabular-nums"] }}>{fmt(now - (startedAt ?? now))}</Text>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 20 }}>
          <Tile label="Speed" value={trip.speedKmh == null ? "—" : String(Math.round(trip.speedKmh))} unit="km/h" />
          <Tile label="GPS accuracy" value={trip.accuracyM == null ? "—" : `±${Math.round(trip.accuracyM)}`} unit="m" />
          <Tile label="Battery" value={trip.battery ? String(trip.battery.pct) : "n/a"} unit={trip.battery ? (trip.battery.charging ? "% ⚡" : "%") : ""} />
          <Tile label="Last sent" value={trip.lastSentAt ? `${Math.max(0, Math.round((now - trip.lastSentAt) / 1000))}s` : "—"} unit={trip.lastSentAt ? "ago" : ""} />
          <Tile label="Impact sensor" value={motionText} />
          <Tile label="Saved offline" value={String(trip.queued)} unit="pts" />
        </View>

        <View style={{ marginTop: 16 }}>
          {trip.gps === "denied" ? <Notice tone="rose" action={{ label: "Open settings", onPress: () => Linking.openSettings() }}>Location is blocked. Allow it for ZeroTracker in your phone settings.</Notice> : null}
          {trip.gps !== "denied" && !trip.backgroundTracking ? (
            <Notice tone="amber" action={{ label: "Open settings", onPress: () => Linking.openSettings() }}>Tracking will pause when the screen turns off. In settings, set Location to "Allow all the time".</Notice>
          ) : null}
          {trip.lowBattery ? <Notice tone="rose">Battery low ({trip.battery?.pct}%). Plug in your phone so tracking doesn't stop.</Notice> : null}
          {trip.lastImpact && now - trip.lastImpact.at < 6000 ? <Notice tone="rose">{trip.lastImpact.type === "IMPACT" ? "Severe impact" : "Road shock"} detected ({trip.lastImpact.g.toFixed(1)} G). Your manager has been alerted.</Notice> : null}
          {trip.connection === "offline" ? <Notice tone="amber">No connection. {trip.queued > 0 ? `${trip.queued} saved on your phone and will sync automatically.` : "Reconnecting…"}</Notice> : null}
          {trip.connection === "online" && trip.queued > 0 ? <Notice tone="slate">Syncing {trip.queued} saved point{trip.queued === 1 ? "" : "s"}…</Notice> : null}
          {trip.backgroundTracking ? <Notice tone="slate">Tracking continues with the screen off. The notification shows while sharing.</Notice> : null}
        </View>
      </ScrollView>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingBottom: 28, paddingTop: 14, backgroundColor: c.bg + "ee" }}>
        <DangerButton label="End trip" onPress={onEnd} />
      </View>
    </Screen>
  );
}

const LOCK: Record<string, { title: string; body: string }> = {
  REVOKED: { title: "Access revoked by your manager", body: "Location sharing has stopped. Ask your fleet manager for a new link if you need to continue." },
  ORG_DISABLED: { title: "Tracking is currently disabled", body: "Your company's account is not active, so location sharing is off. Contact your fleet manager." },
  INVALID: { title: "This link isn't valid", body: "Ask your fleet manager for a new link." },
};
export function LockedScreen({ code, onNewLink }: { code: string | null; onNewLink: () => void }) {
  const m = LOCK[code ?? "REVOKED"] ?? LOCK.REVOKED;
  return (
    <Screen>
      <Brand />
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text style={{ fontSize: 44 }}>🔒</Text>
        <Text style={[s.h1, { textAlign: "center", marginTop: 14 }]}>{m.title}</Text>
        <Text style={[s.p, { textAlign: "center" }]}>{m.body}</Text>
      </View>
      <PrimaryButton label="Enter a new link" onPress={onNewLink} />
    </Screen>
  );
}
