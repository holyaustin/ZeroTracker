import * as SQLite from "expo-sqlite";
import { createSqliteQueue, type SqlDb } from "../core/sqliteQueue";

export async function openQueue() {
  const db = await SQLite.openDatabaseAsync("zerotracker-offline.db");
  const sql: SqlDb = {
    exec: (s) => db.execAsync(s),
    run: async (s, p = []) => { await db.runAsync(s, p); },
    all: <T,>(s: string, p: (string | number | null)[] = []) => db.getAllAsync<T>(s, p),
  };
  return createSqliteQueue(sql);
}
