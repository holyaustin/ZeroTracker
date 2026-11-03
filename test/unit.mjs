// Unit tests for the driver client's pure logic. Run: node test/unit.mjs  (Node 22+, no build needed)
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "zt-unit-"));
writeFileSync(join(dir, "entry.ts"), `export * from "${process.cwd()}/src/lib/driverLogic"; export * as queue from "${process.cwd()}/src/lib/offlineQueue"; export * from "${process.cwd()}/src/lib/syncEngine"; export * from "${process.cwd()}/src/lib/fleetLogic";`);
await build({ entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "node", outfile: join(dir, "out.mjs"), logLevel: "silent" });
const L = await import(join(dir, "out.mjs"));
const { msToKmh, lowBatteryNext, cleanHeading, cleanNumber, makeEventId, clockSkew, SEND_INTERVAL_MS, resultantG, classifyImpact, createImpactDetector, backoffMs, queue, createSyncEngine,
  computeStatus, haversineKm, downsample, summarizeRoute, mergeIncidents, incidentKey, FEED_GROUPS, INCIDENT_TYPES, OFFLINE_AFTER_MS, MOVING_KMH } = L;
let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); };

console.log("Speed conversion (m/s → km/h)");
eq("0 m/s → 0", msToKmh(0), 0);
eq("10 m/s → 36", msToKmh(10), 36);
eq("13.89 m/s → 50", msToKmh(13.89), 50);
eq("27.78 m/s → 100", msToKmh(27.78), 100);
eq("rounds to one decimal", msToKmh(1.234), 4.4);
eq("null stays null (not 0)", msToKmh(null), null);
eq("undefined → null", msToKmh(undefined), null);
eq("NaN → null", msToKmh(NaN), null);
eq("Infinity → null", msToKmh(Infinity), null);
eq("tiny negative clamps to 0", msToKmh(-0.2), 0);

console.log("Low-battery state machine");
let w = lowBatteryNext(false, 50, false); eq("50% unplugged: no warning", w, { warn: false, warned: false });
w = lowBatteryNext(false, 20, false); eq("20% unplugged: warns (boundary)", w, { warn: true, warned: true });
w = lowBatteryNext(false, 21, false); eq("21% unplugged: no warning", w, { warn: false, warned: false });
w = lowBatteryNext(true, 18, false); eq("still low: does not warn again", w, { warn: false, warned: true });
w = lowBatteryNext(true, 10, true); eq("charging at 10%: clears and re-arms", w, { warn: false, warned: false });
w = lowBatteryNext(false, 15, false); eq("unplugged at 15% after re-arm: warns again", w, { warn: true, warned: true });
w = lowBatteryNext(true, 22, false); eq("22% (below re-arm level): stays warned, silent", w, { warn: false, warned: true });
w = lowBatteryNext(true, 25, false); eq("recovers to 25%: re-arms", w, { warn: false, warned: false });
w = lowBatteryNext(true, null, null); eq("no Battery API (null): keeps state, never warns", w, { warn: false, warned: true });
w = lowBatteryNext(false, 5, true); eq("5% but charging: no warning", w, { warn: false, warned: false });

console.log("Sanitizers & helpers");
eq("heading 90 ok", cleanHeading(90), 90);
eq("heading NaN → null", cleanHeading(NaN), null);
eq("heading -1 → null", cleanHeading(-1), null);
eq("heading 361 → null", cleanHeading(361), null);
eq("cleanNumber(null) → null", cleanNumber(null), null);
eq("cleanNumber(7.5) → 7.5", cleanNumber(7.5), 7.5);
const ids = new Set(Array.from({ length: 500 }, makeEventId));
eq("event ids are unique (500 samples)", ids.size, 500);
eq("event ids match the server's allowed pattern", [...ids].every((i) => /^[A-Za-z0-9_-]{8,64}$/.test(i)), true);
eq("clock skew: phone 10 min fast → -600000", clockSkew(1_000_000, 1_600_000), -600000);
eq("send interval is 5 seconds", SEND_INTERVAL_MS, 5000);



