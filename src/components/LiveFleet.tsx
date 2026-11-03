"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectAbly, type AblyRealtime } from "@/lib/ablyClient";
import { FEED_GROUPS, STATUS_LABEL, computeStatus, mergeIncidents, type Incident, type IncidentType, type LiveStatus, type VehicleLive } from "@/lib/fleetLogic";
import { channels } from "@/lib/channels";
import FleetMap, { ago, type MapVehicle, type RouteData } from "./FleetMap";
import IncidentFeed from "./IncidentFeed";

const DOT: Record<LiveStatus, string> = { moving: "bg-emerald-400", idle: "bg-sky-400", backgrounded: "bg-amber-400", offline: "bg-slate-500", waiting: "bg-slate-700" };
const DAY = 24 * 3600 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDur = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const input = "w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60";

type RouteResp = { vehicle: { id: string; label: string }; points: RouteData["points"]; impacts: RouteData["impacts"];
  totalPoints: number; sampled: boolean; summary: { distanceKm: number; durationMs: number; maxSpeedKmh: number | null; pointCount: number; impactCount: number } };

async function getJson<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

export default function LiveFleet({ orgId, initialVehicles, pollMs, realtime }: { orgId: string; initialVehicles: VehicleLive[]; pollMs: number; realtime: boolean }) {
  const [vehicles, setVehicles] = useState<VehicleLive[]>(initialVehicles);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; nonce: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [impacts, setImpacts] = useState<Incident[]>([]);

  const [group, setGroup] = useState("all");
  const [feedVehicle, setFeedVehicle] = useState("");
  const [feed, setFeed] = useState<Incident[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const filterRef = useRef({ group, vehicleId: feedVehicle });
  filterRef.current = { group, vehicleId: feedVehicle };

  const [histVehicle, setHistVehicle] = useState("");
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - DAY));
  const [to, setTo] = useState(() => toLocalInput(Date.now()));
  const [route, setRoute] = useState<RouteData | null>(null);
  const [routeInfo, setRouteInfo] = useState<RouteResp | null>(null);
  const [routeMsg, setRouteMsg] = useState<string | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);

  const withStatus: MapVehicle[] = useMemo(() => vehicles.map((v) => ({ ...v, status: computeStatus(v, now) })), [vehicles, now]);
  useEffect(() => { if (!histVehicle || !vehicles.some((v) => v.id === histVehicle)) setHistVehicle(vehicles[0]?.id ?? ""); }, [vehicles, histVehicle]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  const feedUrl = (g: string, vid: string, before?: string | null) => {
    const p = new URLSearchParams({ limit: "50" });
    const types = FEED_GROUPS[g]?.types; if (types) p.set("type", types.join(","));
    if (vid) p.set("vehicleId", vid); if (before) p.set("before", before);
    return `/api/incidents?${p}`;
  };
  const matches = (i: Incident) => {
    const { group: g, vehicleId } = filterRef.current; const types = FEED_GROUPS[g]?.types as IncidentType[] | null;
    return (!types || types.includes(i.type)) && (!vehicleId || i.vehicleId === vehicleId);
  };

  const loadFeed = useCallback(async (g: string, vid: string) => {
    setFeedLoading(true);
    const r = await getJson<{ incidents: Incident[]; nextCursor: string | null }>(feedUrl(g, vid));
    if (filterRef.current.group === g && filterRef.current.vehicleId === vid) { setFeed(r?.incidents ?? []); setCursor(r?.nextCursor ?? null); setFeedLoading(false); }
  }, []);
  useEffect(() => { setFeed([]); setCursor(null); void loadFeed(group, feedVehicle); }, [group, feedVehicle, loadFeed]);

  async function loadMore() {
    if (!cursor) return; setFeedLoading(true);
    const r = await getJson<{ incidents: Incident[]; nextCursor: string | null }>(feedUrl(group, feedVehicle, cursor));
    if (r) { setFeed((p) => mergeIncidents(p, r.incidents, 5000)); setCursor(r.nextCursor); }
    setFeedLoading(false);
  }

  const refetchLive = useCallback(async () => { const r = await getJson<{ vehicles: VehicleLive[] }>("/api/fleet/live"); if (r) setVehicles(r.vehicles); }, []);
  const refetchImpacts = useCallback(async () => {
    const r = await getJson<{ incidents: Incident[] }>(`/api/incidents?type=IMPACT,POTHOLE&since=${Date.now() - DAY}&limit=200`);
    if (r) setImpacts((p) => mergeIncidents(p.filter((x) => x.ts >= Date.now() - DAY), r.incidents, 200));
  }, []);
  useEffect(() => { void refetchImpacts(); }, [refetchImpacts]);

  // ---- realtime (Ably) + polling safety net -------------------------------------------------------------------------
  useEffect(() => {
    let stopped = false; let ably: AblyRealtime | undefined;
    const apply = (name: string, d: Record<string, unknown>) => {
      const vid = d.vehicleId as string;
      if (name === "position") {
        setVehicles((prev) => {
          if (!prev.some((v) => v.id === vid)) { void refetchLive(); return prev; }
          return prev.map((v) => v.id !== vid ? v : { ...v, lat: d.lat as number, lng: d.lng as number, speedKmh: (d.speedKmh as number | null) ?? null,
            batteryPct: (d.batteryPct as number | null) ?? null, appState: d.appState as VehicleLive["appState"], online: true, lastSeenAt: Date.now(), lastTs: d.ts as number });
        });
      } else if (name === "vehicle-status") {
        setVehicles((prev) => prev.map((v) => v.id !== vid ? v : { ...v, online: !!d.online, ...(d.appState ? { appState: d.appState as VehicleLive["appState"] } : {}), ...(d.online ? { lastSeenAt: Date.now() } : {}) }));
      } else if (name === "incident") {
        const inc: Incident = { vehicleId: vid, label: (d.label as string) ?? "", type: d.type as IncidentType, gForce: (d.gForce as number | null) ?? null,
          lat: (d.lat as number | null) ?? null, lng: (d.lng as number | null) ?? null, message: (d.message as string | null) ?? null, ts: d.ts as number };
        if (matches(inc)) setFeed((p) => mergeIncidents(p, [inc], 5000));
        if ((inc.type === "IMPACT" || inc.type === "POTHOLE") && inc.lat != null) setImpacts((p) => mergeIncidents(p, [inc], 200));
        if (inc.type === "DISCONNECTED") setVehicles((p) => p.map((v) => v.id === vid ? { ...v, online: false } : v));
      } else if (name === "vehicle-added") void refetchLive();
      else if (name === "vehicle-removed") { setVehicles((p) => p.filter((v) => v.id !== vid)); setSelected((s) => (s === vid ? null : s)); }
    };
    if (realtime) {
      connectAbly({ authUrl: "/api/realtime/token" }).then((c) => {
        if (stopped) { c.close(); return; }
        ably = c;
        c.channels.get(channels.fleet(orgId)).subscribe((m) => apply(m.name, (m.data ?? {}) as Record<string, unknown>));
      }).catch(() => { /* polling still covers us */ });
    }
    const poll = async () => {
      await Promise.all([
        refetchLive(), refetchImpacts(),
        (async () => { const f = filterRef.current; const r = await getJson<{ incidents: Incident[] }>(feedUrl(f.group, f.vehicleId)); if (r && !stopped && filterRef.current.group === f.group && filterRef.current.vehicleId === f.vehicleId) setFeed((p) => mergeIncidents(p, r.incidents, 5000)); })(),
      ]);
    };
    const timer = setInterval(poll, pollMs);
    return () => { stopped = true; clearInterval(timer); ably?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, pollMs, realtime]);

  // ---- history -----------------------------------------------------------------------------------------------------------
  const preset = (ms: number | "today") => {
    const end = Date.now(); const start = ms === "today" ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : end - ms;
    setFrom(toLocalInput(start)); setTo(toLocalInput(end));
  };
  async function showRoute() {
    if (!histVehicle) return; setRouteBusy(true); setRouteMsg(null);
    const f = new Date(from).getTime();
    const t = new Date(to).getTime() + 59_999;   // the input has minute precision: "To 10:30" must include everything up to 10:30:59, or the newest positions vanish
    if (!Number.isFinite(f) || !Number.isFinite(t) || f >= t) { setRouteMsg("Choose a valid range: From must be earlier than To."); setRouteBusy(false); return; }
    const r = await fetch(`/api/vehicles/${histVehicle}/history?from=${f}&to=${t}`, { cache: "no-store" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setRouteBusy(false);
    if (!r?.ok) { setRoute(null); setRouteInfo(null); setRouteMsg(j.error ?? "Could not load the route."); return; }
    setRouteInfo(j); setRoute({ vehicleId: j.vehicle.id, label: j.vehicle.label, points: j.points, impacts: j.impacts });
    setRouteMsg(j.summary.pointCount === 0 ? "No positions were recorded in this range." : j.summary.pointCount === 1 ? "Only one position was recorded in this range, so there is no line to draw. It is marked on the map." : null);
  }
  const clearRoute = () => { setRoute(null); setRouteInfo(null); setRouteMsg(null); };

  const counts = useMemo(() => {
    const c = { moving: 0, idle: 0, backgrounded: 0, offline: 0, waiting: 0 };
    for (const v of withStatus) c[v.status]++; return c;
  }, [withStatus]);

  return (
    <>
      <section className="mt-8 rounded-2xl border border-white/10 bg-slate-900/50 p-6" data-testid="live-fleet">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Live fleet map</h2>
            <p className="mt-1 text-sm text-slate-400">Vehicles with an active driver link, updated in real time.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="counts">
            {(["moving", "idle", "backgrounded", "offline"] as const).map((s) => (
              <span key={s} data-count={s} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-slate-300 ring-1 ring-white/10">
                <span className={`h-2 w-2 rounded-full ${DOT[s]}`} />{STATUS_LABEL[s].replace("App in background", "Background")} <b className="text-white">{counts[s]}</b>
              </span>
            ))}
            <button onClick={() => setFitNonce((n) => n + 1)} className="rounded-full bg-white/5 px-3 py-1 text-slate-200 ring-1 ring-white/10 hover:bg-white/10">Fit fleet</button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="h-[460px] min-w-0 lg:h-[560px]">
            <FleetMap vehicles={withStatus} impacts={impacts} route={route} selectedId={selected} focus={focus} fitNonce={fitNonce} now={now} onSelect={setSelected} />
          </div>

          <aside className="flex min-h-0 min-w-0 flex-col gap-4">
            <div className="max-h-[260px] overflow-y-auto rounded-xl border border-white/5 bg-slate-950/40" data-testid="veh-list">
              {withStatus.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No tracked vehicles yet. Add one below and share its link with the driver.</p>}
              {withStatus.map((v) => (
                <button key={v.id} data-testid="veh-row" data-vehicle={v.label} data-status={v.status} onClick={() => { setSelected(v.id); setHistVehicle(v.id); }}
                  className={`flex w-full items-center gap-3 border-b border-white/5 px-3.5 py-2.5 text-left last:border-0 hover:bg-white/5 ${selected === v.id ? "bg-white/5" : ""}`}>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[v.status]} ${v.status === "moving" ? "animate-pulse" : ""}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">{v.label}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {STATUS_LABEL[v.status]}{v.status !== "waiting" && <> · {v.speedKmh == null ? "—" : `${Math.round(v.speedKmh)} km/h`} · {v.batteryPct == null ? "n/a" : `${v.batteryPct}%`} · {ago(v.lastSeenAt, now)}</>}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/40 p-4" data-testid="history">
              <h3 className="text-sm font-semibold text-white">Route history</h3>
              <label className="mt-3 block text-xs text-slate-400" htmlFor="hist-vehicle">Vehicle</label>
              <select id="hist-vehicle" value={histVehicle} onChange={(e) => setHistVehicle(e.target.value)} className={`${input} mt-1`}>
                {vehicles.map((v) => <option key={v.id} value={v.id} className="bg-slate-900">{v.label}</option>)}
              </select>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div><label className="block text-xs text-slate-400" htmlFor="hist-from">From</label><input id="hist-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={`${input} mt-1`} /></div>
                <div><label className="block text-xs text-slate-400" htmlFor="hist-to">To</label><input id="hist-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={`${input} mt-1`} /></div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {([["1 h", 3600_000], ["Today", "today"], ["24 h", DAY], ["7 days", 7 * DAY]] as const).map(([l, ms]) => (
                  <button key={l} onClick={() => preset(ms)} className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10">{l}</button>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={showRoute} disabled={routeBusy || !histVehicle} className="flex-1 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{routeBusy ? "Loading…" : "Show route"}</button>
                {(route || routeMsg) && <button onClick={clearRoute} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5">Clear</button>}
              </div>
              {routeMsg && <p role="status" data-testid="route-msg" className="mt-3 text-sm text-amber-200">{routeMsg}</p>}
              {routeInfo && routeInfo.summary.pointCount > 0 && (
                <dl data-testid="route-summary" className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  <div><dt className="text-xs text-slate-500">Distance</dt><dd className="text-white" data-k="distance">{routeInfo.summary.distanceKm.toFixed(2)} km</dd></div>
                  <div><dt className="text-xs text-slate-500">Duration</dt><dd className="text-white">{fmtDur(routeInfo.summary.durationMs)}</dd></div>
                  <div><dt className="text-xs text-slate-500">Max speed</dt><dd className="text-white">{routeInfo.summary.maxSpeedKmh == null ? "—" : `${Math.round(routeInfo.summary.maxSpeedKmh)} km/h`}</dd></div>
                  <div><dt className="text-xs text-slate-500">Impacts</dt><dd className="text-rose-300" data-k="impacts">{routeInfo.summary.impactCount}</dd></div>
                  <div className="col-span-2 text-xs text-slate-500">{routeInfo.summary.pointCount} positions{routeInfo.sampled ? ` (drawn from a ${routeInfo.points.length}-point sample)` : ""}</div>
                </dl>
              )}
            </div>
          </aside>
        </div>
      </section>

      <IncidentFeed incidents={feed} group={group} vehicleId={feedVehicle} vehicles={vehicles.map((v) => ({ id: v.id, label: v.label }))}
        hasMore={!!cursor} loading={feedLoading} onGroup={setGroup} onVehicle={setFeedVehicle} onMore={loadMore}
        onPick={(i) => i.lat != null && i.lng != null && setFocus({ lat: i.lat, lng: i.lng, nonce: Date.now() })} />
    </>
  );
}
