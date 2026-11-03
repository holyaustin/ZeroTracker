import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Works with Neon (use the pooled connection string) and any Postgres.
const g = globalThis as unknown as { _ztPool?: Pool };
const pool = g._ztPool ?? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
if (process.env.NODE_ENV !== "production") g._ztPool = pool;

export const db = drizzle(pool, { schema });
export { schema };
