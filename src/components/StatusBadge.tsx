const styles: Record<string, string> = {
  UNVERIFIED: "bg-slate-500/10 text-slate-300 ring-slate-400/30",
  PENDING: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  APPROVED: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  SUSPENDED: "bg-orange-500/10 text-orange-300 ring-orange-400/30",
  REJECTED: "bg-rose-500/10 text-rose-300 ring-rose-400/30",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${styles[status] ?? styles.UNVERIFIED}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />{status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
