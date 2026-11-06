# Manual test checklist (do this on real devices before launch)

Automated tests cover the logic with simulated sensors. These checks cover what only real phones, real networks and real services can show. Tick each box.

## A. Accounts & email (real Brevo)
- [ ] Register a new company → an email with the access key arrives (inbox, not spam) within a minute.
- [ ] Sign in with it. "Forgot access key" → reset email arrives; the link works once and then fails.
- [ ] Owner can sign in at `/owner/login`; a manager cannot open `/owner`.

## B. Approval flow (real Ably)
- [ ] Manager submits the 2-step verification form. Owner (second browser) sees it appear within seconds and approves it.
- [ ] The manager's open page unlocks **without reloading**. Suspend → the fleet panel disappears live; reinstate → returns.

## C. Driver phone: Android (Chrome)
- [ ] Add a vehicle, copy the link, send it by WhatsApp, open it on the phone. Consent screen appears; Start is blocked until ticked.
- [ ] Start Trip → location permission prompt → "Location sharing is ON" only after the first GPS fix.
- [ ] Walk or drive: the marker moves on the manager's map within ~5 s; speed shown in km/h is plausible.
- [ ] Battery % is shown and updates; unplug to <20% (or test with a nearly flat phone) → low-battery warning + feed entry.
- [ ] Switch to WhatsApp for 20 s and come back → BACKGROUNDED/FOREGROUNDED events in the feed and the "tracking may pause" banner.
- [ ] Lock the screen for 1 minute during a trip → note what happens (GPS may pause; the marker should go grey/offline and recover).
- [ ] Hit a bump / drop the phone onto a cushion → impact or pothole incident appears with a G value and a red marker; the phone buzzes. Tune `SEVERE_IMPACT_G` / threshold if needed.
- [ ] Turn on airplane mode for 2 minutes while moving → "No connection… points saved". Turn it off → the saved points appear on the manager's route in order, no gaps or duplicates.
- [ ] Refresh the page mid-trip → the trip resumes by itself.
- [ ] Manager revokes the link (✕) → the phone locks out within seconds and stops sending.

## D. Driver phone: iPhone (Safari)
- [ ] Start Trip → motion-permission prompt appears; allow it. Impact detection shows "Active".
- [ ] No vibration is expected; the on-screen alert must still appear.
- [ ] Battery shows "n/a" (normal on iOS). Refresh mid-trip → the "Enable" button appears for impact detection if iOS asks again.

## E. Manager dashboard
- [ ] Map tiles load (dark). Block `basemaps.cartocdn.com` in dev tools → map switches to OpenStreetMap.
- [ ] Markers: green moving, blue idle, amber background, grey offline. Popups show speed, battery, last seen.
- [ ] Route history for a real trip: line follows the road, distance/duration look right, impacts marked.
- [ ] Incident feed updates live; filters and "Load older events" work.
- [ ] Open on a phone-sized screen: no sideways scrolling.

## F. Security spot-checks
- [ ] Company A cannot see company B's vehicles or feed (use two accounts).
- [ ] A revoked or old driver link shows "Access revoked".
- [ ] `https://your-domain/api/cron/cleanup` without the secret returns 401.
- [ ] After a day: positions older than 30 days are gone (check the cron log in Vercel).

## G. Before going live
- [ ] Lawyer has reviewed `/privacy` and `/terms`; the [brackets] are filled in.
- [ ] `APP_URL` is the real domain; HTTPS works; `/api/health` returns ok.
- [ ] Owner password is long and unique; `JWT_SECRET` and `CRON_SECRET` are random.

## H. Native driver app (real Android and iPhone)
- [ ] Build the APK (`cd mobile && npm run build:apk`), install it on a real phone, paste a driver link. Vehicle name and company appear; a revoked/invalid link shows a clear error.
- [ ] Consent → Start Trip → permission prompts: allow location **"all the time"**. A persistent "ZeroTracker is sharing your location" notification appears (Android).
- [ ] **Lock the screen and drive/walk for 5+ minutes.** The marker keeps moving on the manager's map with the screen off. (This is the main reason the app exists.)
- [ ] Refuse "all the time": the app warns that tracking will pause with the screen off, and offers *Open settings*.
- [ ] Settings → Apps → ZeroTracker → Battery → Unrestricted. Repeat the screen-off test on each handset model your drivers use (Tecno/Infinix/Xiaomi/Samsung differ).
- [ ] Impact test with the screen ON: bump the phone, an impact/pothole incident and a vibration follow. Then repeat with the screen OFF and note whether the accelerometer still reports (Android may restrict it). Record the result; if it doesn't work, impact detection is foreground-only on that device.
- [ ] Airplane mode for 2 minutes while moving, then back online: saved points sync in order, no duplicates (feed and route).
- [ ] Force-close the app mid-trip and reopen it: the trip resumes and any queued points upload.
- [ ] Manager revokes the link: the app locks out within ~15 seconds, stops the notification and location, and shows "Access revoked".
- [ ] Suspend the company from the owner portal: the app shows "Tracking is currently disabled".
- [ ] Web and app drivers appear together on one map; the same vehicle can't be driven from both at once (one link = one vehicle).