console.log("Impact detection (3.6 g, 3 s cooldown)");
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
eq("phone at rest reads 1 g", near(resultantG(0, 0, 9.81), 1), true);
eq("35.316 m/s² on one axis = 3.6 g", near(resultantG(0, 0, 35.316), 3.6), true);
eq("3-axis resultant: (20,20,20) m/s² = 3.53 g", near(resultantG(20, 20, 20), 3.5321, 1e-3), true);
eq("negative axes give the same magnitude", near(resultantG(-20, 20, -20), resultantG(20, 20, 20)), true);
let det = createImpactDetector();
eq("3.59 g does not trigger", det.feed(3.59, 0), false);
eq("3.6 g triggers (inclusive threshold)", det.feed(3.6, 10), true);
eq("t+1000ms: suppressed by cooldown", det.feed(9, 1010), false);
eq("t+2989ms: still suppressed", det.feed(9, 2999), false);
eq("exactly 3000ms later: triggers again", det.feed(3.6, 3010), true);
eq("immediately after: suppressed again", det.feed(9, 3011), false);
det = createImpactDetector(); let hits = 0;
for (let t = 0; t <= 10_000; t += 16) if (det.feed(8, t)) hits++;
eq("continuous shaking for 10 s → 4 incidents (one per 3 s)", hits, 4);
det = createImpactDetector();
eq("NaN is ignored", det.feed(NaN, 0), false);
eq("Infinity is ignored", det.feed(Infinity, 0), false);
eq("a rejected spike does not start the cooldown", det.feed(3.6, 1), true);
eq("3.6 g → POTHOLE", classifyImpact(3.6), "POTHOLE");
eq("5.99 g → POTHOLE", classifyImpact(5.99), "POTHOLE");
eq("6 g → IMPACT", classifyImpact(6), "IMPACT");
eq("backoff attempt 0 ≈ 1 s", backoffMs(0, 0.5), 1000);
eq("backoff doubles: 2 s, 4 s, 8 s", [backoffMs(1, 0.5), backoffMs(2, 0.5), backoffMs(3, 0.5)], [2000, 4000, 8000]);
eq("backoff is capped at 30 s", backoffMs(20, 0.5), 30000);
eq("backoff jitter stays within ±20%", [backoffMs(2, 0), backoffMs(2, 1)], [3200, 4800]);

console.log("Offline queue (in-memory fallback)");
const ev = (id, kind = "ping", ts = 1) => ({ kind, clientEventId: id, ts });
queue._resetMemory();
await queue.add(ev("a1aaaaaa")); await queue.add(ev("b2bbbbbb")); await queue.add(ev("c3cccccc"));
eq("add 3 → count 3", await queue.count(), 3);
await queue.add(ev("a1aaaaaa")); eq("same event id is not queued twice", await queue.count(), 3);
eq("peek returns oldest first", (await queue.peek(2)).map((e) => e.clientEventId), ["a1aaaaaa", "b2bbbbbb"]);
const first = await queue.peek(1); await queue.remove([first[0].seq]);
eq("remove by key", (await queue.peek(10)).map((e) => e.clientEventId), ["b2bbbbbb", "c3cccccc"]);
await queue.clear(); eq("clear empties it", await queue.count(), 0);
queue._resetMemory();
for (let i = 0; i < 4; i++) await queue.add(ev(`ping${i}xxxx`, "ping"));
await queue.add(ev("incident1x", "incident")); await queue.trim(3);
const left = (await queue.peek(10)).map((e) => e.clientEventId);
eq("capacity respected (3 left)", left.length, 3);
eq("the incident is still there", left.includes("incident1x"), true);
eq("the newest pings were kept", left.includes("ping3xxxx") && left.includes("ping2xxxx"), true);
queue._resetMemory();

