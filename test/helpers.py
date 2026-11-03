"""Shared setup for the Playwright driver tests (test/offline.py)."""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error, uuid

DB = os.environ.get("TEST_DATABASE_URL", "postgres://zt:zt@localhost:5432/zerotracker")
assert "localhost" in DB or "127.0.0.1" in DB, "TEST_DATABASE_URL must be local"
PORT = int(os.environ.get("TEST_PORT", "3115")); BASE = f"http://localhost:{PORT}"
OUTBOX, RT = f"/tmp/zt-{PORT}-outbox.jsonl", f"/tmp/zt-{PORT}-realtime.jsonl"
OWNER_PW = "Owner-Pass-123!"
for f in (OUTBOX, RT):
    if os.path.exists(f): os.remove(f)

class Results:
    passed = failed = 0
R = Results()
def check(name, cond, extra=""):
    R.passed += bool(cond); R.failed += (not cond)
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   {extra}"))
def finish():
    print(f"\n{R.passed} passed, {R.failed} failed"); sys.exit(1 if R.failed else 0)

def start_server(driver="console", port=None):
    port = port or PORT
    h = subprocess.check_output(["node", "-e", f"console.log(require('bcryptjs').hashSync('{OWNER_PW}',4))"]).decode().strip()
    env = dict(os.environ, DATABASE_URL=DB, JWT_SECRET="x" * 40, NODE_ENV="production", OWNER_EMAIL="owner@zerotracker.test", OWNER_PASSWORD_HASH=h,
               BREVO_API_KEY="console", OUTBOX_PATH=OUTBOX, BREVO_SENDER_EMAIL="n@z.test", ABLY_API_KEY="testapp.testkey:testsecret",
               REALTIME_DRIVER=driver, REALTIME_OUTBOX_PATH=RT, APP_URL=f"http://localhost:{port}", STATUS_POLL_MS="1500", NEXT_TELEMETRY_DISABLED="1")
    p = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "-p", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    for _ in range(60):
        try: urllib.request.urlopen(f"http://localhost:{port}"); return p
        except Exception: time.sleep(0.5)
    p.kill(); raise SystemExit("server did not start")

