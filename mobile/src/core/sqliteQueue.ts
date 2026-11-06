import type { QueuedEvent, QueueStore } from "../shared/queueStore";

/** The few SQL operations we need, so the same queue code runs on expo-sqlite (phone) and node:sqlite (tests). */
export type SqlDb = {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: (string | number | null)[]) => Promise<void>;
  all: <T>(sql: string, params?: (string | number | null)[]) => Promise<T[]>;
};
export const MAX_QUEUE = 10_000;

/** Crash-safe offline queue on the phone: survives the app being killed. Oldest first; de-duplicated by event id. */
export async function createSqliteQueue(db: SqlDb, max = MAX_QUEUE): Promise<QueueStore> {
  await db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, json TEXT NOT NULL)`);

  const count = async () => Number((await db.all<{ n: number }>("SELECT count(*) AS n FROM events"))[0]?.n ?? 0);
  async function trim() {
    const extra = (await count()) - max;
    if (extra <= 0) return;
    // drop the oldest position pings first; incidents (impacts, battery, ...) are kept as long as possible
    await db.run(`DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY (kind = 'ping') DESC, seq ASC LIMIT ?)`, [extra]);
  }
  return {
    add: async (ev: QueuedEvent) => {
      const { seq: _s, ...rest } = ev;
      await db.run("INSERT OR IGNORE INTO events (cid, kind, json) VALUES (?, ?, ?)", [ev.clientEventId, ev.kind, JSON.stringify(rest)]);
      await trim();
    },
    count,
    peek: async (n: number) => (await db.all<{ seq: number; json: string }>("SELECT seq, json FROM events ORDER BY seq ASC LIMIT ?", [n]))
      .map((r) => ({ ...(JSON.parse(r.json) as QueuedEvent), seq: r.seq })),
    remove: async (seqs: number[]) => {
      for (let i = 0; i < seqs.length; i += 500) {
        const chunk = seqs.slice(i, i + 500);
        await db.run(`DELETE FROM events WHERE seq IN (${chunk.map(() => "?").join(",")})`, chunk);
      }
    },
    clear: async () => { await db.run("DELETE FROM events"); },
  };
}
