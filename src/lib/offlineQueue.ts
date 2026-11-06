// Crash-safe event queue on the phone (IndexedDB). Falls back to memory where IndexedDB is unavailable.
export const DB_NAME = "zerotracker-offline";
export const STORE = "events";
export const MAX_QUEUE = 10_000;

export type { QueuedEvent } from "../../packages/shared/src/queueStore";
import type { QueuedEvent } from "../../packages/shared/src/queueStore";

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
        s.createIndex("cid", "clientEventId", { unique: true });   // the same event can never be queued twice
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

const store = (db: IDBDatabase, mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
const wrap = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

let mem: QueuedEvent[] = [];
let memSeq = 0;

export async function add(ev: QueuedEvent): Promise<void> {
  const db = await openDb();
  if (!db) {
    if (!mem.some((m) => m.clientEventId === ev.clientEventId)) mem.push({ ...ev, seq: ++memSeq });
  } else {
    try { await wrap(store(db, "readwrite").add({ ...ev })); } catch { /* duplicate id: already queued */ }
  }
  await trim();
}

export async function count(): Promise<number> {
  const db = await openDb();
  return db ? wrap(store(db, "readonly").count()) : mem.length;
}

/** Oldest first (insertion order). */
export async function peek(n: number): Promise<QueuedEvent[]> {
  const db = await openDb();
  if (!db) return mem.slice(0, n);
  return wrap(store(db, "readonly").getAll(null, n)) as Promise<QueuedEvent[]>;
}

export async function remove(seqs: number[]): Promise<void> {
  if (!seqs.length) return;
  const db = await openDb();
  if (!db) { const s = new Set(seqs); mem = mem.filter((m) => !s.has(m.seq as number)); return; }
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite"); const os = t.objectStore(STORE);
    for (const k of seqs) os.delete(k);
    t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
  });
}

export async function clear(): Promise<void> {
  const db = await openDb();
  if (!db) { mem = []; return; }
  await wrap(store(db, "readwrite").clear());
}

/** Bounded storage: when over MAX_QUEUE, the oldest position pings go first; incidents are kept as long as possible. */
export async function trim(max = MAX_QUEUE): Promise<void> {
  let extra = (await count()) - max;
  if (extra <= 0) return;
  const db = await openDb();
  if (!db) {
    for (const kind of ["ping", null]) {
      for (let i = 0; i < mem.length && extra > 0;) { if (kind === null || mem[i].kind === kind) { mem.splice(i, 1); extra--; } else i++; }
    }
    return;
  }
  const all = await wrap(store(db, "readonly").getAll()) as QueuedEvent[];
  const victims = [...all.filter((e) => e.kind === "ping"), ...all.filter((e) => e.kind !== "ping")].slice(0, extra).map((e) => e.seq as number);
  await remove(victims);
}

/** Test helper: reset the in-memory fallback. */
export function _resetMemory() { mem = []; memSeq = 0; }
