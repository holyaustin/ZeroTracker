# ZeroTracker Driver (native app)

The installable driver app (Expo / React Native). It talks to the **same backend** as the web driver link, using the same `/d/<link>` token, so managers see web and app drivers on one map. Choose per fleet:

| | Web link (`/d/<link>`) | Native app (this folder) |
|---|---|---|
| Install | none | APK / App Store / Play Store |
| Tracking with the screen off | **no** (browser pauses GPS) | **yes** (Android foreground service / iOS background location) |
| Wake-lock needed | yes | no |
| Impact sensor | foreground only | foreground (background: see limits) |
| Offline queue | IndexedDB, uploads when the page is open | SQLite, uploads when the app is running |

## How it works
`src/core` is plain TypeScript with no phone APIs: the link parser, the SQLite queue, and the `TripController` (GPS throttling, speed, battery warnings, impact detection, app-state events, lockout). Everything phone-specific sits behind one `Platform` interface (`src/platform/expoPlatform.ts`). The controller is tested against the real server with a simulated phone (see `test/e2e.mjs`, "Native driver app").
`src/shared` is a **copy** of `../packages/shared/src` (the logic web and native share: impact detector, speed/battery rules, offline sync engine). Run `npm run sync-shared` after editing the shared package; `npm test` at the repo root fails if the copy drifts.

## Run it
```bash
cd mobile
npm install
npm run sync-shared
npx expo start --dev-client     # needs a development build, Expo Go cannot run background location
```
Background location, foreground services and the accelerometer need a **real device** and a development/production build (not Expo Go, not a simulator).

## Build (EAS)
```bash
npm i -g eas-cli && eas login
eas build:configure                      # first time: links the project to your Expo account
npm run build:apk                        # Android APK you can sideload (WhatsApp / download link), no store review
npm run build:android                    # Play Store bundle (.aab)
npm run build:ios                        # needs an Apple Developer account ($99/yr)
```
Change `com.zerotracker.driver` in `app.json` to your own identifier before the first store build.

## How a driver connects
1. Manager copies the driver link in the dashboard (same as for the web version) and sends it by WhatsApp.
2. Driver installs the app, pastes the link once (or taps *Open in the ZeroTracker Driver app* on the web page).
3. Consent → Start Trip → **"Allow all the time"** for location. A persistent notification shows while sharing.

## Android phones kill background apps (important for Nigeria)
Many handsets (Tecno, Infinix, Xiaomi, Samsung power saving, etc.) aggressively stop background services. For each driver phone: Settings → Apps → ZeroTracker → Battery → **Unrestricted / Don't optimise**, and allow auto-start where the phone has that option. See dontkillmyapp.com for the exact steps per brand. Without this, tracking can stop minutes after the screen turns off even though the app is correctly built.

## Store rules
* **Google Play**: background location needs a Permissions Declaration form, a short video of the feature, and a prominent in-app disclosure (the consent screen is written for this). Sideloading the APK avoids the review.
* **Apple**: needs the "Always" location purpose strings (already in `app.json`) and a reviewer note explaining fleet tracking with consent.

## Verified here vs. not verified
Verified: TypeScript against the real SDK 58 type definitions; Metro bundles the Android and iOS apps; all core logic (link parsing, SQLite queue SQL, trip controller, offline sync, retries, lockout, impact detection, battery, permissions) against the real backend with simulated sensors.
**Not verified (needs a real phone):** the actual GPS/background behaviour, permission dialogs, foreground-service notification, accelerometer readings while the screen is off (Android restricts background sensors; test it), battery-optimisation behaviour on your handsets, and the look of the screens on real devices. Use `docs/MANUAL-TEST-CHECKLIST.md`, section H.
