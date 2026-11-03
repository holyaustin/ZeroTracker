"""Phase 6 browser tests (Playwright): live fleet map, route history, impact markers and the incident feed.
   pip install playwright && python -m playwright install chromium
   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db python test/map.py   (needs a built app: npm run build)"""
import base64, re, struct, time, uuid, zlib, json, urllib.request
from playwright.sync_api import sync_playwright, expect
from helpers import *

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


def png(rgb):
    def chunk(t, d): c = struct.pack(">I", len(d)) + t + d; return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(rgb))) + chunk(b"IEND", b"")
TILE = png((15, 27, 46))

def send(raw, ev, batch=False):
    path = "/api/telemetry/batch" if batch else "/api/telemetry"
    req = urllib.request.Request(BASE + path, json.dumps({"events": ev} if batch else ev).encode(), {"content-type": "application/json", "x-driver-token": raw, "x-forwarded-for": f"10.7.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"}, method="POST")
    try: r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e: r = e
    return r.status
def ping(lat, lng, speed=0, battery=None, app="FOREGROUND", ts=None):
    return {"kind": "ping", "clientEventId": uuid.uuid4().hex, "ts": ts or int(time.time() * 1000), "lat": lat, "lng": lng, "speedKmh": speed, "accuracyM": 8, "heading": 90,
            "batteryPct": battery, "charging": False if battery is not None else None, "appState": app}
def incident(t, lat=None, lng=None, g=None, msg="", ts=None):
    return {"kind": "incident", "clientEventId": uuid.uuid4().hex, "ts": ts or int(time.time() * 1000), "type": t, "gForce": g, "lat": lat, "lng": lng, "message": msg}
def token_of(link): return link.split("/d/")[1]

def login_ctx(b, company, port=None, viewport=None, tiles="ok"):
    ctx = b.new_context(viewport=viewport or {"width": 1280, "height": 1100})
    ctx.add_cookies([{"name": "zt_session", "value": company.cookie.split("=", 1)[1], "url": f"http://localhost:{port or PORT}"}])
    carto, osm = {"requests": 0}, {"requests": 0}
    def serve(counter): return lambda r: (counter.__setitem__("requests", counter["requests"] + 1), r.fulfill(status=200, content_type="image/png", body=TILE))
    def fail(counter): return lambda r: (counter.__setitem__("requests", counter["requests"] + 1), r.abort())
    ctx.route(re.compile(r".*basemaps\.cartocdn\.com.*"), serve(carto) if tiles in ("ok",) else fail(carto))
    ctx.route(re.compile(r".*tile\.openstreetmap\.org.*"), serve(osm))
    return ctx, carto, osm

def local_input(page, offset_ms):
    return page.evaluate("o => { const d = new Date(Date.now() + o); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }", offset_ms)