console.log("Sync engine (fake server, real timers)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(5); } return false; };
const res = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
/** A fake server: stores event ids, can be told to fail. */
function fakeServer() {
  const s = { stored: [], calls: [], dupes: 0, mode: "ok", failNext: 0, lostResponses: 0, delay: 0, serverNow: null };
  s.fetch = async (url, init) => {
    const body = JSON.parse(init.body); const events = url.endsWith("/batch") ? body.events : [body];
    s.calls.push({ url, n: events.length, ids: events.map((e) => e.clientEventId), at: Date.now(), headers: init.headers, keepalive: init.keepalive, hasSeq: events.some((e) => "seq" in e) });
    if (s.delay) await sleep(s.delay);
    if (s.mode === "net") throw new TypeError("network down");
    if (s.failNext > 0) { s.failNext--; return res(s.failStatus ?? 503); }
    if (s.mode === "gone") return res(410, { code: "REVOKED" });
    if (s.mode === "bad") return res(400, { error: "bad" });
    let accepted = 0, duplicates = 0;
    for (const e of events) { if (s.stored.includes(e.clientEventId)) duplicates++; else { s.stored.push(e.clientEventId); accepted++; } }
    s.dupes += duplicates;
    if (s.lostResponses > 0) { s.lostResponses--; throw new TypeError("response lost"); }   // server processed it, the phone never heard
    return res(200, { ok: true, accepted, duplicates, now: s.serverNow ?? Date.now() });
  };
  return s;
}
function mkEngine(srv, extra = {}) {
  const target = new EventTarget(); const states = []; let revoked = [];
  const net = { online: true };
  const e = createSyncEngine({ token: "T".repeat(32), onRevoked: (c) => revoked.push(c), onState: (st) => states.push(st), fetchImpl: srv.fetch, isOnline: () => net.online, target, baseDelayMs: 20, ...extra });
  return { e, target, states, net, get revoked() { return revoked; }, lastState: () => states.reduce((a, b) => ({ ...a, ...b }), {}) };
}
const D = (id, ts = Date.now(), kind = "ping") => ({ kind, clientEventId: id, ts, lat: 1, lng: 2 });
const settle = async (h) => { await sleep(30); await until(async () => (await queue.count()) === 0, 4000); };

queue._resetMemory(); let S = fakeServer(), H = mkEngine(S);
await H.e.send(D("direct001"));
eq("online + empty queue: one direct POST to /api/telemetry", [S.calls.length, S.calls[0].url, S.calls[0].n], [1, "/api/telemetry", 1]);
eq("the driver link is sent in the x-driver-token header", S.calls[0].headers["x-driver-token"], "T".repeat(32));
eq("nothing queued, state online", [await queue.count(), H.lastState().connection], [0, "online"]);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); H = mkEngine(S); H.net.online = false;
for (const id of ["off00001", "off00002", "off00003"]) await H.e.send(D(id));
eq("offline: events are queued, no network calls", [await queue.count(), S.calls.length], [3, 0]);
eq("offline: state says offline and shows 3 queued", [H.lastState().connection, H.lastState().queued], ["offline", 3]);
H.net.online = true; H.target.dispatchEvent(new Event("online"));
eq("back online: queue flushed", await until(async () => (await queue.count()) === 0), true);
eq("flushed in ONE batch, in original order", [S.calls.length, S.calls[0].url, S.calls[0].ids], [1, "/api/telemetry/batch", ["off00001", "off00002", "off00003"]]);
eq("internal queue keys never leak to the server", S.calls[0].hasSeq, false);
eq("server stored exactly those events, once", S.stored, ["off00001", "off00002", "off00003"]);
eq("state is online again with 0 queued", [H.lastState().connection, H.lastState().queued], ["online", 0]);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.mode = "net"; H = mkEngine(S);
await H.e.send(D("netfail01"));
eq("network error on the fast path: event is queued, not lost", await queue.count(), 1);
S.mode = "ok";
eq("retried automatically after backoff", await until(async () => (await queue.count()) === 0), true);
eq("delivered exactly once", S.stored.filter((x) => x === "netfail01").length, 1);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.lostResponses = 1; H = mkEngine(S); H.net.online = false;
await H.e.send(D("lost0001")); await H.e.send(D("lost0002")); H.net.online = true; H.target.dispatchEvent(new Event("online"));
eq("lost response: client retries the same batch", await until(async () => (await queue.count()) === 0 && S.calls.length >= 2), true);
eq("server saw the batch twice but stored each event once", [S.calls.length, S.stored.length, S.dupes], [2, 2, 2]);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); H = mkEngine(S); H.net.online = false;
for (let i = 0; i < 450; i++) await H.e.send(D(`chunk${String(i).padStart(5, "0")}`));
eq("450 events queued offline", await queue.count(), 450);
H.net.online = true; H.target.dispatchEvent(new Event("online"));
await until(async () => (await queue.count()) === 0);
eq("flushed in batches of 200, 200, 50", S.calls.map((c) => c.n), [200, 200, 50]);
eq("global order preserved across batches", S.stored, Array.from({ length: 450 }, (_, i) => `chunk${String(i).padStart(5, "0")}`));
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.failNext = 3; H = mkEngine(S); H.net.online = false;
await H.e.send(D("backoff01")); H.net.online = true; H.target.dispatchEvent(new Event("online"));
await until(async () => (await queue.count()) === 0);
const t = S.calls.map((c) => c.at), g1 = t[1] - t[0], g2 = t[2] - t[1], g3 = t[3] - t[2];
eq(`server errors: 4 attempts with growing gaps (${g1}, ${g2}, ${g3} ms)`, [S.calls.length, g2 > g1, g3 > g2], [4, true, true]);
eq("delivered after the server recovered", S.stored, ["backoff01"]);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.failNext = 1; S.failStatus = 429; H = mkEngine(S); H.net.online = false;
await H.e.send(D("limit001")); H.net.online = true; H.target.dispatchEvent(new Event("online"));
eq("429 is retried, not dropped", await until(async () => (await queue.count()) === 0 && S.stored.includes("limit001")), true);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.mode = "bad"; H = mkEngine(S); H.net.online = false;
await H.e.send(D("poison01")); H.net.online = true; H.target.dispatchEvent(new Event("online"));
eq("400 (can never succeed): batch is discarded, no endless retry", await until(async () => (await queue.count()) === 0), true);
await sleep(120); eq("exactly one attempt was made", S.calls.length, 1);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.mode = "gone"; H = mkEngine(S); H.net.online = false;
await H.e.send(D("revoke01")); await H.e.send(D("revoke02")); H.net.online = true; H.target.dispatchEvent(new Event("online"));
await until(() => H.revoked.length > 0);
eq("410 (link revoked): app is told once and the queue is wiped", [H.revoked, await queue.count()], [["REVOKED"], 0]);
await sleep(120); eq("no retries after revocation", S.calls.length, 1);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.delay = 60; H = mkEngine(S); H.net.online = false;
await H.e.send(D("order001", 1)); H.net.online = true; H.target.dispatchEvent(new Event("online"));
await sleep(15); await H.e.send(D("order002", 2));
await until(async () => (await queue.count()) === 0);
eq("an event created mid-flush is delivered after, never before, earlier ones", S.stored, ["order001", "order002"]);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); H = mkEngine(S); H.net.online = false;
await H.e.send(D("waiting01")); H.net.online = true;
await H.e.send(D("bg000001", Date.now(), "incident"), { keepalive: true });
eq("page-hide event (keepalive) is sent immediately, not stuck behind the queue", [S.calls[0].url, S.calls[0].keepalive], ["/api/telemetry", true]);
await until(async () => (await queue.count()) === 0); H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.serverNow = Date.now() + 600_000; H = mkEngine(S);
await H.e.send(D("skew0001"));
eq("clock skew learned from the server (+10 min)", Math.abs(H.e.now() - (Date.now() + 600_000)) < 1000, true);
H.e.destroy();

