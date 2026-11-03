"""Browser test (Playwright). Needs a built app (npm run build) and a local Postgres with the migration applied.
   pip install playwright && python -m playwright install chromium
   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db python test/ui.py
Covers: register -> login -> 2-step wizard -> owner approves in another browser -> manager page unlocks WITHOUT reload."""
import json, os, re, subprocess, sys, time, urllib.request, uuid
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
PORT, BASE = 3113, "http://localhost:3113"
OUTBOX, RT = "/tmp/zt-ui-outbox.jsonl", "/tmp/zt-ui-realtime.jsonl"
OWNER_PW = "Owner-Pass-123!"
hash_ = subprocess.check_output(["node", "-e", f"console.log(require('bcryptjs').hashSync('{OWNER_PW}',4))"]).decode().strip()
for f in (OUTBOX, RT):
    if os.path.exists(f): os.remove(f)

def server_env(driver):
    return dict(os.environ, DATABASE_URL=DB, JWT_SECRET="x" * 40, NODE_ENV="production", OWNER_EMAIL="owner@zerotracker.test",
        OWNER_PASSWORD_HASH=hash_, BREVO_API_KEY="console", OUTBOX_PATH=OUTBOX, BREVO_SENDER_EMAIL="n@z.test",
        ABLY_API_KEY="testapp.testkey:testsecret", REALTIME_DRIVER=driver, REALTIME_OUTBOX_PATH=RT,
        APP_URL=BASE, STATUS_POLL_MS="1500", NEXT_TELEMETRY_DISABLED="1")

def start(driver):
    p = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "-p", str(PORT)], env=server_env(driver),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try: urllib.request.urlopen(BASE); return p
        except Exception: time.sleep(0.5)
    p.kill(); raise SystemExit("server did not start")

passed = failed = 0
def check(name, cond):
    global passed, failed
    passed += cond; failed += (not cond); print(("  PASS  " if cond else "  FAIL  ") + name)

