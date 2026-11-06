// Storage contract for the offline queue. The web app implements it with IndexedDB, the native app with SQLite.
export type QueuedEvent = { seq?: number; kind: string; clientEventId: string; ts: number; [k: string]: unknown };

export type QueueStore = {
  add: (ev: QueuedEvent) => Promise<void>;
  count: () => Promise<number>;
  /** Oldest first (insertion order). */
  peek: (n: number) => Promise<QueuedEvent[]>;
  remove: (seqs: number[]) => Promise<void>;
  clear: () => Promise<void>;
};

/** In-memory store: used by tests and as a last-resort fallback. De-duplicates by clientEventId like the real stores. */
export function createMemoryStore(): QueueStore & { all: () => QueuedEvent[] } {
  let rows: QueuedEvent[] = [];
  let seq = 0;
  return {
    add: async (ev) => { if (!rows.some((r) => r.clientEventId === ev.clientEventId)) rows.push({ ...ev, seq: ++seq }); },
    count: async () => rows.length,
    peek: async (n) => rows.slice(0, n).map((r) => ({ ...r })),
    remove: async (seqs) => { const s = new Set(seqs); rows = rows.filter((r) => !s.has(r.seq as number)); },
    clear: async () => { rows = []; },
    all: () => rows,
  };
}
