// Verifies your environment variables before you run or deploy: npm run check-env
// Reads .env.local / .env exactly the way Next.js does, so it catches the "$ in the password hash" trap.
import path from "node:path";
import nextEnv from "@next/env";
const dir = process.env.ZT_ENV_DIR ? path.resolve(process.env.ZT_ENV_DIR) : process.cwd();
nextEnv.loadEnvConfig(dir, process.env.NODE_ENV !== "production");
const e = process.env;
const prod = e.NODE_ENV === "production" || !!e.VERCEL || e.ZT_CHECK_PRODUCTION === "1";
const errors = [], warnings = [];
const need = (name, ok, msg) => { if (!e[name]) errors.push(`${name} is missing.`); else if (!ok(e[name])) errors.push(`${name}: ${msg}`); };

need("DATABASE_URL", (v) => /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://");
if (e.DATABASE_URL && prod && !/sslmode=require|neon\.tech/.test(e.DATABASE_URL)) warnings.push("DATABASE_URL: add ?sslmode=require for hosted Postgres (Neon).");
need("JWT_SECRET", (v) => v.length >= 32, "must be at least 32 characters (generate one with: openssl rand -base64 32).");
need("OWNER_EMAIL", (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "must be an email address.");
need("OWNER_PASSWORD_HASH", (v) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(v),
  `does not look like a bcrypt hash (got ${(e.OWNER_PASSWORD_HASH || "").length} characters, expected 60 starting with $2a$/$2b$). In a .env.local file every $ must be written as \\$ — run: node scripts/hash-password.mjs "your password"`);
need("BREVO_SENDER_EMAIL", (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "must be an email address verified in Brevo.");
if (e.BREVO_API_KEY === "console") { (prod ? errors : warnings).push("BREVO_API_KEY=console prints emails instead of sending them. " + (prod ? "Not allowed in production." : "Fine for local development.")); }
else need("BREVO_API_KEY", (v) => v.length > 20, "looks too short to be a Brevo API key.");
if (e.REALTIME_DRIVER === "console") { (prod ? errors : warnings).push("REALTIME_DRIVER=console disables live updates over Ably. " + (prod ? "Not allowed in production." : "Fine for local development.")); }
else need("ABLY_API_KEY", (v) => /^[\w-]+\.[\w-]+:[\w+/=-]+$/.test(v), "must look like appId.keyId:secret (copy the full root key from the Ably dashboard).");
need("APP_URL", (v) => { try { const u = new URL(v); return !v.endsWith("/") && (!prod || u.protocol === "https:"); } catch { return false; } }, "must be the public URL with no trailing slash" + (prod ? " and use https://" : "") + ", e.g. https://zerotracker.example.com");
need("CRON_SECRET", (v) => v.length >= 16, "must be at least 16 characters (Vercel sends it to your cron routes automatically).");
if (e.STATUS_POLL_MS && !(Number(e.STATUS_POLL_MS) >= 1000)) warnings.push("STATUS_POLL_MS should be a number of milliseconds, 1000 or more.");

for (const w of warnings) console.log("⚠  " + w);
for (const x of errors) console.log("✗  " + x);
if (errors.length) { console.log(`\n${errors.length} problem(s) to fix.`); process.exit(1); }
console.log(`✓  Environment looks good${prod ? " for production" : ""}.`);