email = f"ui-{uuid.uuid4().hex[:8]}@demo.test"; company = f"UI Test Haulage {uuid.uuid4().hex[:4]}"
srv = start("console")
try:
    with sync_playwright() as p:
        b = watch(p.chromium.launch())
        mgr = b.new_context(viewport={"width": 1100, "height": 900}); m = mgr.new_page()
        own = b.new_context(viewport={"width": 1280, "height": 1000}); o = own.new_page()

        print("Manager onboarding")
        m.goto(BASE + "/register")
        m.get_by_label("Company name").fill(company); m.get_by_label("Work email").fill(email)
        m.get_by_role("button", name="Get my access key").click()
        expect(m.get_by_text("Access key sent to your email.")).to_be_visible(); check("registration shows success message", True)
        key = re.search(r"ZT-[A-Za-z0-9_-]+", [l for l in open(OUTBOX) if email in l][-1]).group(0)
        m.goto(BASE + "/login")
        m.get_by_label("Work email").fill(email); m.get_by_label("Access key").fill("wrong-key-12345")
        m.get_by_role("button", name="Sign in").click()
        expect(m.get_by_text("Invalid credentials")).to_be_visible(); check("wrong key shows an error, stays on login", "/login" in m.url)
        m.get_by_label("Access key").fill(key); m.get_by_role("button", name="Sign in").click()
        m.wait_for_url("**/dashboard"); expect(m.get_by_text("Verify your company to begin")).to_be_visible(); check("login lands on locked dashboard", True)

        print("Verification wizard")
        m.get_by_role("button", name="Continue").click()
        expect(m.get_by_text("Enter a valid CAC number")).to_be_visible(); check("step 1 blocks empty/invalid input", True)
        m.get_by_label("CAC registration / BN number").fill("RC1234567")
        m.get_by_label("Headquarters address").fill("12 Airport Road, Benin City, Edo State")
        m.get_by_role("button", name="Continue").click()
        expect(m.get_by_text("Step 2 of 2")).to_be_visible(); check("advances to step 2", True)
        m.screenshot(path="/tmp/ui-wizard.png")
        m.get_by_label("WhatsApp phone number").fill("abc"); m.get_by_label("Estimated fleet size").fill("25")
        m.get_by_label("Operation category").select_option("Haulage & freight")
        m.get_by_role("button", name="Submit for review").click()
        expect(m.get_by_text("Enter a valid WhatsApp number")).to_be_visible(); check("step 2 blocks invalid WhatsApp number", True)
        m.get_by_label("WhatsApp phone number").fill("+234 801 234 5678")
        m.get_by_role("button", name="Submit for review").click()
        expect(m.get_by_text("Your profile is under review")).to_be_visible(); check("submission moves dashboard to under-review (no reload)", True)
        m.screenshot(path="/tmp/ui-pending.png")

        print("Owner approves in a separate browser")
        o.goto(BASE + "/owner/login")
        o.get_by_label("Owner email").fill("owner@zerotracker.test"); o.get_by_label("Password").fill(OWNER_PW)
        o.get_by_role("button", name="Enter command center").click(); o.wait_for_url("**/owner")
        o.get_by_role("tab", name="Pending").click()
        card = o.locator(f'article[data-company="{company}"]'); expect(card).to_be_visible(); check("owner sees the pending company", True)
        card.get_by_role("button", name="View details").click()
        expect(card.get_by_text("RC1234567")).to_be_visible(); check("owner can review submitted CAC details", True)
        o.screenshot(path="/tmp/ui-owner.png")
        card.get_by_role("button", name="Approve").click()
        expect(o.locator(f'article[data-company="{company}"]')).to_have_count(0, timeout=8000); check("approved company leaves the Pending tab", True)

        print("Live unlock")
        t0 = time.time()
        expect(m.get_by_text("You're approved")).to_be_visible(timeout=10000)
        check(f"manager page unlocked live with NO reload ({time.time() - t0:.1f}s)", True)
        expect(m.get_by_role("heading", name="Fleet & driver links")).to_be_visible(); check("fleet panel appears live on approval", True)
        m.screenshot(path="/tmp/ui-approved.png")

        print("Vehicles & driver link")
        mgr.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
        m.get_by_label("Vehicle label").fill("Truck 01"); m.get_by_label("Plate number").fill("abc-123xy"); m.get_by_label("Driver name").fill("Musa")
        m.get_by_role("button", name="Add vehicle").click()
        reveal = m.get_by_test_id("link-reveal"); expect(reveal).to_be_visible()
        link = m.get_by_label("Driver link").input_value()
        check("one-time driver link is shown", link.startswith(BASE + "/d/") and len(link) > len(BASE) + 30)
        m.get_by_role("button", name="Copy link").click(); expect(m.get_by_role("button", name="Copied ✓")).to_be_visible()
        check("one-click copy puts the link on the clipboard", m.evaluate("navigator.clipboard.readText()") == link)
        row = m.locator('article[data-vehicle="Truck 01"]'); expect(row).to_contain_text("ABC-123XY"); expect(row).to_contain_text("Active")
        check("vehicle row shows plate and Active status", True)
        m.screenshot(path="/tmp/ui-fleet.png")
        m.reload(); expect(m.locator('article[data-vehicle="Truck 01"]')).to_be_visible()
        check("link is gone after reload (shown only once)", m.get_by_test_id("link-reveal").count() == 0)

        print("Driver phone")
        drv = b.new_context(viewport={"width": 390, "height": 780}, is_mobile=True, has_touch=True, permissions=["geolocation"], geolocation={"latitude": 6.335, "longitude": 5.6037, "accuracy": 10}); d = drv.new_page()
        d.goto(link); expect(d.get_by_text("Before you start")).to_be_visible(); check("driver opens link: consent screen first (no login)", True)
        agree = d.get_by_role("button", name="Agree & continue"); check("cannot continue without ticking consent", agree.is_disabled())
        d.get_by_role("checkbox").check(); agree.click()
        expect(d.get_by_role("heading", name="Truck 01")).to_be_visible(); check("bound to the vehicle: shows its label", True)
        d.screenshot(path="/tmp/ui-driver-ready.png")
        d.get_by_role("button", name="Start Trip").click()
        expect(d.get_by_text("Location sharing is ON")).to_be_visible(timeout=8000); check("trip starts; real browser GPS fix turns on the 'Location sharing is ON' indicator", True)
        d.screenshot(path="/tmp/ui-driver-active.png")
        d.reload(); expect(d.get_by_text("Location sharing is ON")).to_be_visible(timeout=8000)
        check("trip auto-resumes after a page refresh", True)
        check("browser is bound to the vehicle in localStorage", "zt:driver" in d.evaluate("Object.keys(localStorage)"))

        print("Instant revoke (✕)")
        m.get_by_role("button", name="Revoke link for Truck 01").click()
        m.get_by_role("button", name="Confirm revoke").click()
        expect(m.locator('article[data-vehicle="Truck 01"]')).to_contain_text("No active link")
        t0 = time.time(); expect(d.get_by_text("Access revoked by your manager")).to_be_visible(timeout=10000)
        check(f"driver client locked out within seconds ({time.time() - t0:.1f}s)", True)
        check("lockout wiped the stored binding and trip", d.evaluate("[localStorage.getItem('zt:driver'), localStorage.getItem('zt:trip')]") == [None, None])
        d.screenshot(path="/tmp/ui-driver-locked.png")
        d.reload(); expect(d.get_by_text("Access revoked by your manager")).to_be_visible(); check("revoked link stays locked after reload", True)

        print("New link + suspension")
        m.get_by_role("button", name="New link").click()
        link2 = m.get_by_label("Driver link").input_value(); check("new link issued for the same vehicle", link2 != link and link2.startswith(BASE + "/d/"))
        d.goto(link2); d.get_by_role("checkbox").check() if d.get_by_role("checkbox").count() else None
        expect(d.get_by_text("Before you start").or_(d.get_by_role("heading", name="Truck 01"))).to_be_visible(); check("new link works for the driver", True)
        o.get_by_role("tab", name="Approved").click()
        c2 = o.locator(f'article[data-company="{company}"]'); expect(c2).to_be_visible()
        c2.get_by_role("button", name="Suspend").click()
        c2.get_by_label("Note to the company (required)").fill("Documents expired")
        c2.get_by_role("button", name="Confirm suspend").click()
        expect(m.get_by_text("Account suspended")).to_be_visible(timeout=10000)
        expect(m.get_by_text("Documents expired")).to_be_visible(); check("suspension + reason reach the manager live", True)
        check("fleet panel disappears from the suspended manager's page", m.get_by_role("heading", name="Fleet & driver links").count() == 0)
        expect(d.get_by_text("Tracking is currently disabled")).to_be_visible(timeout=10000); check("suspension locks the open driver page live", True)
        o.get_by_role("tab", name="Suspended").click()
        o.locator(f'article[data-company="{company}"]').get_by_role("button", name="Reinstate").click()
        expect(m.get_by_role("heading", name="Fleet & driver links")).to_be_visible(timeout=10000); check("reinstatement restores the fleet panel live", True)
        b.close()