queue._resetMemory(); S = fakeServer(); S.mode = "net"; H = mkEngine(S);
await H.e.send(D("destroy01")); const callsBefore = S.calls.length; H.e.destroy(); S.mode = "ok"; await sleep(150);
eq("destroy() stops all retries", S.calls.length, callsBefore);


console.log("Fleet status (computed on read)");
const NOW = 1_000_000_000_000;
const veh = (o = {}) => ({ lat: 6.3, lng: 5.6, speedKmh: 40, appState: "FOREGROUND", online: true, lastSeenAt: NOW - 1000, ...o });
eq("speed 40 → moving", computeStatus(veh(), NOW), "moving");
eq(`speed exactly ${MOVING_KMH} → moving`, computeStatus(veh({ speedKmh: 5 }), NOW), "moving");
eq("speed 4.9 → idle", computeStatus(veh({ speedKmh: 4.9 }), NOW), "idle");
eq("speed 0 → idle", computeStatus(veh({ speedKmh: 0 }), NOW), "idle");
eq("unknown speed → idle (never 'moving')", computeStatus(veh({ speedKmh: null }), NOW), "idle");
eq("app backgrounded → backgrounded", computeStatus(veh({ appState: "BACKGROUNDED" }), NOW), "backgrounded");
eq("backgrounded wins over speed", computeStatus(veh({ appState: "BACKGROUNDED", speedKmh: 80 }), NOW), "backgrounded");
eq("last seen exactly 60 s ago → still online", computeStatus(veh({ lastSeenAt: NOW - OFFLINE_AFTER_MS }), NOW), "moving");
eq("last seen 60.001 s ago → offline", computeStatus(veh({ lastSeenAt: NOW - OFFLINE_AFTER_MS - 1 }), NOW), "offline");
eq("flag says offline → offline", computeStatus(veh({ online: false }), NOW), "offline");
eq("offline wins over backgrounded", computeStatus(veh({ online: false, appState: "BACKGROUNDED" }), NOW), "offline");
eq("never seen but online flag set → offline", computeStatus(veh({ lastSeenAt: null }), NOW), "offline");
eq("no position yet → waiting (not drawn)", computeStatus(veh({ lat: null, lng: null }), NOW), "waiting");
eq("no position stays 'waiting' even when offline", computeStatus(veh({ lat: null, lng: null, online: false }), NOW), "waiting");

