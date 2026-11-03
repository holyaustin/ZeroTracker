# ZeroTracker

Multi-tenant fleet tracking. Drivers open a private link in their phone browser (no app, no account); fleet managers watch a live map; the platform owner approves companies.

**Stack:** Next.js 15 (App Router, TypeScript) · PostgreSQL (Neon) + Drizzle · Ably (realtime) · Brevo (email) · Leaflet (map) · Tailwind · deployed on Vercel.

## What's in the box

| Surface | URL | What it does |
|---|---|---|
| Driver node | `/d/<link>` | Consent → Start Trip → live GPS & speed, wake lock, battery, background detection, impact/pothole detection with vibration, offline queue and batch sync, instant lockout when the link is revoked |
| Manager dashboard | `/dashboard` | Registration with emailed access key, 2-step company verification, live fleet map, route history, impact markers, incident feed, one-time driver links with copy/WhatsApp and instant revoke (✕) |
| Owner command centre | `/owner` | Platform KPIs, company review (approve / reject / suspend with notes), audit log |
| Legal | `/privacy`, `/terms` | Templates written for this product. **Have a lawyer review and fill in the [brackets] before launch.** |

---

## 1. Run it on your computer

You need Node.js 20+, and a PostgreSQL database (a free Neon project works, or a local Postgres).

```bash
npm install                       # also copies Ably's browser bundle to public/vendor/
cp .env.example .env.local        # then fill it in (see section 3)
npm run check-env                 # tells you exactly what is missing or wrong
npm run db:migrate                # creates the tables
npm run dev                       # http://localhost:3000
```

For local development you can set `BREVO_API_KEY=console` (emails are printed to the terminal and written to `.outbox.jsonl`) and `REALTIME_DRIVER=console` (no Ably account needed; the pages fall back to polling every few seconds).

Create the owner password hash with `npm run hash-password -- "your long owner password"` and use the **escaped** form in `.env.local` (every `$` written as `\$`). Next.js otherwise treats `$2a...` as a variable and silently corrupts the hash. `npm run check-env` catches this.

## 2. Services to create (all have free tiers; check current limits)

1. **Neon** (neon.tech): create a project, copy the **pooled** connection string (host contains `-pooler`) and add `?sslmode=require`.
2. **Brevo** (brevo.com): create an API key (SMTP & API → API keys) and verify a sender email address.
3. **Ably** (ably.com): create an app and copy the root API key (`appId.keyId:secret`).
4. **Vercel** (vercel.com): the host. Use a **Pro** plan for commercial use. The free Hobby plan is non-commercial and only allows daily cron jobs, while the per-minute disconnect sweep needs Pro.

## 3. Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon pooled string, `?sslmode=require` |
| `JWT_SECRET` | yes | 32+ random characters: `openssl rand -base64 32` |
| `OWNER_EMAIL` | yes | The platform owner's login |
| `OWNER_PASSWORD_HASH` | yes | From `npm run hash-password`. Vercel's form: paste as-is. `.env.local`: escape every `$` as `\$` |
| `BREVO_API_KEY` / `BREVO_SENDER_EMAIL` | yes | `console` allowed in development only |
| `ABLY_API_KEY` | yes | `appId.keyId:secret`. Not needed if `REALTIME_DRIVER=console` |
| `APP_URL` | yes | Public URL, no trailing slash, `https://` in production. Used in emails and driver links |
| `CRON_SECRET` | yes | 16+ random characters. Vercel sends it to the cron routes automatically |
| `REALTIME_DRIVER` | no | `ably` (default) or `console` (development only) |
| `STATUS_POLL_MS` | no | Polling safety-net interval, default 15000 |

## 4. Deploy to Vercel

1. Push this folder to a Git repository and **Import** it in Vercel (framework: Next.js; nothing to change).
2. Add every variable from section 3 under *Settings → Environment Variables* (Production). Set `APP_URL` to your final domain.
3. **Set the function region** close to your users (Settings → Functions). For Nigeria, pick a European region or Cape Town if offered.
4. Create the database tables once, from your computer, against Neon:
   ```bash
   DATABASE_URL="<your Neon string>" npm run db:migrate
   ```
   (Run it again after any future release that adds a migration in `drizzle/`.)
