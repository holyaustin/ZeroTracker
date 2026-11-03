"""Driver-phone sensor tests in a real browser (Playwright). Needs a built app (npm run build) and local Postgres.
   pip install playwright && python -m playwright install chromium
   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db python test/driver.py
Browser APIs that Playwright cannot emulate (speed, battery, wake lock, page visibility) are replaced with
controllable mocks injected before the app loads, so we test the app's real reaction to each signal."""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error, uuid
from playwright.sync_api import sync_playwright, expect

CSP = []
def watch(browser):
    """Fail the run if any page reports a Content-Security-Policy violation."""
    orig = browser.new_context
    def nc(*a, **k):
        c = orig(*a, **k)
        c.on("console", lambda m: CSP.append(m.text[:160]) if ("Content Security Policy" in m.text or "Refused to" in m.text) else None)
        return c
    browser.new_context = nc
    return browser


DB = os.environ.get("TEST_DATABASE_URL", "postgres://zt:zt@localhost:5432/zerotracker")
assert "localhost" in DB or "127.0.0.1" in DB, "TEST_DATABASE_URL must be local"
PORT, BASE = 3114, "http://localhost:3114"
OUTBOX, RT = "/tmp/zt-drv-outbox.jsonl", "/tmp/zt-drv-realtime.jsonl"
OWNER_PW = "Owner-Pass-123!"
for f in (OUTBOX, RT):
    if os.path.exists(f): os.remove(f)
hash_ = subprocess.check_output(["node", "-e", f"console.log(require('bcryptjs').hashSync('{OWNER_PW}',4))"]).decode().strip()
env = dict(os.environ, DATABASE_URL=DB, JWT_SECRET="x" * 40, NODE_ENV="production", OWNER_EMAIL="owner@zerotracker.test", OWNER_PASSWORD_HASH=hash_,
           BREVO_API_KEY="console", OUTBOX_PATH=OUTBOX, BREVO_SENDER_EMAIL="n@z.test", ABLY_API_KEY="testapp.testkey:testsecret",
           REALTIME_DRIVER="console", REALTIME_OUTBOX_PATH=RT, APP_URL=BASE, STATUS_POLL_MS="1500", NEXT_TELEMETRY_DISABLED="1")

passed = failed = 0
def check(name, cond, extra=""):
    global passed, failed
    passed += bool(cond); failed += (not cond)
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   {extra}"))