finally:
    srv.terminate(); srv.wait()

print("\nRealtime (Ably) wiring")
srv = start("ably")
try:
    with sync_playwright() as p:
        b = watch(p.chromium.launch()); ctx = b.new_context(); pg = ctx.new_page()
        token_calls, script_loaded = [], []
        pg.on("request", lambda r: token_calls.append((r.method, r.url)))
        pg.on("response", lambda r: script_loaded.append(r.status) if r.url.endswith("/vendor/ably.min.js") else None)
        pg.goto(BASE + "/login"); pg.get_by_label("Work email").fill(email); pg.get_by_label("Access key").fill(key)
        pg.get_by_role("button", name="Sign in").click(); pg.wait_for_url("**/dashboard"); pg.wait_for_timeout(4000)
        drv_calls = []
        dp = ctx.new_page(); dp.on("request", lambda r: drv_calls.append((r.method, r.url, r.headers.get("x-driver-token"))))
        dp.goto(link2); dp.wait_for_timeout(4000)
        check("self-hosted Ably bundle served (200)", 200 in script_loaded)
        check("browser Ably client requested a scoped token via POST /api/realtime/token",
              any(m == "POST" and "/api/realtime/token" in u for m, u in token_calls))
        check("browser then presented our signed token request to Ably (/keys/<keyName>/requestToken)",
              any("/keys/testapp.testkey/requestToken" in u for _, u in token_calls))
        check("driver page asked for its own realtime token, sending the link in a header",
              any(m_ == "POST" and u.endswith("/api/driver/realtime-token") or ("/api/driver/realtime-token" in u and m_ == "POST") for m_, u, _ in drv_calls)
              and any(h and len(h) > 30 for _, u, h in drv_calls if "/api/driver/realtime-token" in u))
        check("driver's Ably client then presented the signed request to Ably",
              any("/keys/testapp.testkey/requestToken" in u for _, u, _ in drv_calls))
        b.close()
finally:
    srv.terminate(); srv.wait()

check("no Content-Security-Policy violations in any browser session" + (f" {CSP[:2]}" if CSP else ""), not CSP)
print(f"\n{passed} passed, {failed} failed"); sys.exit(1 if failed else 0)
