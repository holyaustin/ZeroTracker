import React from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { c } from "../theme";

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.screen, style]}>{children}</View>;
}
export function Brand({ org }: { org?: string }) {
  return (
    <View style={s.brandRow}>
      <View style={s.logo}><Text style={s.logoMark}>◉</Text></View>
      <Text style={s.brand}>Zero<Text style={{ color: c.green }}>Tracker</Text></Text>
      {org ? <Text style={s.org} numberOfLines={1}>{org}</Text> : null}
    </View>
  );
}
export function PrimaryButton({ label, onPress, disabled, big }: { label: string; onPress: () => void; disabled?: boolean; big?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={({ pressed }) => [s.primary, big && s.big, disabled && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
      <Text style={[s.primaryText, big && { fontSize: 22 }]}>{label}</Text>
    </Pressable>
  );
}
export function DangerButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [s.danger, pressed && { opacity: 0.8 }]}><Text style={s.dangerText}>{label}</Text></Pressable>;
}
export function Tile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={s.tile}>
      <Text style={s.tileLabel}>{label.toUpperCase()}</Text>
      <Text style={s.tileValue}>{value}<Text style={s.tileUnit}> {unit}</Text></Text>
    </View>
  );
}
export function Notice({ tone, children, action }: { tone: "rose" | "amber" | "slate"; children: React.ReactNode; action?: { label: string; onPress: () => void } }) {
  const col = tone === "rose" ? c.rose : tone === "amber" ? c.amber : c.slate;
  return (
    <View style={[s.notice, { borderColor: col + "55", backgroundColor: col + "18" }]} accessibilityRole="alert">
      <Text style={{ color: col, fontSize: 14, lineHeight: 20 }}>{children}</Text>
      {action ? <Pressable onPress={action.onPress}><Text style={[s.noticeAction, { color: col }]}>{action.label}</Text></Pressable> : null}
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg, paddingHorizontal: 24, paddingTop: 56, paddingBottom: 24 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 24 },
  logo: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.green, alignItems: "center", justifyContent: "center" },
  logoMark: { color: c.onAccent, fontSize: 18, fontWeight: "800" },
  brand: { color: c.text, fontSize: 17, fontWeight: "700" },
  org: { color: c.faint, fontSize: 12, marginLeft: "auto", maxWidth: 140 },
  h1: { color: c.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.3 },
  p: { color: c.muted, fontSize: 15, lineHeight: 22, marginTop: 10 },
  primary: { backgroundColor: c.green, borderRadius: 16, paddingVertical: 16, alignItems: "center", justifyContent: "center" },
  big: { paddingVertical: 28, borderRadius: 26 },
  primaryText: { color: c.onAccent, fontSize: 17, fontWeight: "700" },
  danger: { borderRadius: 16, paddingVertical: 18, alignItems: "center", borderWidth: 1, borderColor: c.rose + "66", backgroundColor: c.rose + "22" },
  dangerText: { color: "#fecdd3", fontSize: 18, fontWeight: "700" },
  tile: { flexBasis: "48%", flexGrow: 1, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 16, padding: 14 },
  tileLabel: { color: c.faint, fontSize: 11, letterSpacing: 1 },
  tileValue: { color: c.text, fontSize: 24, fontWeight: "700", marginTop: 4 },
  tileUnit: { color: c.muted, fontSize: 13, fontWeight: "400" },
  notice: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8 },
  noticeAction: { marginTop: 6, fontWeight: "700", fontSize: 14, textDecorationLine: "underline" },
});