_ip = [0]
def call(method, path, body=None, cookie=None):
    _ip[0] += 1
    h = {"content-type": "application/json", "x-forwarded-for": f"10.9.{_ip[0] // 250}.{_ip[0] % 250 + 1}"}
    if cookie: h["cookie"] = cookie
    req = urllib.request.Request(BASE + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try: r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e: r = e
    raw = r.read().decode() or "{}"
    sc = [c.split(";")[0] for c in (r.headers.get_all("set-cookie") or []) if c.startswith("zt_session=")]
    return r.status, json.loads(raw), (sc[0] if sc else None)

srv = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "-p", str(PORT)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try: urllib.request.urlopen(BASE); break
    except Exception: time.sleep(0.5)

MOCKS = """
(() => {
  const L = new Map(); let id = 0;
  navigator.geolocation.watchPosition = (ok, err) => { const i = ++id; L.set(i, { ok, err }); if (window.__geoDenied) setTimeout(() => err({ code: 1, message: 'denied' }), 0); return i; };
  navigator.geolocation.clearWatch = (i) => L.delete(i);
  window.__watchers = () => L.size;
  window.__emitPos = (c) => L.forEach(l => l.ok({ coords: { latitude: c.lat, longitude: c.lng, accuracy: c.acc ?? 8, speed: c.speed ?? null, heading: c.heading ?? null, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() }));
  const B = { level: 0.8, charging: false, l: {}, addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }, removeEventListener() {} };
  Object.defineProperty(navigator, 'getBattery', { value: () => Promise.resolve(B), configurable: true });
  window.__setBattery = (lv, ch) => { B.level = lv; B.charging = ch; for (const t of ['levelchange', 'chargingchange']) (B.l[t] || []).forEach(f => f()); };
  window.__wake = { requests: 0, releases: 0, active: false };
  let cur = null;
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.requests++; window.__wake.active = true;
    const s = { l: [], addEventListener(t, f) { this.l.push(f); }, async release() { if (cur !== s) return; cur = null; window.__wake.releases++; window.__wake.active = false; this.l.forEach(f => f()); } };
    cur = s; return s; } } });
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
  window.__setVis = (v) => { vis = v; if (v === 'hidden' && cur) cur.release(); document.dispatchEvent(new Event('visibilitychange')); };
})();
"""

def make_context(b, extra=""):
    ctx = b.new_context(viewport={"width": 390, "height": 800}, is_mobile=True, has_touch=True)
    ctx.add_init_script(MOCKS + extra)
    return ctx

def wait_for(page, fn, timeout=12, step=150):
    end = time.time() + timeout
    while time.time() < end:
        if fn(): return True
        page.wait_for_timeout(step)
    return False

class Tap:
    """Records every telemetry request/response the page makes."""
    def __init__(self, page):
        self.reqs, self.statuses = [], []
        page.on("request", lambda r: self.reqs.append(json.loads(r.post_data)) if r.url.endswith("/api/telemetry") and r.post_data else None)
        page.on("response", lambda r: self.statuses.append(r.status) if r.url.endswith("/api/telemetry") else None)
    def pings(self): return [r for r in self.reqs if r["kind"] == "ping"]
    def incidents(self, t=None): return [r for r in self.reqs if r["kind"] == "incident" and (t is None or r["type"] == t)]

def start_trip(page, link):
    page.goto(link); page.get_by_role("checkbox").check(); page.get_by_role("button", name="Agree & continue").click()
    page.get_by_role("button", name="Start Trip").click()
def emit(page, **c): page.evaluate("c => window.__emitPos(c)", c)
def js(page, expr): return page.evaluate(expr)

# ------------------------------------------------------------------ company + vehicles via the API ----------
email = f"drv-{uuid.uuid4().hex[:8]}@demo.test"
call("POST", "/api/auth/register", {"name": "Sensor Haulage", "email": email})
key = re.search(r"ZT-[A-Za-z0-9_-]+", [l for l in open(OUTBOX) if email in l][-1]).group(0)
_, _, mgr = call("POST", "/api/auth/login", {"email": email, "accessKey": key})
call("POST", "/api/company/profile", {"cacOrBnNumber": "RC1234567", "hqAddress": "12 Airport Road, Benin City", "whatsappNumber": "+2348012345678", "estimatedFleetSize": 5, "operationCategory": "Haulage & freight"}, mgr)
_, _, own = call("POST", "/api/owner/login", {"email": "owner@zerotracker.test", "password": OWNER_PW})
_, lst, _ = call("GET", f"/api/owner/companies?q={email}", None, own); org_id = lst["companies"][0]["id"]
call("PATCH", f"/api/owner/companies/{org_id}/status", {"action": "APPROVE"}, own)
def new_vehicle(label):
    st, j, _ = call("POST", "/api/vehicles", {"label": label}, mgr); assert st == 201, j
    return j["token"]["link"], j["token"]["id"], j["vehicle"]["id"]
link1, tok1, veh1 = new_vehicle("Sensor Van")

try:
  with sync_playwright() as p:
    b = watch(p.chromium.launch())

    print("GPS, speed & throttling")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link1)
    expect(d.locator('[data-gps="waiting"]')).to_be_visible(); check("before the first fix: 'Waiting for GPS signal…'", True)
    check("GPS watch started on Start Trip (one watcher)", js(d, "window.__watchers()") == 1)
    check("screen wake lock requested at trip start", wait_for(d, lambda: js(d, "window.__wake.requests") >= 1) and js(d, "window.__wake.active"))
    t_emit = time.time() * 1000
    emit(d, lat=6.335, lng=5.6037, speed=13.89, acc=9, heading=90)
    expect(d.locator('[data-gps="ok"]')).to_be_visible(); expect(d.get_by_text("Location sharing is ON")).to_be_visible(); check("first fix flips the indicator to 'Location sharing is ON'", True)
    expect(d.get_by_test_id("tile-speed")).to_contain_text("50"); check("13.89 m/s shows as 50 km/h on screen", True)
    check("first ping is sent immediately (no 5s wait)", wait_for(d, lambda: len(tap.pings()) >= 1, 3))
    p1 = tap.pings()[0]
    check("ping carries lat/lng, speed 50.0 km/h, accuracy, heading", p1["lat"] == 6.335 and p1["lng"] == 5.6037 and p1["speedKmh"] == 50.0 and p1["accuracyM"] == 9 and p1["heading"] == 90, str(p1))
    check("ping carries battery 80%, not charging, FOREGROUND", p1["batteryPct"] == 80 and p1["charging"] is False and p1["appState"] == "FOREGROUND", str(p1))
    check("ping has a unique id and a current timestamp", len(p1["clientEventId"]) >= 8 and abs(p1["ts"] - t_emit) < 5000)
    check("server accepted it (200)", wait_for(d, lambda: 200 in tap.statuses, 3))
    d.screenshot(path="/tmp/drv-active.png")

    n0 = len(tap.pings())
    for i in range(30): emit(d, lat=6.4 + i * 0.001, lng=5.6, speed=10, acc=7)
    d.wait_for_timeout(6500)
    sent = len(tap.pings()) - n0
    check(f"30 rapid fixes are throttled (about one ping per 5s, got {sent})", 1 <= sent <= 2, str(sent))
    check("the latest fix wins", abs(tap.pings()[-1]["lat"] - 6.429) < 1e-9, str(tap.pings()[-1]["lat"]))
    emit(d, lat=6.43, lng=5.6, speed=None, acc=7); n1 = len(tap.pings())
    check("unknown speed is sent as null, not 0", wait_for(d, lambda: len(tap.pings()) > n1 and tap.pings()[-1]["speedKmh"] is None, 7), str(tap.pings()[-1]))
    expect(d.get_by_test_id("tile-speed")).to_contain_text("—"); check("unknown speed shows a dash on screen", True)

    print("Battery")
    js(d, "window.__setBattery(0.19, false)")
    expect(d.get_by_test_id("notice-battery")).to_be_visible(); check("19% unplugged: driver sees a low-battery warning", True)
    check("one LOW_BATTERY incident sent", wait_for(d, lambda: len(tap.incidents("LOW_BATTERY")) == 1, 3))
    check("incident carries the battery level and position", "19%" in tap.incidents("LOW_BATTERY")[0]["message"] and tap.incidents("LOW_BATTERY")[0]["lat"] is not None)
    d.screenshot(path="/tmp/drv-lowbattery.png")
    js(d, "window.__setBattery(0.17, false)"); d.wait_for_timeout(800)
    check("battery keeps dropping: no second incident", len(tap.incidents("LOW_BATTERY")) == 1)
    js(d, "window.__setBattery(0.17, true)")
    expect(d.get_by_test_id("notice-battery")).to_have_count(0); check("plugging in clears the warning", True)
    js(d, "window.__setBattery(0.15, false)")
    check("unplugged again at 15%: warns again (re-armed)", wait_for(d, lambda: len(tap.incidents("LOW_BATTERY")) == 2, 3))
    js(d, "window.__setBattery(0.8, false)")

    print("Background detection & wake lock")
    r0 = js(d, "window.__wake.requests")
    js(d, "window.__setVis('hidden')")
    check("switching apps sends a BACKGROUNDED incident", wait_for(d, lambda: len(tap.incidents("BACKGROUNDED")) == 1, 3))
    check("the browser drops the wake lock when hidden", js(d, "window.__wake.active") is False)
    emit(d, lat=6.5, lng=5.6, speed=0, acc=7)
    check("pings sent while backgrounded are marked BACKGROUNDED", wait_for(d, lambda: any(x["appState"] == "BACKGROUNDED" for x in tap.pings()), 7))
    js(d, "window.__setVis('visible')")
    check("returning sends a FOREGROUNDED incident", wait_for(d, lambda: len(tap.incidents("FOREGROUNDED")) == 1, 3))
    check("wake lock is re-acquired on return", wait_for(d, lambda: js(d, "window.__wake.active") and js(d, "window.__wake.requests") > r0, 3))
    check("GPS watch restarted without leaking (still exactly one)", js(d, "window.__watchers()") == 1)
    expect(d.get_by_test_id("notice-background")).to_be_visible(); check("driver sees the 'tracking may pause' banner after returning", True)
    d.screenshot(path="/tmp/drv-background.png")
    d.get_by_test_id("notice-background").get_by_role("button", name="Dismiss").click()
    expect(d.get_by_test_id("notice-background")).to_have_count(0); check("banner can be dismissed", True)

    print("Session persistence")
    d.reload()
    expect(d.locator('[data-gps]')).to_be_visible(timeout=8000); check("refresh mid-trip: trip auto-resumes (no tap needed)", True)
    check("sensors restart on resume: GPS watch + wake lock", js(d, "window.__watchers()") == 1 and wait_for(d, lambda: js(d, "window.__wake.active"), 4))
    emit(d, lat=6.6, lng=5.6, speed=5, acc=6); expect(d.locator('[data-gps="ok"]')).to_be_visible(); check("resumed trip streams again after a fix", True)

    print("End trip")
    d.get_by_role("button", name="End trip").click()
    expect(d.get_by_role("button", name="Start Trip")).to_be_visible()
    check("ending the trip stops GPS and releases the wake lock", js(d, "window.__watchers()") == 0 and wait_for(d, lambda: js(d, "window.__wake.active") is False, 3))
    check("trip flag cleared from storage", js(d, "localStorage.getItem('zt:trip')") is None)
    n2 = len(tap.reqs); d.wait_for_timeout(6500)
    check("no telemetry is sent after the trip ends", len(tap.reqs) == n2)
    ctx.close()

    print("Instant lockout stops every sensor")
    link2, tok2, veh2 = new_vehicle("Lockout Van")
    ctx = make_context(b); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link2); emit(d, lat=6.3, lng=5.6, speed=8, acc=8)
    check("trip streaming before revocation", wait_for(d, lambda: len(tap.pings()) >= 1, 4))
    call("DELETE", f"/api/tokens/{tok2}", None, mgr)
    expect(d.get_by_text("Access revoked by your manager")).to_be_visible(timeout=10000); check("manager revokes: driver screen locks", True)
    check("GPS watch stopped on lockout", js(d, "window.__watchers()") == 0)
    check("wake lock released on lockout", wait_for(d, lambda: js(d, "window.__wake.active") is False, 3))
    n3 = len(tap.reqs); d.wait_for_timeout(6500)
    check("no further telemetry after lockout", len(tap.reqs) == n3)
    ctx.close()

    print("Location permission denied")
    link3, tok3, veh3 = new_vehicle("Denied Van")
    ctx = make_context(b, "window.__geoDenied = true;"); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link3)
    expect(d.locator('[data-gps="denied"]')).to_be_visible(); expect(d.get_by_text("Location blocked. Sharing is OFF")).to_be_visible(); check("denied permission is shown clearly (never claims sharing is ON)", True)
    check("'Try again' offered", d.get_by_role("button", name="Try again").is_visible())
    d.screenshot(path="/tmp/drv-denied.png")
    d.wait_for_timeout(1500); check("nothing is sent while blocked", len(tap.reqs) == 0)
    js(d, "window.__geoDenied = false"); d.get_by_role("button", name="Try again").click()
    emit(d, lat=6.31, lng=5.61, speed=3, acc=8)
    expect(d.locator('[data-gps="ok"]')).to_be_visible(timeout=5000); check("after allowing and retrying, sharing starts", True)
    ctx.close()

    print("Browser without Battery / Wake Lock APIs (like iOS Safari)")
    link4, tok4, veh4 = new_vehicle("iOS Van")
    ctx = make_context(b, "Object.defineProperty(navigator, 'getBattery', { value: undefined, configurable: true }); Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });"); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link4); emit(d, lat=6.32, lng=5.62, speed=2, acc=8)
    check("still tracks and sends pings", wait_for(d, lambda: len(tap.pings()) >= 1, 4))
    check("battery is sent as null (not invented)", tap.pings()[0]["batteryPct"] is None and tap.pings()[0]["charging"] is None)
    expect(d.get_by_text("n/a")).to_be_visible(); check("battery tile shows n/a", True)
    expect(d.get_by_text("can't keep the screen awake")).to_be_visible(); check("driver told to disable auto-lock", True)
    check("no false low-battery alarm", d.get_by_test_id("notice-battery").count() == 0)
    ctx.close()

    print("Phone clock is 10 minutes fast")
    link5, tok5, veh5 = new_vehicle("Skew Van")
    ctx = make_context(b, "const __o = Date.now.bind(Date); Date.now = () => __o() + 600000;"); d = ctx.new_page(); tap = Tap(d)
    start_trip(d, link5); emit(d, lat=6.33, lng=5.63, speed=4, acc=8)
    check("ping accepted despite the wrong clock (no 400)", wait_for(d, lambda: len(tap.statuses) >= 1, 5) and set(tap.statuses) == {200}, str(tap.statuses))
    check("timestamp corrected to server time (within 10s)", abs(tap.pings()[0]["ts"] - time.time() * 1000) < 10000, f'{tap.pings()[0]["ts"] - time.time() * 1000:.0f}ms off')
    ctx.close()
    b.close()

  print("\nServer-side result of the browser traffic")
  rt = [json.loads(l) for l in open(RT)]
  fleet = [e for e in rt if e["channel"] == f"org:{org_id}:fleet"]
  check("positions reached the company's fleet channel", any(e["event"] == "position" and e["data"]["vehicleId"] == veh1 and e["data"]["speedKmh"] == 50.0 for e in fleet))
  check("LOW_BATTERY / BACKGROUNDED / FOREGROUNDED incidents were recorded", all(any(e["event"] == "incident" and e["data"]["type"] == t and e["data"]["vehicleId"] == veh1 for e in fleet) for t in ("LOW_BATTERY", "BACKGROUNDED", "FOREGROUNDED")))
finally:
    srv.terminate(); srv.wait()

check("no Content-Security-Policy violations in any browser session", not CSP, str(CSP[:3]))
print(f"\n{passed} passed, {failed} failed"); sys.exit(1 if failed else 0)