srv = start_server()
try:
  co = Company("Map Haulage"); co2 = Company("Other Fleet Co")
  now = int(time.time() * 1000)

  # ------------------------------------------------------------------ seed data through the real driver API
  V = {}
  for name in ["Moving Van", "Idle Van", "Bg Van", "Off Van", "Wait Van", '<img src=x onerror="window.__xss=1">Evil', "Route Van", "Feed Van"]:
      link, tid, vid = co.vehicle(name); V[name] = {"raw": token_of(link), "tid": tid, "vid": vid}
  send(V["Moving Van"]["raw"], ping(6.335, 5.6037, 48, 76))
  send(V["Idle Van"]["raw"], ping(6.34, 5.61, 0, 55))
  send(V["Bg Van"]["raw"], ping(6.33, 5.60, 20, 40, "BACKGROUNDED"))
  send(V["Off Van"]["raw"], ping(6.345, 5.62, 12, 30))
  EVIL = '<img src=x onerror="window.__xss=1">Evil'
  send(V[EVIL]["raw"], ping(6.338, 5.615, 0, 90))
  dbq("update vehicle_status set last_seen_at = now() - interval '5 minutes' where vehicle_id=$1", V["Off Van"]["vid"])
  base = now - 30 * 60_000
  send(V["Route Van"]["raw"], [ping(6.30 + i * 0.001, 5.60, 30 + i, 60, ts=base + i * 30_000) for i in range(40)], batch=True)
  send(V["Route Van"]["raw"], [incident("IMPACT", 6.31, 5.60, 4.8, "Severe impact", now - 20 * 60_000), incident("POTHOLE", 6.32, 5.60, 3.9, "Pothole", now - 10 * 60_000),
                               incident("IMPACT", 6.33, 5.60, 7.1, "Old impact", now - 2 * 3600_000), incident("IMPACT", None, None, 5.5, "no gps", now - 5 * 60_000)], batch=True)
  dbq("insert into incidents (vehicle_id, org_id, type, message, ts) select $1::uuid, $2::uuid, 'GPS_PING', 'seed ' || g, now() - (g * interval '1 minute') from generate_series(1, 60) g", V["Feed Van"]["vid"], co.id)
  l2, t2, v2 = co2.vehicle("Other Co Van"); send(token_of(l2), ping(7.0, 3.9, 30, 80))

  with sync_playwright() as p:
    b = watch(p.chromium.launch())
    ctx, carto, osm = login_ctx(b, co); d = ctx.new_page()
    d.add_init_script("window.addEventListener('error', () => {});")
    d.goto(BASE + "/dashboard")
    box = d.locator('[data-testid="map"]')
    expect(box).to_have_attribute("data-ready", "1", timeout=15000)

    print("Map & markers")
    d.wait_for_timeout(2500)
    check("CARTO dark tiles are used when reachable", box.get_attribute("data-tiles") == "carto" and carto["requests"] > 0 and osm["requests"] == 0)
    esc = lambda n: n.replace("\\", "\\\\").replace('"', '\\"')
    mk = lambda name: d.locator(f'.zt-marker[data-vehicle="{esc(name)}"]')
    check("moving vehicle: green marker", wait_for(d, lambda: "zt-moving" in (mk("Moving Van").get_attribute("class") or ""), 5))
    check("idle vehicle: blue marker", "zt-idle" in (mk("Idle Van").get_attribute("class") or ""))
    check("app-in-background vehicle: amber marker", "zt-backgrounded" in (mk("Bg Van").get_attribute("class") or ""))
    check("silent for 5 min: grey (offline) marker", "zt-offline" in (mk("Off Van").get_attribute("class") or ""))
    check("vehicle with no position yet is not drawn on the map", d.locator('.zt-marker[data-vehicle="Wait Van"]').count() == 0)
    expect(d.locator('[data-testid="veh-row"][data-vehicle="Wait Van"]')).to_contain_text("Waiting for first position"); check("…but is listed as 'Waiting for first position'", True)
    check("6 markers: moving ×2 (incl. route van), idle ×2, background, offline", d.locator(".zt-marker").count() == 6, str(d.locator(".zt-marker").count()))
    cnt = lambda s: int(d.locator(f'[data-count="{s}"] b').inner_text())
    check("legend counters: moving 2 · idle 2 · background 1 · offline 1", [cnt("moving"), cnt("idle"), cnt("backgrounded"), cnt("offline")] == [2, 2, 1, 1], str([cnt(s) for s in ("moving", "idle", "backgrounded", "offline")]))
    check("map zoomed to fit the fleet (vehicles are visible, not the whole country)", all(mk(n).is_visible() for n in ("Moving Van", "Idle Van", "Off Van")))
    d.locator('[data-testid="map"]').scroll_into_view_if_needed(); d.screenshot(path="/tmp/map-overview.png")

    print("Security: hostile vehicle name")
    check("script in a vehicle name never executes", d.evaluate("window.__xss") is None)
    check("name shown as plain text on the marker and in the list", mk(EVIL).count() == 1 and d.locator('[data-testid="veh-row"]').filter(has_text=EVIL).count() == 1)
    check("no injected <img> elements exist", d.locator("img[src='x']").count() == 0)
    mk(EVIL).click(); expect(d.locator(".leaflet-popup .zt-title").last).to_have_text(EVIL); check("popup also renders it as text", d.evaluate("window.__xss") is None)
    d.keyboard.press("Escape")

    print("Popups & list")
    mk("Moving Van").click()
    pop = d.locator('.leaflet-popup [data-popup="vehicle"]').last; expect(pop).to_be_visible()
    t = pop.inner_text()
    check("popup shows name, status, speed 48 km/h, battery 76%, last seen", "Moving Van" in t and "Moving" in t and "48 km/h" in t and "76%" in t and re.search(r"just now|\ds ago", t) is not None, t)
    css = lambda q, prop: d.evaluate("([q, p]) => getComputedStyle(document.querySelector(q))[p]", [q, prop])
    check("popup is dark-themed (Leaflet's light default is overridden)", css(".leaflet-popup-content-wrapper", "backgroundColor") == "rgb(15, 23, 42)" and css(".leaflet-popup-content-wrapper", "color") == "rgb(226, 232, 240)", css(".leaflet-popup-content-wrapper", "backgroundColor"))
    check("map canvas background is dark while tiles load", css('[data-testid="map"]', "backgroundColor") == "rgb(11, 18, 32)", css('[data-testid="map"]', "backgroundColor"))
    check("zoom buttons are dark-themed", css(".leaflet-bar a", "backgroundColor") == "rgb(15, 23, 42)")
    d.locator('[data-testid="veh-row"][data-vehicle="Idle Van"]').click()
    expect(d.locator('.leaflet-popup [data-popup="vehicle"] .zt-title').last).to_have_text("Idle Van"); check("clicking a list row opens that vehicle's popup", True)
    check("list row shows speed, battery and last seen", re.search(r"0 km/h · 55% ·", d.locator('[data-testid="veh-row"][data-vehicle="Idle Van"]').inner_text()) is not None)

    print("Live updates (no reload)")
    d.keyboard.press("Escape")
    box0 = mk("Moving Van").bounding_box()
    send(V["Moving Van"]["raw"], ping(6.40, 5.70, 72, 74))
    check("new speed appears in the list within seconds", wait_for(d, lambda: "72 km/h" in d.locator('[data-testid="veh-row"][data-vehicle="Moving Van"]').inner_text(), 8))
    box1 = mk("Moving Van").bounding_box()
    check("the marker moved on the map", abs(box1["x"] - box0["x"]) + abs(box1["y"] - box0["y"]) > 5, f"{box0} → {box1}")
    send(V["Moving Van"]["raw"], ping(6.40, 5.70, 72, 74, "BACKGROUNDED"))
    check("app backgrounded: marker turns amber and the counter updates", wait_for(d, lambda: "zt-backgrounded" in (mk("Moving Van").get_attribute("class") or ""), 8) and cnt("backgrounded") == 2)
    send(V["Moving Van"]["raw"], ping(6.40, 5.70, 0, 74))
    check("back in foreground and stopped: marker turns blue (idle)", wait_for(d, lambda: "zt-idle" in (mk("Moving Van").get_attribute("class") or ""), 8))
    dbq("update vehicle_status set last_seen_at = now() - interval '3 minutes' where vehicle_id=$1", V["Moving Van"]["vid"])
    check("60 s of silence: marker turns grey (offline)", wait_for(d, lambda: "zt-offline" in (mk("Moving Van").get_attribute("class") or ""), 10))
    check("…and a DISCONNECTED event is logged once", dbq("select count(*)::int n from incidents where vehicle_id=$1 and type='DISCONNECTED'", V["Moving Van"]["vid"])[0]["n"] == 1)
    send(V["Moving Van"]["raw"], ping(6.40, 5.70, 33, 73))
    check("driver reconnects: marker is green again", wait_for(d, lambda: "zt-moving" in (mk("Moving Van").get_attribute("class") or ""), 8))

    link, tid, vid = co.vehicle("Late Van"); send(token_of(link), ping(6.36, 5.64, 10, 60))
    check("a newly added vehicle appears without a reload", wait_for(d, lambda: d.locator('[data-testid="veh-row"][data-vehicle="Late Van"]').count() == 1 and mk("Late Van").count() == 1, 8))
    n_before = d.locator(".zt-marker").count()
    call("DELETE", f"/api/tokens/{tid}", None, co.cookie)
    check("revoking its link removes it from the map and list live", wait_for(d, lambda: d.locator('[data-testid="veh-row"][data-vehicle="Late Van"]').count() == 0 and mk("Late Van").count() == 0, 8) and d.locator(".zt-marker").count() == n_before - 1)

    print("Impact / pothole markers")
    imp = d.locator(".zt-impact:not(.zt-impact-route)")
    check("recent impacts with a position are pinned in red (3 seeded)", wait_for(d, lambda: imp.count() == 3, 8), str(imp.count()))
    send(V["Idle Van"]["raw"], incident("IMPACT", 6.341, 5.611, 6.8, "Collision-grade impact"))
    check("a new impact appears as a red marker live", wait_for(d, lambda: imp.count() == 4, 8))
    send(V["Idle Van"]["raw"], incident("POTHOLE", 6.342, 5.612, 3.8, "Road shock"))
    check("…and a pothole too", wait_for(d, lambda: imp.count() == 5, 8))
    send(V["Idle Van"]["raw"], incident("IMPACT", None, None, 9.0, "no GPS fix"))
    d.wait_for_timeout(2500); check("an impact with no GPS position is not pinned", imp.count() == 5)
    d.evaluate("window.scrollTo(0, 0)")
    imp.nth(0).dispatch_event("click")
    pp = d.locator('.leaflet-popup [data-popup="impact"]').last; expect(pp).to_be_visible()
    check("impact popup shows type, vehicle, force and time", re.search(r"(Severe impact|Pothole / road shock)", pp.inner_text()) and re.search(r"\d\.\d G", pp.inner_text()) and "Van" in pp.inner_text(), pp.inner_text())
    d.keyboard.press("Escape")

    print("Incident & telemetry feed")
    items = d.locator('[data-testid="feed-item"]')
    check("feed lists events, newest first", items.count() >= 10)
    check("it contains the live impacts, GPS pings and connection events", all(d.locator(f'[data-testid="feed-item"][data-type="{t}"]').count() >= 1 for t in ("IMPACT", "POTHOLE", "GPS_PING", "CONNECTED", "DISCONNECTED")))
    send(V["Bg Van"]["raw"], incident("LOW_BATTERY", 6.33, 5.60, None, "Battery low (19%)"))
    check("a new event appears at the TOP of the feed live", wait_for(d, lambda: items.first.get_attribute("data-type") == "LOW_BATTERY" and items.first.get_attribute("data-vehicle") == "Bg Van", 8))
    send(V["Bg Van"]["raw"], incident("BACKGROUNDED", 6.33, 5.60, None, "Driver switched away"))
    check("events arrive in order (newest first)", wait_for(d, lambda: items.first.get_attribute("data-type") == "BACKGROUNDED", 8))
    d.get_by_role("tab", name="Impacts").click()
    check("'Impacts' filter: only IMPACT/POTHOLE rows", wait_for(d, lambda: items.count() >= 5 and all(t in ("IMPACT", "POTHOLE") for t in items.evaluate_all("els => els.map(e => e.dataset.type)")), 6))
    d.get_by_role("tab", name="Battery").click()
    check("'Battery' filter: only LOW_BATTERY rows", wait_for(d, lambda: items.count() >= 1 and set(items.evaluate_all("els => els.map(e => e.dataset.type)")) == {"LOW_BATTERY"}, 6))
    d.get_by_role("tab", name="Connection").click()
    check("'Connection' filter: CONNECTED / DISCONNECTED only", wait_for(d, lambda: items.count() >= 2 and set(items.evaluate_all("els => els.map(e => e.dataset.type)")) <= {"CONNECTED", "DISCONNECTED"}, 6))
    d.get_by_role("tab", name="All").click(); d.get_by_label("Filter by vehicle").select_option(label="Bg Van")
    check("vehicle filter: only that vehicle's events", wait_for(d, lambda: items.count() >= 2 and set(items.evaluate_all("els => els.map(e => e.dataset.vehicle)")) == {"Bg Van"}, 6))
    d.get_by_label("Filter by vehicle").select_option(label="Feed Van")
    check("a filtered feed starts at 50 with a 'Load older events' button", wait_for(d, lambda: items.count() == 50, 6) and d.get_by_role("button", name="Load older events").is_visible())
    d.get_by_role("button", name="Load older events").click()
    check("loading older events shows all 60 and removes the button", wait_for(d, lambda: items.count() == 60, 6) and d.get_by_role("button", name="Load older events").count() == 0)
    d.get_by_label("Filter by vehicle").select_option(label="All vehicles"); d.get_by_role("tab", name="All").click()
    d.locator('[data-testid="feed"]').scroll_into_view_if_needed(); d.screenshot(path="/tmp/map-feed.png")

    print("Route history")
    d.evaluate("window.scrollTo(0, 0)")
    d.locator("#hist-vehicle").select_option(label="Route Van"); d.get_by_role("button", name="24 h", exact=True).click()
    d.get_by_role("button", name="Show route").click()
    expect(d.locator("path.zt-route")).to_have_count(1, timeout=8000); check("route line is drawn on the map", True)
    check("start (green) and end (white) markers", d.locator(".zt-route-start").count() == 1 and d.locator(".zt-route-end").count() == 1)
    sm = d.locator('[data-testid="route-summary"]'); expect(sm).to_be_visible()
    dist = float(re.search(r"([\d.]+) km", sm.locator('[data-k="distance"]').inner_text()).group(1))
    check(f"summary distance ≈ 4.34 km (got {dist})", abs(dist - 4.34) < 0.06)
    check("summary: 40 positions, max 69 km/h, duration 20 min", "40 positions" in sm.inner_text() and "69 km/h" in sm.inner_text() and "20 min" in sm.inner_text(), sm.inner_text())
    check("route impacts: 3 red markers on the route, count 3", d.locator(".zt-impact-route").count() == 3 and sm.locator('[data-k="impacts"]').inner_text() == "3")
    d.screenshot(path="/tmp/map-route.png")
    d.locator("#hist-from").fill(local_input(d, -3 * 86400_000)); d.locator("#hist-to").fill(local_input(d, -2 * 86400_000))
    d.get_by_role("button", name="Show route").click()
    expect(d.get_by_test_id("route-msg")).to_contain_text("No positions were recorded"); check("an empty range says so and clears the line", d.locator("path.zt-route").count() == 0)
    d.locator("#hist-from").fill(local_input(d, 3600_000)); d.locator("#hist-to").fill(local_input(d, 0))
    d.get_by_role("button", name="Show route").click()
    expect(d.get_by_test_id("route-msg")).to_contain_text("From must be earlier than To"); check("a reversed range is rejected with a clear message", True)
    d.get_by_role("button", name="Clear").click(); check("Clear removes the message", d.get_by_test_id("route-msg").count() == 0)
    send(V["Idle Van"]["raw"], ping(6.3421, 5.6121, 0, 55))      # a position from this very second must be inside "1 h" (inputs have minute precision)
    d.get_by_role("button", name="1 h", exact=True).click(); d.locator("#hist-vehicle").select_option(label="Idle Van"); d.get_by_role("button", name="Show route").click()
    expect(d.locator("path.zt-route")).to_have_count(1, timeout=8000)
    check("'1 h' includes a position sent seconds ago (the 'To' minute is inclusive)", "2 positions" in d.get_by_test_id("route-summary").inner_text(), d.get_by_test_id("route-summary").inner_text())
    d.get_by_role("button", name="Clear").click()
    d.locator("#hist-vehicle").select_option(label="Bg Van"); d.get_by_role("button", name="Show route").click()
    expect(d.get_by_test_id("route-msg")).to_contain_text("Only one position")
    check("a vehicle with a single position: clear message, no line", d.locator("path.zt-route").count() == 0)
    check("…and its position is still marked", d.locator(".zt-route-start").count() == 1)
    d.get_by_role("button", name="Clear").click(); check("clearing removes the line and its markers", d.locator(".zt-impact-route").count() == 0 and d.locator(".zt-route-start").count() == 0)
    ctx.close()

    print("Tile fallback (CARTO blocked → OpenStreetMap)")
    ctx, carto, osm = login_ctx(b, co, tiles="blocked"); d = ctx.new_page(); d.goto(BASE + "/dashboard")
    box = d.locator('[data-testid="map"]'); expect(box).to_have_attribute("data-ready", "1", timeout=15000)
    check("after repeated CARTO tile errors the map switches to OpenStreetMap", wait_for(d, lambda: box.get_attribute("data-tiles") == "osm", 12))
    check("OpenStreetMap tiles are requested", wait_for(d, lambda: osm["requests"] > 0, 6))
    check("OSM layer is darkened to match the dashboard", "osm-dark" in (box.get_attribute("class") or ""))
    check("vehicles still render on the fallback map", d.locator(".zt-marker").count() >= 5)
    ctx.close()

    print("Tenant isolation in the UI")
    ctx, _, _ = login_ctx(b, co2); d = ctx.new_page(); d.goto(BASE + "/dashboard")
    expect(d.locator('[data-testid="map"]')).to_have_attribute("data-ready", "1", timeout=15000)
    expect(d.locator('[data-testid="veh-row"]')).to_have_count(1, timeout=8000)
    check("another company sees only its own vehicle", d.locator('[data-testid="veh-row"]').first.get_attribute("data-vehicle") == "Other Co Van" and d.locator(".zt-marker").count() == 1)
    d.wait_for_timeout(2500)
    labels = d.locator('[data-testid="feed-item"]').evaluate_all("els => els.map(e => e.dataset.vehicle)")
    check("its feed contains none of the first company's vehicles", len(labels) >= 1 and set(labels) == {"Other Co Van"}, str(set(labels)))
    check("none of the first company's impacts leak onto its map", d.locator(".zt-impact").count() == 0)
    ctx.close()

    print("Access control while live")
    ctx, _, _ = login_ctx(b, co); d = ctx.new_page(); d.goto(BASE + "/dashboard")
    expect(d.locator('[data-testid="map"]')).to_have_attribute("data-ready", "1", timeout=15000)
    _, _, own = call("POST", "/api/owner/login", {"email": "owner@zerotracker.test", "password": OWNER_PW})
    call("PATCH", f"/api/owner/companies/{co.id}/status", {"action": "SUSPEND", "note": "map test"}, own)
    expect(d.get_by_text("Account suspended")).to_be_visible(timeout=10000)
    check("suspension removes the live map and feed from the open page", d.locator('[data-testid="live-fleet"]').count() == 0 and d.locator('[data-testid="feed"]').count() == 0)
    check("the live API is closed to a suspended company (403)", call("GET", "/api/fleet/live", None, co.cookie)[0] == 403 and call("GET", "/api/incidents", None, co.cookie)[0] == 403)
    call("PATCH", f"/api/owner/companies/{co.id}/status", {"action": "APPROVE"}, own)
    expect(d.locator('[data-testid="live-fleet"]')).to_be_visible(timeout=10000); check("reinstatement brings the map back", True)
    ctx.close()

    print("Phone-sized screen")
    ctx, _, _ = login_ctx(b, co, viewport={"width": 390, "height": 844}); d = ctx.new_page(); d.goto(BASE + "/dashboard")
    expect(d.locator('[data-testid="map"]')).to_have_attribute("data-ready", "1", timeout=15000); d.wait_for_timeout(1500)
    check("no horizontal scrolling on a phone", d.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    check("map and vehicle list both usable on a phone", d.locator('[data-testid="map"]').is_visible() and d.locator('[data-testid="veh-row"]').first.is_visible())
    d.locator('[data-testid="live-fleet"]').scroll_into_view_if_needed(); d.screenshot(path="/tmp/map-mobile.png")
    ctx.close()
    b.close()
finally:
    srv.terminate(); srv.wait()

print("\nRealtime wiring (Ably mode)")
srv = start_server(driver="ably", port=3116)
try:
  with sync_playwright() as p:
    b = watch(p.chromium.launch()); ctx, _, _ = login_ctx(b, co, port=3116); d = ctx.new_page(); calls = []
    d.on("request", lambda r: calls.append((r.method, r.url)))
    d.goto("http://localhost:3116/dashboard"); d.wait_for_timeout(5000)
    toks = [u for m, u in calls if m == "POST" and "/api/realtime/token" in u]
    check("the dashboard AND the live map each open their own scoped Ably connection", len(toks) >= 2, str(len(toks)))
    check("browser presents our signed token request to Ably", any("/keys/testapp.testkey/requestToken" in u for _, u in calls))
    check("map still renders from the server snapshot when realtime is unreachable", d.locator(".zt-marker").count() >= 5)
    b.close()
finally:
    srv.terminate(); srv.wait()
check("no Content-Security-Policy violations in any browser session", not CSP, str(CSP[:3]))
finish()