5. Deploy. `vercel.json` registers two cron jobs: `/api/cron/sweep` every minute (marks silent vehicles offline) and `/api/cron/cleanup` daily at 03:00 UTC (deletes location history after 30 days, incidents after 90 days, expired secrets).
6. In Brevo, authorise your sending domain/address (SPF/DKIM) so access-key emails reach inboxes.
7. Visit `https://your-domain/api/health`. It should return `{"ok":true}`.
8. Run through `docs/MANUAL-TEST-CHECKLIST.md` on a **real phone** before giving links to drivers.

## 5. Running the automated tests

Tests use a **local** PostgreSQL and **wipe it**. They refuse to run against non-local hosts.

```bash
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/zt_test
npm test                          # unit tests (126) + API/database tests (377); builds the app first
pip install playwright && python -m playwright install chromium
npm run test:ui                   # real-browser tests: manager, driver sensors, offline sync, map
```

## 6. How it fits together

* **Identity.** Managers sign in with email + emailed access key (stored only as a bcrypt hash). Drivers have no account; a 192-bit link token identifies one vehicle and only its SHA-256 is stored. Every manager query takes the company from the signed session, never from the request.
* **Verification gate.** Vehicles and links can be created only while a company is `APPROVED`, enforced on the server for every route. Suspension takes effect on the next request.
* **Telemetry.** Phones send a position about every 5 s. Failed sends go to an on-phone queue (IndexedDB) and are flushed oldest-first in batches of 200 with exponential backoff; the server ignores event ids it has already stored, so retries never duplicate.
* **Realtime.** The server publishes to Ably *after* data is committed; browsers subscribe with short-lived, subscribe-only tokens scoped to their own company. Pages also poll, so a dropped socket only delays updates.
* **Retention.** 30 days of positions, 90 days of incidents. The audit log is kept.

## 7. Known limits (please read)

* **Browser tracking has hard limits.** Phones may pause GPS when the screen locks or the browser is backgrounded. ZeroTracker keeps the screen awake, detects backgrounding, warns the driver and logs it, but cannot prevent it. If you need guaranteed background tracking, a native app is required.
* **iOS Safari** has no Vibration API and no Battery API; motion permission needs a tap. These degrade gracefully (on-screen alert, battery shown as n/a).
* **Offline data uploads when the page is open.** If the driver's browser is killed while offline, saved points stay on the phone and upload when the page is reopened (there is no background sync because this is a web page, not an installed app). The phone keeps at most 10,000 queued events.
* **Impact thresholds are untuned.** 3.6 G (resultant) with a 3 s cooldown; ≥ 6 G is labelled IMPACT, below that POTHOLE. Real roads will need field tuning (`src/lib/driverLogic.ts`).
* **Not yet verified from the build environment:** delivery through real Brevo, real Ably messages, and real map tiles. These were tested up to the network boundary with stand-ins. The checklist covers them.
* The Content-Security-Policy allows inline scripts/styles (Next.js needs this without a nonce setup). Everything else is locked to this site, the map tiles and Ably.
* Legal pages are templates, not legal advice.

## 8. Troubleshooting

* **Owner can't log in** → run `npm run check-env`; almost always the `$` escaping in `OWNER_PASSWORD_HASH`.
* **No access-key email** → Brevo sender not verified, or `BREVO_API_KEY=console` is still set.
* **Map shows grey with no tiles** → the browser blocked CARTO; it switches to OpenStreetMap after 3 failed tiles.
* **Live updates are slow (≈15 s)** → Ably key wrong or `REALTIME_DRIVER=console`; the polling fallback is working.
* **Vehicles never go offline** → cron not running (needs a Pro plan for per-minute jobs). They are still marked offline whenever a manager loads the page.
