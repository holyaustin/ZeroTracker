"use client";
import { FEED_GROUPS, type Incident, type IncidentType } from "@/lib/fleetLogic";

const BADGE: Record<IncidentType, { label: string; cls: string }> = {
  IMPACT: { label: "Impact", cls: "bg-rose-500/15 text-rose-300 ring-rose-400/30" },
  POTHOLE: { label: "Pothole", cls: "bg-orange-500/15 text-orange-300 ring-orange-400/30" },
  LOW_BATTERY: { label: "Low battery", cls: "bg-amber-500/15 text-amber-300 ring-amber-400/30" },
  BACKGROUNDED: { label: "Backgrounded", cls: "bg-amber-500/10 text-amber-200 ring-amber-400/20" },
  FOREGROUNDED: { label: "Foreground", cls: "bg-slate-500/15 text-slate-300 ring-slate-400/25" },
  DISCONNECTED: { label: "Disconnected", cls: "bg-slate-500/20 text-slate-300 ring-slate-400/30" },
  CONNECTED: { label: "Connected", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30" },
  GPS_PING: { label: "GPS ping", cls: "bg-sky-500/10 text-sky-300 ring-sky-400/20" },
};
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });

export default function IncidentFeed({ incidents, group, vehicleId, vehicles, hasMore, loading, onGroup, onVehicle, onMore, onPick }: {
  incidents: Incident[]; group: string; vehicleId: string; vehicles: { id: string; label: string }[]; hasMore: boolean; loading: boolean;
  onGroup: (g: string) => void; onVehicle: (id: string) => void; onMore: () => void; onPick: (i: Incident) => void;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-slate-900/50 p-6" data-testid="feed">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">Incident &amp; telemetry feed</h2>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-400/20">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />Live
          </span>
        </div>
        <select aria-label="Filter by vehicle" value={vehicleId} onChange={(e) => onVehicle(e.target.value)}
          className="w-full min-w-0 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60 sm:w-auto sm:max-w-[260px]">
          <option value="" className="bg-slate-900">All vehicles</option>
          {vehicles.map((v) => <option key={v.id} value={v.id} className="bg-slate-900">{v.label}</option>)}
        </select>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Incident type">
        {Object.entries(FEED_GROUPS).map(([k, g]) => (
          <button key={k} role="tab" aria-selected={group === k} onClick={() => onGroup(k)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium ring-1 ring-inset transition ${group === k ? "bg-white text-slate-950 ring-white" : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"}`}>{g.label}</button>
        ))}
      </div>

      <ol className="mt-4 max-h-[480px] divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/5 bg-slate-950/40" data-testid="feed-list">
        {incidents.length === 0 && <li className="p-8 text-center text-sm text-slate-500">{loading ? "Loading…" : "No events yet. They appear here the moment a driver's phone reports them."}</li>}
        {incidents.map((i) => {
          const b = BADGE[i.type]; const hasPos = i.lat != null && i.lng != null;
          return (
            <li key={`${i.vehicleId}|${i.type}|${i.ts}|${i.id ?? ""}`} data-testid="feed-item" data-type={i.type} data-vehicle={i.label}
              onClick={() => hasPos && onPick(i)} title={hasPos ? "Show on map" : undefined}
              className={`flex items-start gap-3 px-4 py-3 text-sm ${hasPos ? "cursor-pointer hover:bg-white/5" : ""}`}>
              <span className="mt-0.5 w-[88px] shrink-0 font-mono text-xs tabular-nums text-slate-500" title={new Date(i.ts).toISOString()}>{time(i.ts)}<br /><span className="text-[10px]">{day(i.ts)}</span></span>
              <span className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${b.cls}`}>{b.label}</span>
              <span className="min-w-0 flex-1">
                <span className="break-words font-medium text-white">{i.label}</span>
                {i.gForce != null && <span className="ml-2 font-mono text-xs text-rose-300">{i.gForce.toFixed(1)} G</span>}
                {i.message && <span className="block truncate text-slate-400">{i.message}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {hasMore && <button onClick={onMore} disabled={loading} className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 py-2 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-50">{loading ? "Loading…" : "Load older events"}</button>}
    </section>
  );
}