import random
_RUN = random.randint(11, 250)   # fresh fake client IPs every run, so rate-limit counters from earlier runs never interfere
_ip = [0]
def call(method, path, body=None, cookie=None):
    _ip[0] += 1
    h = {"content-type": "application/json", "x-forwarded-for": f"10.{_RUN}.{_ip[0] // 250}.{_ip[0] % 250 + 1}"}
    if cookie: h["cookie"] = cookie
    req = urllib.request.Request(BASE + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try: r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e: r = e
    raw = r.read().decode() or "{}"
    sc = [c.split(";")[0] for c in (r.headers.get_all("set-cookie") or []) if c.startswith("zt_session=")]
    return r.status, json.loads(raw), (sc[0] if sc else None)

class Company:
    def __init__(self, name="Offline Haulage"):
        self.email = f"off-{uuid.uuid4().hex[:8]}@demo.test"
        call("POST", "/api/auth/register", {"name": name, "email": self.email})
        key = re.search(r"ZT-[A-Za-z0-9_-]+", [l for l in open(OUTBOX) if self.email in l][-1]).group(0)
        _, _, self.cookie = call("POST", "/api/auth/login", {"email": self.email, "accessKey": key})
        call("POST", "/api/company/profile", {"cacOrBnNumber": "RC1234567", "hqAddress": "12 Airport Road, Benin City", "whatsappNumber": "+2348012345678", "estimatedFleetSize": 5, "operationCategory": "Haulage & freight"}, self.cookie)
        _, _, own = call("POST", "/api/owner/login", {"email": "owner@zerotracker.test", "password": OWNER_PW})
        _, lst, _ = call("GET", f"/api/owner/companies?q={self.email}", None, own); self.id = lst["companies"][0]["id"]
        call("PATCH", f"/api/owner/companies/{self.id}/status", {"action": "APPROVE"}, own)
    def vehicle(self, label):
        st, j, _ = call("POST", "/api/vehicles", {"label": label}, self.cookie); assert st == 201, j
        return j["token"]["link"], j["token"]["id"], j["vehicle"]["id"]

def dbq(sql, *params):
    code = "const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:process.env.DBURL});await c.connect();const r=await c.query(process.argv[1],JSON.parse(process.argv[2]));console.log(JSON.stringify(r.rows));await c.end()})()"
    return json.loads(subprocess.check_output(["node", "-e", code, sql, json.dumps(list(params))], env=dict(os.environ, DBURL=DB)).decode())

MOCKS = """
(() => {
  const L = new Map(); let id = 0;
  navigator.geolocation.watchPosition = (ok, err) => { const i = ++id; L.set(i, { ok, err }); return i; };
  navigator.geolocation.clearWatch = (i) => L.delete(i);
  window.__watchers = () => L.size;
  window.__emitPos = (c) => L.forEach(l => l.ok({ coords: { latitude: c.lat, longitude: c.lng, accuracy: c.acc ?? 8, speed: c.speed ?? null, heading: c.heading ?? null, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() }));
  const B = { level: 0.8, charging: false, l: {}, addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }, removeEventListener() {} };
  Object.defineProperty(navigator, 'getBattery', { value: () => Promise.resolve(B), configurable: true });
  window.__setBattery = (lv, ch) => { B.level = lv; B.charging = ch; for (const t of ['levelchange', 'chargingchange']) (B.l[t] || []).forEach(f => f()); };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => ({ addEventListener() {}, async release() {} }) } });
  window.__vibrations = [];
  Object.defineProperty(navigator, 'vibrate', { value: (p) => { window.__vibrations.push(p); return true; }, configurable: true });
  window.__motionListeners = 0;
  const _a = window.addEventListener.bind(window), _r = window.removeEventListener.bind(window);
  window.addEventListener = (t, f, o) => { if (t === 'devicemotion') window.__motionListeners++; return _a(t, f, o); };
  window.removeEventListener = (t, f, o) => { if (t === 'devicemotion') window.__motionListeners--; return _r(t, f, o); };
  window.__jolt = (x, y, z) => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x, y, z } }));
})();
"""
IOS_PERM = """
window.__permCalls = 0; window.__permMode = window.__permMode || 'granted';
DeviceMotionEvent.requestPermission = () => { window.__permCalls++; return window.__permMode === 'throw' ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(window.__permMode); };
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
    """Records telemetry traffic: single events, batches (with timing) and their JSON responses."""
    def __init__(self, page):
        self.singles, self.batches, self.batch_resps, self.statuses = [], [], [], []
        def on_req(r):
            if not r.post_data: return
            if r.url.endswith("/api/telemetry/batch"): self.batches.append((time.time(), json.loads(r.post_data)["events"]))
            elif r.url.endswith("/api/telemetry"): self.singles.append(json.loads(r.post_data))
        def on_resp(r):
            if r.url.endswith("/api/telemetry/batch"):
                try: self.batch_resps.append(r.json())
                except Exception: self.batch_resps.append(None)
            if "/api/telemetry" in r.url: self.statuses.append(r.status)
        page.on("request", on_req); page.on("response", on_resp)
    def events(self): return self.singles + [e for _, b in self.batches for e in b]
    def incidents(self, t=None): return [e for e in self.events() if e["kind"] == "incident" and (t is None or e["type"] == t)]
    def pings(self): return [e for e in self.events() if e["kind"] == "ping"]

def start_trip(page, link):
    page.goto(link); page.get_by_role("checkbox").check(); page.get_by_role("button", name="Agree & continue").click()
    page.get_by_role("button", name="Start Trip").click()
def emit(page, **c): page.evaluate("c => window.__emitPos(c)", c)
def js(page, expr): return page.evaluate(expr)
def jolt(page, x, y, z): page.evaluate("a => window.__jolt(...a)", [x, y, z])

IDB_COUNT = """() => new Promise(res => { const r = indexedDB.open('zerotracker-offline'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('events')) { db.close(); res(0); return; }
  const q = db.transaction('events').objectStore('events').count(); q.onsuccess = () => { res(q.result); db.close(); }; }; r.onerror = () => res(-1); })"""
IDB_ALL = """() => new Promise(res => { const r = indexedDB.open('zerotracker-offline'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('events')) { db.close(); res([]); return; }
  const q = db.transaction('events').objectStore('events').getAll(); q.onsuccess = () => { res(q.result); db.close(); }; }; r.onerror = () => res([]); })"""
IDB_PUT = """(evs) => new Promise(res => { const r = indexedDB.open('zerotracker-offline'); r.onsuccess = () => { const db = r.result; const t = db.transaction('events', 'readwrite'); const s = t.objectStore('events');
  evs.forEach(e => s.add(e)); t.oncomplete = () => { db.close(); res(true); }; }; })"""
def idb_count(page): return page.evaluate(IDB_COUNT)
def idb_all(page): return page.evaluate(IDB_ALL)