console.log("Route maths");
eq("1° of latitude ≈ 111.2 km", near(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 111.19, 0.1), true);
const lagosBenin = haversineKm({ lat: 6.5244, lng: 3.3792 }, { lat: 6.335, lng: 5.6037 });
eq(`Lagos → Benin City ≈ 247 km (got ${lagosBenin.toFixed(1)})`, lagosBenin > 244 && lagosBenin < 250, true);
eq("same point = 0 km", haversineKm({ lat: 6.3, lng: 5.6 }, { lat: 6.3, lng: 5.6 }), 0);
const nums = Array.from({ length: 10_000 }, (_, i) => i);
const ds = downsample(nums, 2000);
eq("10,000 points → 2,000", ds.length, 2000);
eq("first and last points are always kept", [ds[0], ds[ds.length - 1]], [0, 9999]);
eq("sampling keeps order, no duplicates", ds.every((v, i) => i === 0 || v > ds[i - 1]), true);
eq("fewer points than the cap: unchanged", downsample([1, 2, 3], 2000), [1, 2, 3]);
eq("exactly at the cap: unchanged", downsample(nums.slice(0, 2000), 2000).length, 2000);
const rs = summarizeRoute([{ t: 0, lat: 0, lng: 0, s: 10 }, { t: 60000, lat: 1, lng: 0, s: 50 }, { t: 120000, lat: 2, lng: 0, s: null }]);
eq("route summary: distance, duration, max speed", [rs.distanceKm, rs.durationMs, rs.maxSpeedKmh], [222.39, 120000, 50]);
eq("empty route summary", summarizeRoute([]), { distanceKm: 0, durationMs: 0, maxSpeedKmh: null });
eq("single-point route has zero duration", summarizeRoute([{ t: 5, lat: 1, lng: 1, s: 3 }]).durationMs, 0);

console.log("Feed merging & filters");
const inc = (o) => ({ vehicleId: "v1", label: "Van", type: "IMPACT", gForce: 4, lat: 1, lng: 1, message: "m", ts: 1000, ...o });
let m = mergeIncidents([inc({ ts: 1000, id: 1 }), inc({ ts: 3000, id: 3 })], [inc({ ts: 2000 })]);
eq("merged newest first", m.map((x) => x.ts), [3000, 2000, 1000]);
m = mergeIncidents([inc({ ts: 1000, id: 7 })], [inc({ ts: 1000 })]);
eq("a pushed event and the API row for it collapse into one", m.length, 1);
eq("…keeping the row that has a database id", m[0].id, 7);
m = mergeIncidents([inc({ ts: 1000 })], [inc({ ts: 1000, id: 9 })]); eq("order of arrival doesn't matter", [m.length, m[0].id], [1, 9]);
m = mergeIncidents([], [inc({ ts: 1000, type: "IMPACT" }), inc({ ts: 1000, type: "POTHOLE" }), inc({ ts: 1000, vehicleId: "v2" })]);
eq("different type or vehicle at the same instant are NOT merged", m.length, 3);
m = mergeIncidents([], Array.from({ length: 700 }, (_, i) => inc({ ts: i })), 500); eq("merge is capped (keeps the newest 500)", [m.length, m[0].ts, m[499].ts], [500, 699, 200]);
m = mergeIncidents([], [inc({ ts: 5, id: 1 }), inc({ ts: 5, id: 2, type: "POTHOLE" })]); eq("same timestamp: higher id first", m.map((x) => x.id), [2, 1]);
eq("incidentKey is stable", incidentKey(inc({})), "v1|IMPACT|1000");
const grouped = Object.entries(FEED_GROUPS).filter(([k]) => k !== "all").flatMap(([, g]) => g.types);
eq("every incident type belongs to a filter group", INCIDENT_TYPES.every((t) => grouped.includes(t)), true);
eq("no type appears in two groups", new Set(grouped).size, grouped.length);

queue._resetMemory(); S = fakeServer(); S.mode = "net"; H = mkEngine(S, { baseDelayMs: 150 }); H.net.online = false;
await H.e.send(D("pend0001")); H.net.online = true; H.target.dispatchEvent(new Event("online"));
await until(() => S.calls.length >= 1); const afterFirst = S.calls.length;
for (let i = 0; i < 5; i++) { await H.e.send(D(`pend1${i}xx`)); await sleep(10); }
eq("while a backoff timer is pending, new events are queued but do NOT trigger extra attempts", S.calls.length, afterFirst);
S.mode = "ok";
eq("they are all delivered together when the timer fires", await until(async () => (await queue.count()) === 0, 4000), true);
eq("nothing lost or duplicated", S.stored.length, 6);
H.e.destroy();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
