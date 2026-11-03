"""Phase 5 browser tests (Playwright): impact detection + haptics, iOS motion permission, and the offline queue / batch sync.
   pip install playwright && python -m playwright install chromium
   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db python test/offline.py   (needs a built app: npm run build)"""
import re, time
from playwright.sync_api import sync_playwright, expect
from helpers import *

CSP = []
def watch(browser):
    orig = browser.new_context
    def nc(*a, **k):
        c = orig(*a, **k)
        c.on("console", lambda m: CSP.append(m.text[:160]) if ("Content Security Policy" in m.text or "Refused to" in m.text) else None)
        return c
    browser.new_context = nc
    return browser


srv = start_server()
try:
  co = Company()
  with sync_playwright() as p:
    b = watch(p.chromium.launch())
    motion = lambda page, state: page.locator(f'[data-testid="tile-motion"][data-motion="{state}"]')

    # ============================================================ impact detection & haptics
    print("Impact / pothole detection")
    link, tok, veh = co.vehicle("Impact Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link); emit(d, lat=6.335, lng=5.6037, speed=10, acc=8)
    expect(motion(d, "waiting")).to_be_visible(); check("impact sensor starts in 'Starting…' until motion data arrives", True)
    jolt(d, 0, 0, 9.81)
    expect(motion(d, "on")).to_be_visible(); check("resting phone (1 g) → sensor 'Active'", True)
    check("exactly one devicemotion listener", js(d, "window.__motionListeners") == 1)
    jolt(d, 0, 0, 34.335); d.wait_for_timeout(700)
    check("3.5 g does NOT trigger (threshold is 3.6 g)", len(tap.incidents("POTHOLE")) + len(tap.incidents("IMPACT")) == 0 and js(d, "window.__vibrations.length") == 0)
    d.evaluate("window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: null, y: null, z: null } }))"); d.wait_for_timeout(300)
    check("sensor readings with null axes are ignored safely", len(tap.incidents("POTHOLE")) == 0)
    end_btn = d.get_by_role("button", name="End trip"); tiles = d.get_by_test_id("tile-speed")
    pos0 = (end_btn.bounding_box()["y"], tiles.bounding_box()["y"])
    t0 = time.time(); jolt(d, 0, 0, 40)
    check("4.08 g jolt → POTHOLE incident sent", wait_for(d, lambda: len(tap.incidents("POTHOLE")) == 1, 4))
    inc = tap.incidents("POTHOLE")[0]
    check("incident carries g-force, readable message and position", inc["gForce"] == 4.08 and "4.1 G" in inc["message"] and inc["lat"] == 6.335 and inc["lng"] == 5.6037, str(inc))
    check("double-buzz vibration [200,100,200] fired once", js(d, "window.__vibrations") == [[200, 100, 200]])
    expect(d.get_by_test_id("notice-impact")).to_contain_text("Road shock detected (4.1 G)"); check("driver sees an on-screen impact alert (iOS has no vibration)", True)
    d.evaluate("window.__setBattery(0.19, false)"); expect(d.get_by_test_id("notice-battery")).to_be_visible()
    pos1 = (end_btn.bounding_box()["y"], tiles.bounding_box()["y"])
    check(f"layout is stable when alerts appear: End trip and tiles don't move under the driver's finger ({pos0} → {pos1})", abs(pos0[0] - pos1[0]) < 1 and abs(pos0[1] - pos1[1]) < 1)
    d.evaluate("window.__setBattery(0.8, false)")
    d.screenshot(path="/tmp/off-impact.png")
    for wait in (0.5, 1.0, 2.0):
        d.wait_for_timeout(max(0, int((t0 + wait - time.time()) * 1000))); jolt(d, 0, 0, 45)
    d.wait_for_timeout(300)
    check("jolts at +0.5s, +1s, +2s are debounced: still ONE incident, ONE buzz", len(tap.incidents("POTHOLE")) == 1 and len(js(d, "window.__vibrations")) == 1)
    d.wait_for_timeout(max(0, int((t0 + 3.2 - time.time()) * 1000))); jolt(d, 0, 0, 80)
    check("jolt after the 3 s cooldown → second incident, classified IMPACT (8.15 g ≥ 6 g)", wait_for(d, lambda: len(tap.incidents("IMPACT")) == 1, 4) and tap.incidents("IMPACT")[0]["gForce"] == 8.15)
    d.wait_for_timeout(3200); jolt(d, 30, 30, 30)
    check("3-axis resultant (30,30,30) = 5.30 g → POTHOLE", wait_for(d, lambda: len(tap.incidents("POTHOLE")) == 2, 4) and tap.incidents("POTHOLE")[1]["gForce"] == 5.3)
    check("three detections → three buzzes", len(js(d, "window.__vibrations")) == 3)
    d.get_by_role("button", name="End trip").click(); d.wait_for_timeout(300)
    check("ending the trip removes the motion listener", js(d, "window.__motionListeners") == 0)
    n = len(tap.incidents()); jolt(d, 0, 0, 80); d.wait_for_timeout(500)
    check("jolts after the trip ends are ignored", len(tap.incidents()) == n)
    ctx.close()

    print("Sensor availability")
    link, _, _ = co.vehicle("NoMotion Van")
    ctx = make_context(b); d = ctx.new_page(); start_trip(d, link); emit(d, lat=6.3, lng=5.6)
    expect(motion(d, "unsupported")).to_be_visible(timeout=8000); check("device that never reports motion → 'Not available' after a few seconds (no false 'Active')", True)
    ctx.close()
    link, _, _ = co.vehicle("NoApi Van")
    ctx = make_context(b, "Object.defineProperty(window, 'DeviceMotionEvent', { value: undefined, configurable: true });"); d = ctx.new_page(); start_trip(d, link)
    expect(motion(d, "unsupported")).to_be_visible(); check("browser without DeviceMotion → 'Not available' immediately", True)
    ctx.close()

    print("iOS motion permission")
    link, _, _ = co.vehicle("iOS Denied Van")
    ctx = make_context(b, "window.__permMode='denied';" + IOS_PERM); d = ctx.new_page(); start_trip(d, link)
    expect(motion(d, "denied")).to_be_visible()
    check("permission asked inside the Start Trip tap; denial shown as 'Blocked', no listener", js(d, "window.__permCalls") == 1 and js(d, "window.__motionListeners") == 0)
    ctx.close()
    link, _, _ = co.vehicle("iOS Van")
    ctx = make_context(b, IOS_PERM); d = ctx.new_page(); tap = Tap(d); start_trip(d, link); emit(d, lat=6.3, lng=5.6)
    check("Start Trip tap requested motion permission exactly once", js(d, "window.__permCalls") == 1)
    jolt(d, 0, 0, 9.81); expect(motion(d, "on")).to_be_visible(); check("granted → sensor active", True)
    jolt(d, 0, 0, 40); check("impact detected on iOS path (vibration unsupported there, alert still raised)", wait_for(d, lambda: len(tap.incidents("POTHOLE")) == 1, 4))
    d.reload(); expect(d.locator('[data-gps]')).to_be_visible(timeout=8000)
    check("refresh mid-trip: remembered grant is re-requested silently", wait_for(d, lambda: js(d, "window.__permCalls") == 1, 4))
    expect(motion(d, "waiting")).to_be_visible(); jolt(d, 0, 0, 9.81); expect(motion(d, "on")).to_be_visible(); check("…and detection resumes without a tap", True)
    js(d, "localStorage.removeItem('zt:motion')"); d.reload(); expect(d.locator('[data-gps]')).to_be_visible(timeout=8000)
    expect(motion(d, "needs-tap")).to_be_visible(); check("no remembered grant: 'Enable' button is offered instead of a silent prompt", js(d, "window.__permCalls") == 0)
    d.screenshot(path="/tmp/off-enable.png")
    d.get_by_role("button", name="Enable").click(); expect(motion(d, "waiting")).to_be_visible(); jolt(d, 0, 0, 9.81)
    expect(motion(d, "on")).to_be_visible(); check("tapping Enable grants permission and starts detection", js(d, "window.__permCalls") == 1)
    ctx.close()

    # ============================================================ offline-first queue & batch sync
    print("Offline journey")
    link, tok, veh = co.vehicle("Offline Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link); emit(d, lat=6.30, lng=5.60, speed=8, acc=8); jolt(d, 0, 0, 9.81)
    check("online baseline: first ping accepted", wait_for(d, lambda: 200 in tap.statuses, 4))
    rows0 = dbq("select count(*)::int n from telemetry where vehicle_id=$1", veh)[0]["n"]
    ctx.set_offline(True)
    expect(d.get_by_test_id("notice-offline")).to_be_visible(timeout=8000); check("going offline shows 'No connection'", True)
    for i in range(16):
        emit(d, lat=6.31 + i * 0.001, lng=5.60, speed=8 + i, acc=8); d.wait_for_timeout(1000)
        if i == 4: jolt(d, 0, 0, 40)
        if i == 8: d.evaluate("window.__setBattery(0.19, false)")
    queued = idb_all(d)
    check(f"events piled up on the phone while offline ({len(queued)} saved)", len(queued) >= 5, str(len(queued)))
    expect(d.get_by_test_id("notice-offline")).to_contain_text("saved on your phone"); check("driver sees how many points are saved", True)
    d.screenshot(path="/tmp/off-offline.png")
    check("server received nothing while the phone was offline", dbq("select count(*)::int n from telemetry where vehicle_id=$1", veh)[0]["n"] == rows0)
    qpings = [e for e in queued if e["kind"] == "ping"]; qinc = [e for e in queued if e["kind"] == "incident"]
    check("queue holds both position pings and incidents (POTHOLE, LOW_BATTERY)", len(qpings) >= 3 and {"POTHOLE", "LOW_BATTERY"} <= {e["type"] for e in qinc}, str([e.get("type") for e in qinc]))
    check("queued events are stored in time order", [e["ts"] for e in queued] == sorted(e["ts"] for e in queued))
    ctx.set_offline(False)
    check("back online: the queue drains by itself", wait_for(d, lambda: idb_count(d) == 0, 20))
    expect(d.get_by_test_id("notice-offline")).to_have_count(0); check("offline notice clears", True)
    sent = [e for _, bt in tap.batches for e in bt]
    sent_ids = [e["clientEventId"] for e in sent]
    check("flushed through /api/telemetry/batch", len(tap.batches) >= 1 and all(len(bt) <= 200 for _, bt in tap.batches))
    check("every queued event was sent", {e["clientEventId"] for e in queued} <= set(sent_ids))
    check("batch payload is in chronological order", [e["ts"] for e in tap.batches[0][1]] == sorted(e["ts"] for e in tap.batches[0][1]))
    check("internal queue keys never leave the phone", all("seq" not in e for e in sent))
    stored = {r["client_event_id"] for r in dbq("select client_event_id from telemetry where vehicle_id=$1", veh)}
    check("ALL offline pings are now in the database", all(f"{veh}:{e['clientEventId']}" in stored for e in qpings))
    ids = [r["client_event_id"] for r in dbq("select client_event_id from telemetry where vehicle_id=$1", veh)]
    check("no duplicate rows", len(ids) == len(set(ids)))
    stored_inc = {r["client_event_id"]: r["type"] for r in dbq("select client_event_id, type from incidents where vehicle_id=$1 and client_event_id is not null", veh)}
    check("offline POTHOLE and LOW_BATTERY incidents reached the server", all(f"{veh}:{e['clientEventId']}" in stored_inc for e in qinc))
    newest = max(qpings, key=lambda e: e["ts"])
    check("live position = newest offline ping", dbq("select last_lat from vehicle_status where vehicle_id=$1", veh)[0]["last_lat"] == newest["lat"])
    check("the buzz fired on the phone even while offline", len(js(d, "window.__vibrations")) == 1)
    ctx.close()

    print("Lost response (server stored it, phone never heard)")
    link, tok, veh = co.vehicle("Lost Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d); state = {"n": 0}
    d.route(re.compile(r".*/api/telemetry$"), lambda r: r.abort())
    def lose_first(route):
        state["n"] += 1
        if state["n"] == 1: route.fetch(); route.abort()
        else: route.continue_()
    d.route(re.compile(r".*/api/telemetry/batch$"), lose_first)
    start_trip(d, link); emit(d, lat=6.4, lng=5.6, speed=5, acc=8)
    check("phone retries the batch after the lost response", wait_for(d, lambda: len([r for r in tap.batch_resps if r]) >= 1, 15))
    resp = [r for r in tap.batch_resps if r][0]
    check("server reports the retry as duplicates (stored once, not twice)", resp["accepted"] == 0 and resp["duplicates"] >= 1, str(resp))
    check("same event ids were sent in both attempts", len(tap.batches) >= 2 and [e["clientEventId"] for e in tap.batches[0][1]] == [e["clientEventId"] for e in tap.batches[1][1]])
    check("queue emptied", wait_for(d, lambda: idb_count(d) == 0, 5))
    rows = dbq("select client_event_id from telemetry where vehicle_id=$1", veh)
    check("exactly one database row per event", len(rows) == len({e["clientEventId"] for e in tap.pings()}) and len(rows) >= 1)
    ctx.close()

    print("Backoff on server errors")
    link, tok, veh = co.vehicle("Flaky Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d); st = {"n": 0}
    d.route(re.compile(r".*/api/telemetry$"), lambda r: r.abort())
    def flaky(route):
        st["n"] += 1
        if st["n"] <= 3: route.fulfill(status=503, body="{}", content_type="application/json")
        else: route.continue_()
    d.route(re.compile(r".*/api/telemetry/batch$"), flaky)
    start_trip(d, link); emit(d, lat=6.5, lng=5.6, speed=5, acc=8)
    check("3 server errors then success", wait_for(d, lambda: len(tap.batches) >= 4, 30))
    ts = [t for t, _ in tap.batches]; g = [ts[i + 1] - ts[i] for i in range(3)]
    check(f"retry gaps grow (exponential backoff): {g[0]:.1f}s → {g[1]:.1f}s → {g[2]:.1f}s", g[0] >= 1.3 and g[1] > g[0] * 1.2 and g[2] > g[1] * 1.2, str(g))
    check("data delivered once the server recovered", wait_for(d, lambda: idb_count(d) == 0, 6) and len(dbq("select 1 from telemetry where vehicle_id=$1", veh)) >= 1)
    ctx.close()

    print("Queue survives a page refresh")
    link, tok, veh = co.vehicle("Reload Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d)
    block = lambda r: r.abort()
    d.route(re.compile(r".*/api/telemetry(/batch)?$"), block)
    start_trip(d, link); emit(d, lat=6.6, lng=5.6, speed=5, acc=8); d.wait_for_timeout(11000)
    before = idb_all(d); ids_before = [e["clientEventId"] for e in before]
    check(f"events saved in IndexedDB while the API is unreachable ({len(before)})", len(before) >= 3)
    d.reload(); expect(d.locator('[data-gps]')).to_be_visible(timeout=8000)
    after = idb_all(d)
    check("after a refresh the saved events are still there", set(ids_before) <= {e["clientEventId"] for e in after})
    d.unroute(re.compile(r".*/api/telemetry(/batch)?$"), block)
    d.evaluate("window.dispatchEvent(new Event('online'))")
    check("connection returns: pre-refresh events are delivered", wait_for(d, lambda: idb_count(d) == 0, 10))
    got = {r["client_event_id"] for r in dbq("select client_event_id from telemetry where vehicle_id=$1", veh)}
    check("the server has every event captured before the refresh", all(f"{veh}:{i}" in got for i in ids_before if i in {e["clientEventId"] for e in before if e["kind"] == "ping"}))
    ctx.close()

    print("Large backlog is chunked")
    link, tok, veh = co.vehicle("Chunk Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d); start_trip(d, link); d.wait_for_timeout(800)
    base = int(time.time() * 1000) - 3_600_000
    d.evaluate(IDB_PUT, [{"kind": "ping", "clientEventId": f"syn{i:06d}xx", "ts": base + i * 1000, "lat": 6.7 + i * 1e-5, "lng": 5.6, "speedKmh": 30, "accuracyM": 8, "heading": None, "batteryPct": 70, "charging": False, "appState": "FOREGROUND"} for i in range(450)])
    check("450 events placed in the phone's queue", idb_count(d) == 450)
    d.evaluate("window.dispatchEvent(new Event('online'))")
    check("queue drained", wait_for(d, lambda: idb_count(d) == 0, 15))
    sizes = [len(bt) for _, bt in tap.batches if any(e["clientEventId"].startswith("syn") for e in bt)]
    check(f"sent in batches of 200, 200, 50 (got {sizes})", sizes == [200, 200, 50])
    syn = [e["clientEventId"] for _, bt in tap.batches for e in bt if e["clientEventId"].startswith("syn")]
    check("global order preserved across batches", syn == sorted(syn))
    check("all 450 stored", dbq("select count(*)::int n from telemetry where vehicle_id=$1 and client_event_id like $2", veh, f"{veh}:syn%")[0]["n"] == 450)
    check("backlog older than an hour logs a GPS trail (1 entry/min of device time)", 6 <= dbq("select count(*)::int n from incidents where vehicle_id=$1 and type='GPS_PING'", veh)[0]["n"] <= 10)
    ctx.close()

    print("Revocation wipes the saved queue")
    link, tok, veh = co.vehicle("Wipe Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d)
    d.route(re.compile(r".*/api/telemetry(/batch)?$"), lambda r: r.abort())
    start_trip(d, link); emit(d, lat=6.8, lng=5.6, speed=5, acc=8)
    check("events queued while the API is unreachable", wait_for(d, lambda: idb_count(d) >= 1, 6))
    call("DELETE", f"/api/tokens/{tok}", None, co.cookie)
    expect(d.get_by_text("Access revoked by your manager")).to_be_visible(timeout=10000); check("link revoked: driver locked out", True)
    check("saved data is wiped from the phone on lockout", wait_for(d, lambda: idb_count(d) == 0, 4))
    n = len(tap.singles) + len(tap.batches); d.wait_for_timeout(6500)
    check("no more upload attempts after lockout", len(tap.singles) + len(tap.batches) == n)
    ctx.close()
    b.close()
finally:
    srv.terminate(); srv.wait()
check("no Content-Security-Policy violations in any browser session", not CSP, str(CSP[:3]))
finish()
