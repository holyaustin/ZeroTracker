"use client";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type * as Lf from "leaflet";
import { STATUS_LABEL, type Incident, type LiveStatus, type VehicleLive } from "@/lib/fleetLogic";

export type MapVehicle = VehicleLive & { status: LiveStatus };
export type RouteData = {
  vehicleId: string; label: string; points: { t: number; lat: number; lng: number; s: number | null }[];
  impacts: { id: number; type: string; gForce: number | null; lat: number; lng: number; ts: number; message: string | null }[];
};
type Props = {
  vehicles: MapVehicle[]; impacts: Incident[]; route: RouteData | null; selectedId: string | null;
  focus: { lat: number; lng: number; nonce: number } | null; fitNonce: number; now: number; onSelect: (id: string) => void;
};

const CARTO = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ERRORS_BEFORE_FALLBACK = 3;

export const ago = (ts: number | null, now: number) => {
  if (ts == null) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// DOM nodes with textContent (never HTML strings): vehicle labels and messages are user-controlled text.
function el(tag: string, cls?: string, text?: string) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function row(k: string, v: string) { const r = el("div", "zt-row"); r.append(el("span", undefined, k), el("span", undefined, v)); return r; }

function vehiclePopup(v: MapVehicle, now: number) {
  const d = el("div", "zt-popup"); d.dataset.popup = "vehicle";
  d.append(el("div", "zt-title", v.label));
  if (v.plateNumber || v.driverName) d.append(el("div", "zt-sub", [v.plateNumber, v.driverName].filter(Boolean).join(" · ")));
  d.append(row("Status", STATUS_LABEL[v.status]));
  d.append(row("Speed", v.speedKmh == null ? "—" : `${Math.round(v.speedKmh)} km/h`));
  d.append(row("Battery", v.batteryPct == null ? "n/a" : `${v.batteryPct}%`));
  d.append(row("Last seen", ago(v.lastSeenAt, now)));
  return d;
}
function impactPopup(i: { type: string; gForce: number | null; ts: number; message: string | null }, label: string) {
  const d = el("div", "zt-popup"); d.dataset.popup = "impact";
  d.append(el("div", "zt-title", i.type === "IMPACT" ? "Severe impact" : "Pothole / road shock"));
  d.append(el("div", "zt-sub", label));
  if (i.gForce != null) d.append(row("Force", `${i.gForce.toFixed(1)} G`));
  d.append(row("Time", new Date(i.ts).toLocaleString()));
  if (i.message) d.append(el("div", "zt-sub", i.message));
  return d;
}

export default function FleetMap({ vehicles, impacts, route, selectedId, focus, fitNonce, now, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const LRef = useRef<typeof Lf | null>(null);
  const mapRef = useRef<Lf.Map | null>(null);
  const vMarkers = useRef(new Map<string, { m: Lf.Marker; status: string; label: string }>());
  const iMarkers = useRef(new Map<string, Lf.Marker>());
  const routeLayer = useRef<Lf.LayerGroup | null>(null);
  const latest = useRef(new Map<string, MapVehicle>());
  const nowRef = useRef(now); nowRef.current = now;
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [tiles, setTiles] = useState<"carto" | "osm">("carto");

  // ---- create the map once (Leaflet needs the browser, so it is imported lazily) ------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import("leaflet");
      const L = ((mod as unknown as { default?: typeof Lf }).default ?? mod) as typeof Lf;
      if (cancelled || !box.current) return;
      LRef.current = L;
      const map = L.map(box.current, { zoomControl: true, scrollWheelZoom: false, worldCopyJump: true }).setView([9.08, 8.68], 6);
      const carto = L.tileLayer(CARTO, { subdomains: "abcd", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' });
      const osm = L.tileLayer(OSM, { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
      let errors = 0, fellBack = false;
      carto.on("tileerror", () => {      // CARTO blocked or down: switch to OpenStreetMap (darkened with a CSS filter)
        if (++errors >= TILE_ERRORS_BEFORE_FALLBACK && !fellBack) {
          fellBack = true; map.removeLayer(carto); osm.addTo(map);
          box.current?.classList.add("osm-dark"); setTiles("osm");
        }
      });
      carto.addTo(map);
      routeLayer.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setReady(true);
    })();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; vMarkers.current.clear(); iMarkers.current.clear(); setReady(false); };
  }, []);

  // ---- vehicle markers -----------------------------------------------------------------------------------------------
  useEffect(() => {
    const L = LRef.current, map = mapRef.current; if (!ready || !L || !map) return;
    const live = new Set<string>();
    for (const v of vehicles) {
      latest.current.set(v.id, v);
      if (v.status === "waiting" || v.lat == null || v.lng == null) continue;
      live.add(v.id);
      const have = vMarkers.current.get(v.id);
      if (!have) {
        const icon = L.divIcon({ html: (() => { const e = el("div", `zt-marker zt-${v.status}`); e.dataset.vehicle = v.label; e.dataset.status = v.status; return e; })(), className: "zt-wrap", iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] });
        const m = L.marker([v.lat, v.lng], { icon, title: v.label, keyboard: true }).addTo(map);
        m.bindPopup(() => vehiclePopup(latest.current.get(v.id) ?? v, nowRef.current));
        m.on("click", () => onSelectRef.current(v.id));
        vMarkers.current.set(v.id, { m: m, status: v.status, label: v.label });
      } else {
        have.m.setLatLng([v.lat, v.lng]);
        if (have.status !== v.status || have.label !== v.label) {
          const e = el("div", `zt-marker zt-${v.status}`); e.dataset.vehicle = v.label; e.dataset.status = v.status;
          have.m.setIcon(L.divIcon({ html: e, className: "zt-wrap", iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] }));
          have.status = v.status; have.label = v.label;
        }
        const pop = have.m.getPopup();
        if (pop?.isOpen()) pop.setContent(vehiclePopup(v, nowRef.current));
      }
    }
    for (const [id, x] of vMarkers.current) if (!live.has(id)) { x.m.remove(); vMarkers.current.delete(id); latest.current.delete(id); }
    if (!fitted.current && vMarkers.current.size) {
      fitted.current = true;
      const pts = [...vMarkers.current.values()].map((x) => x.m.getLatLng());
      map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 15 });
    }
  }, [ready, vehicles, now]);

  // ---- red impact / pothole markers ----------------------------------------------------------------------------------
  useEffect(() => {
    const L = LRef.current, map = mapRef.current; if (!ready || !L || !map) return;
    const keep = new Set<string>();
    for (const i of impacts) {
      if (i.lat == null || i.lng == null) continue;
      const key = `${i.vehicleId}|${i.ts}`; keep.add(key);
      if (iMarkers.current.has(key)) continue;
      const icon = L.divIcon({ html: el("div", "zt-impact", "!"), className: "zt-wrap", iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] });
      const m = L.marker([i.lat, i.lng], { icon, title: i.type, zIndexOffset: 500 }).addTo(map);
      m.bindPopup(() => impactPopup(i, i.label));
      iMarkers.current.set(key, m);
    }
    for (const [k, m] of iMarkers.current) if (!keep.has(k)) { m.remove(); iMarkers.current.delete(k); }
  }, [ready, impacts]);

  // ---- historical route ----------------------------------------------------------------------------------------------
  useEffect(() => {
    const L = LRef.current, map = mapRef.current, g = routeLayer.current; if (!ready || !L || !map || !g) return;
    g.clearLayers();
    if (!route || route.points.length === 0) return;
    const ll = route.points.map((p) => [p.lat, p.lng] as [number, number]);
    if (ll.length > 1) L.polyline(ll, { className: "zt-route", color: "#22d3ee", weight: 4, opacity: 0.9, lineJoin: "round" }).addTo(g);   // one point has no line to draw
    const pt = (cls: string, p: [number, number], title: string) =>
      L.marker(p, { icon: L.divIcon({ html: el("div", `zt-pt ${cls}`), className: "zt-wrap", iconSize: [20, 20], iconAnchor: [10, 10] }), title, interactive: false }).addTo(g);
    pt("zt-route-start", ll[0], "Route start"); pt("zt-route-end", ll[ll.length - 1], "Route end");
    for (const i of route.impacts) {
      const m = L.marker([i.lat, i.lng], { icon: L.divIcon({ html: el("div", "zt-impact zt-impact-route", "!"), className: "zt-wrap", iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -10] }), title: i.type, zIndexOffset: 600 }).addTo(g);
      m.bindPopup(() => impactPopup(i, route.label));
    }
    map.fitBounds(L.latLngBounds(ll), { padding: [48, 48], maxZoom: 17 });
  }, [ready, route]);

  // ---- selection, focus, fit -----------------------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current; if (!ready || !map || !selectedId) return;
    const x = vMarkers.current.get(selectedId); if (!x) return;
    map.panTo(x.m.getLatLng()); x.m.openPopup();
  }, [ready, selectedId]);
  useEffect(() => { const map = mapRef.current; if (ready && map && focus) map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), 15), { duration: 0.8 }); }, [ready, focus]);
  useEffect(() => {
    const L = LRef.current, map = mapRef.current; if (!ready || !L || !map || !fitNonce || !vMarkers.current.size) return;
    map.fitBounds(L.latLngBounds([...vMarkers.current.values()].map((x) => x.m.getLatLng())), { padding: [48, 48], maxZoom: 15 });
  }, [ready, fitNonce]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl border border-white/10">
      <div ref={box} className="h-full w-full" data-testid="map" data-tiles={tiles} data-ready={ready ? "1" : "0"} />
      <div className="pointer-events-none absolute bottom-3 left-3 z-[500] flex flex-wrap gap-x-3 gap-y-1 rounded-xl bg-slate-950/80 px-3 py-2 text-[11px] text-slate-300 backdrop-blur">
        {([["#34d399", "Moving"], ["#38bdf8", "Idle"], ["#fbbf24", "Background"], ["#64748b", "Offline"], ["#ef4444", "Impact"]] as const).map(([c, t]) => (
          <span key={t} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{t}</span>
        ))}
      </div>
    </div>
  );
}
