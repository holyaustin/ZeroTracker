// End-to-end tests: builds the app, starts it against a LOCAL Postgres with dummy env, and exercises every route.
// Usage: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test   (this DB is wiped!)
import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import bcrypt from "bcryptjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.TEST_DATABASE_URL ?? "postgres://zt:zt@localhost:5432/zerotracker";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) { console.error("Refusing: TEST_DATABASE_URL must be localhost (it gets wiped)."); process.exit(1); }

const PORT = 3111, BASE = `http://localhost:${PORT}`, OUTBOX = "/tmp/zt-outbox.jsonl";
const OWNER_PW = "Owner-Pass-123!";
const env = {
  ...process.env, DATABASE_URL: DB, JWT_SECRET: "test-secret-test-secret-test-secret-32", NODE_ENV: "production",
  OWNER_EMAIL: "owner@zerotracker.test", OWNER_PASSWORD_HASH: bcrypt.hashSync(OWNER_PW, 4),
  BREVO_API_KEY: "console", BREVO_SENDER_EMAIL: "noreply@zerotracker.test", OUTBOX_PATH: OUTBOX,
  ABLY_API_KEY: "testapp.testkey:testsecret", APP_URL: BASE, CRON_SECRET: "cron-secret-for-tests-1234567890",
  REALTIME_DRIVER: "console", REALTIME_OUTBOX_PATH: "/tmp/zt-realtime.jsonl", STATUS_POLL_MS: "1500",
};

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { cond ? passed++ : failed++; console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond ? "" : "  " + extra}`); };
const rtEvents = () => (existsSync("/tmp/zt-realtime.jsonl") ? readFileSync("/tmp/zt-realtime.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const outbox = () => (existsSync(OUTBOX) ? readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let ipN = 0; const freshIp = () => `10.0.0.${++ipN}`;
const post = (path, body, { cookie, ip = freshIp() } = {}) =>
  fetch(BASE + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => c.startsWith("zt_session=")) ?? "").split(";")[0];
const page = (path, cookie) => fetch(BASE + path, { redirect: "manual", headers: cookie ? { cookie } : {} });

async function main() {
  console.log("Preparing database…");
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  await c.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  execSync("npx drizzle-kit migrate", { env, stdio: "pipe" });
  rmSync(OUTBOX, { force: true }); rmSync("/tmp/zt-realtime.jsonl", { force: true });
  console.log("Building…");
  if (!process.env.SKIP_BUILD) execSync("npm run build", { env, stdio: "pipe", timeout: 240000 });
  const srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { env, stdio: "pipe" });
  let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60 && !(await fetch(BASE).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 500));

  try {
    console.log("\nPages & headers");
    let r = await page("/"); const html = await r.text();
    ok("landing page renders", r.status === 200 && html.includes("Install nothing"));
    ok("security headers set", r.headers.get("x-frame-options") === "DENY" && r.headers.get("strict-transport-security")?.includes("max-age") && r.headers.get("x-content-type-options") === "nosniff");
    ok("x-powered-by hidden", !r.headers.has("x-powered-by"));
    for (const p of ["/login", "/register", "/forgot", "/owner/login", "/reset?token=abc"]) ok(`GET ${p} → 200`, (await page(p)).status === 200);
    ok("reset page without token shows error", (await (await page("/reset")).text()).includes("missing its token"));
    const css = (html.match(/\/_next\/static\/css\/[^"]+\.css/) ?? [])[0];
    const cssText = css ? await (await fetch(BASE + css)).text() : "";
    ok("Tailwind CSS compiled (utility classes present)", cssText.includes(".bg-slate-950") || cssText.includes("bg-slate-950"));

    console.log("\nRegistration");
    r = await post("/api/auth/register", { name: "A", email: "bad" }); ok("invalid input → 400", r.status === 400);
    r = await post("/api/auth/register", { name: "Acme Logistics", email: "Manager@Acme.test" });
    ok("register → 201", r.status === 201);
    const mail = outbox().find((m) => m.to === "manager@acme.test");
    const key = mail?.html.match(/ZT-[A-Za-z0-9_-]+/)?.[0];
    ok("access key emailed (email lowercased)", !!key && key.length > 30, JSON.stringify(mail));
    r = await post("/api/auth/register", { name: "Acme Again", email: "manager@acme.test" }); ok("duplicate email → 409", r.status === 409);
    const row = (await c.query("select * from organizations where email='manager@acme.test'")).rows[0];
    ok("only bcrypt hash stored, never the key", row.password_hash.startsWith("$2") && !row.password_hash.includes(key));
    ok("new org status is UNVERIFIED", row.status === "UNVERIFIED");
    await post("/api/auth/register", { name: "XSS", email: "x@xss.test" }).then(() => {});
    r = await post("/api/auth/register", { name: "<script>alert(1)</script>", email: "xss@acme.test" });
    ok("HTML in company name is escaped in email", !outbox().find((m) => m.to === "xss@acme.test")?.html.includes("<script>"));

    console.log("\nLogin & sessions");
    r = await post("/api/auth/login", { email: "manager@acme.test", accessKey: "wrong-key-123" }); ok("wrong key → 401", r.status === 401);
    r = await post("/api/auth/login", { email: "ghost@acme.test", accessKey: "wrong-key-123" }); ok("unknown email → same 401", r.status === 401 && (await r.json()).error === "Invalid credentials");
    r = await post("/api/auth/login", { email: "MANAGER@acme.test", accessKey: key });
    const cookie = cookieOf(r); const lj = await r.json();
    ok("correct key → 200 + session cookie", r.status === 200 && cookie.length > 40 && lj.status === "UNVERIFIED");
    const sc = r.headers.getSetCookie().find((x) => x.startsWith("zt_session="));
    ok("cookie is HttpOnly, SameSite=Lax, Secure", /HttpOnly/i.test(sc) && /SameSite=lax/i.test(sc) && /Secure/i.test(sc), sc);
    r = await page("/dashboard"); ok("dashboard without cookie → redirect /login", r.status === 307 && r.headers.get("location")?.endsWith("/login"));
    r = await page("/dashboard", cookie); const dh = await r.text();
    ok("dashboard with cookie → 200 with org name + locked gate", r.status === 200 && dh.includes("Acme Logistics") && dh.includes("Verify your company"));
    r = await page("/dashboard", "zt_session=garbage.token.value"); ok("tampered JWT → redirect", r.status === 307);
    r = await page("/owner", cookie); ok("manager cannot open /owner", r.status === 307 && r.headers.get("location")?.endsWith("/owner/login"));
    r = await post("/api/auth/logout", {}, { cookie }); ok("logout → 200 and cookie cleared", r.status === 200 && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(r.headers.getSetCookie().join(";")));

    console.log("\nPassword reset");
    const before = outbox().length;
    r = await post("/api/auth/forgot", { email: "nobody@acme.test" }); const fj = await r.json();
    ok("forgot (unknown email) → generic 200, no email sent", r.status === 200 && outbox().length === before && fj.message.includes("If that email exists"));
    r = await post("/api/auth/forgot", { email: "manager@acme.test" }); ok("forgot (known) → same generic 200", r.status === 200);
    const rm = outbox().filter((m) => m.subject.startsWith("Reset")).pop();
    const token = rm?.html.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    ok("reset email contains token link", !!token);
    const stored = (await c.query("select token_hash from password_resets")).rows[0]?.token_hash;
    ok("only the token hash is stored", !!stored && stored !== token && stored.length === 64);
    r = await post("/api/auth/reset", { token, newKey: "short" }); ok("short new key → 400", r.status === 400);
    r = await post("/api/auth/reset", { token: "x".repeat(43), newKey: "A-brand-new-key-123" }); ok("bad token → 400", r.status === 400);
    const NEW = "A-brand-new-key-123";
    r = await post("/api/auth/reset", { token, newKey: NEW }); ok("valid reset → 200", r.status === 200);
    r = await post("/api/auth/reset", { token, newKey: "Another-key-456789" }); ok("token cannot be reused", r.status === 400);
    r = await post("/api/auth/login", { email: "manager@acme.test", accessKey: key }); ok("old key no longer works", r.status === 401);
    r = await post("/api/auth/login", { email: "manager@acme.test", accessKey: NEW }); ok("new key works", r.status === 200);
    await post("/api/auth/forgot", { email: "manager@acme.test" });
    const t2 = outbox().filter((m) => m.subject.startsWith("Reset")).pop().html.match(/token=([A-Za-z0-9_-]+)/)[1];
    await c.query("update password_resets set expires_at = now() - interval '1 minute'");
    r = await post("/api/auth/reset", { token: t2, newKey: "Expired-attempt-1234" }); ok("expired token → 400", r.status === 400);

    console.log("\nOwner");
    r = await post("/api/owner/login", { email: "owner@zerotracker.test", password: "nope" }); ok("owner wrong password → 401", r.status === 401);
    r = await post("/api/owner/login", { email: "attacker@x.test", password: OWNER_PW }); ok("owner wrong email → 401", r.status === 401);
    r = await post("/api/owner/login", { email: "owner@zerotracker.test", password: OWNER_PW });
    const oc = cookieOf(r); ok("owner login → 200", r.status === 200 && oc.length > 40);
    r = await page("/owner", oc); const oh = await r.text();
    ok("owner dashboard shows KPIs", r.status === 200 && oh.includes("Registered companies") && oh.includes("Vehicles provisioned"));
    r = await page("/owner"); ok("owner page without cookie → redirect", r.status === 307 && r.headers.get("location")?.endsWith("/owner/login"));
    r = await page("/dashboard", oc); ok("owner session cannot open manager dashboard", r.status === 307);

    console.log("\nCompany verification gate");
    const mc = cookieOf(await post("/api/auth/login", { email: "manager@acme.test", accessKey: NEW }));
    const orgId = (await c.query("select id from organizations where email='manager@acme.test'")).rows[0].id;
    const good = { cacOrBnNumber: "rc 123456", hqAddress: "12 Airport Road, Benin City, Edo State", whatsappNumber: "+234 801 234 5678", estimatedFleetSize: "25", operationCategory: "Haulage & freight" };
    r = await fetch(BASE + "/api/company/profile"); ok("profile GET without session → 401", r.status === 401);
    r = await post("/api/company/profile", good); ok("profile POST without session → 401", r.status === 401);
    r = await fetch(BASE + "/api/company/profile", { headers: { cookie: mc } }); let pj = await r.json();
    ok("new company is UNVERIFIED with no profile", pj.status === "UNVERIFIED" && pj.profile === null);
    ok("dashboard shows the verification wizard", (await (await page("/dashboard", mc)).text()).includes("Business identity"));
    for (const [label, patchBody, field] of [
      ["bad CAC number", { cacOrBnNumber: "12345" }, "cacOrBnNumber"], ["bad WhatsApp number", { whatsappNumber: "abc" }, "whatsappNumber"],
      ["fleet size 0", { estimatedFleetSize: "0" }, "estimatedFleetSize"], ["fleet size not a number", { estimatedFleetSize: "lots" }, "estimatedFleetSize"],
      ["unknown category", { operationCategory: "Pirate" }, "operationCategory"], ["short address", { hqAddress: "short" }, "hqAddress"],
    ]) {
      r = await post("/api/company/profile", { ...good, ...patchBody }, { cookie: mc }); const j = await r.json();
      ok(`profile rejects ${label} (400 + field error)`, r.status === 400 && !!j.fields?.[field], JSON.stringify(j));
    }
    r = await post("/api/company/profile", {}, { cookie: mc }); ok("empty profile → 400", r.status === 400);
    ok("nothing saved by invalid submissions", (await c.query("select count(*)::int n from company_profiles")).rows[0].n === 0);
    r = await post("/api/company/profile", good, { cookie: mc }); ok("valid profile → 200 PENDING", r.status === 200 && (await r.json()).status === "PENDING");
    const prof = (await c.query("select * from company_profiles where org_id=$1", [orgId])).rows[0];
    ok("profile normalized (CAC upper-case, phone stripped)", prof.cac_or_bn_number === "RC123456" && prof.whatsapp_number === "+2348012345678" && prof.estimated_fleet_size === 25);
    ok("org status is PENDING in DB", (await c.query("select status from organizations where id=$1", [orgId])).rows[0].status === "PENDING");
    ok("owner:global notified of submission", rtEvents().some((e) => e.channel === "owner:global" && e.event === "company-submitted" && e.data.orgId === orgId));
    r = await post("/api/company/profile", good, { cookie: mc }); ok("cannot resubmit while PENDING → 409", r.status === 409);
    ok("dashboard shows under-review state", (await (await page("/dashboard", mc)).text()).includes("under review"));

    console.log("\nOwner review portal");
    const ownerGet = (path) => fetch(BASE + path, { headers: { cookie: oc } });
    const patch = (id, body, cookie = oc) => fetch(`${BASE}/api/owner/companies/${id}/status`, { method: "PATCH", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    ok("owner companies list: no session → 401", (await fetch(BASE + "/api/owner/companies")).status === 401);
    ok("owner companies list: manager session → 401", (await fetch(BASE + "/api/owner/companies", { headers: { cookie: mc } })).status === 401);
    ok("owner stats: manager session → 401", (await fetch(BASE + "/api/owner/stats", { headers: { cookie: mc } })).status === 401);
    let list = (await (await ownerGet("/api/owner/companies")).json()).companies;
    const acme = list.find((x) => x.id === orgId);
    ok("owner list includes company with submitted profile", acme?.status === "PENDING" && acme.profile?.cacOrBnNumber === "RC123456");
    ok("list never leaks password hashes", !JSON.stringify(list).includes("password"));
    list = (await (await ownerGet("/api/owner/companies?status=PENDING")).json()).companies; ok("filter status=PENDING", list.some((x) => x.id === orgId));
    list = (await (await ownerGet("/api/owner/companies?status=APPROVED")).json()).companies; ok("filter status=APPROVED excludes it", !list.some((x) => x.id === orgId));
    ok("invalid status filter → 400", (await ownerGet("/api/owner/companies?status=bogus")).status === 400);
    list = (await (await ownerGet("/api/owner/companies?q=rc1234")).json()).companies; ok("search by CAC number", list.some((x) => x.id === orgId));
    list = (await (await ownerGet("/api/owner/companies?q=acme%20logi")).json()).companies; ok("search by name", list.some((x) => x.id === orgId));
    list = (await (await ownerGet("/api/owner/companies?q=%25")).json()).companies; ok("LIKE wildcards are escaped in search", list.length === 0);
    let st = await (await ownerGet("/api/owner/stats")).json(); ok("owner stats count pending", st.pending === 1 && st.total >= 2 && typeof st.sig === "string");

    ok("PATCH without session → 401", (await patch(orgId, { action: "APPROVE" }, null)).status === 401);
    ok("PATCH as manager → 401", (await patch(orgId, { action: "APPROVE" }, mc)).status === 401);
    ok("PATCH invalid uuid → 400", (await patch("not-a-uuid", { action: "APPROVE" })).status === 400);
    ok("PATCH unknown company → 404", (await patch("00000000-0000-4000-8000-000000000000", { action: "APPROVE" })).status === 404);
    ok("PATCH invalid action → 400", (await patch(orgId, { action: "DELETE" })).status === 400);
    ok("reject without note → 400", (await patch(orgId, { action: "REJECT" })).status === 400);
    const unv = (await c.query("select id from organizations where email='xss@acme.test'")).rows[0].id;
    ok("cannot approve a company that never submitted (UNVERIFIED) → 409", (await patch(unv, { action: "APPROVE" })).status === 409);

    r = await patch(orgId, { action: "APPROVE" }); ok("approve → 200 APPROVED", r.status === 200 && (await r.json()).status === "APPROVED");
    ok("status APPROVED in DB", (await c.query("select status from organizations where id=$1", [orgId])).rows[0].status === "APPROVED");
    ok("profile records reviewer", (await c.query("select reviewed_by, reviewed_at from company_profiles where org_id=$1", [orgId])).rows[0].reviewed_by === "owner");
    ok("approval written to audit log", (await c.query("select 1 from audit_log where action='COMPANY_APPROVED' and target_id=$1", [orgId])).rowCount === 1);
    ok("company-status-updated published to org:<id>:account", rtEvents().some((e) => e.channel === `org:${orgId}:account` && e.event === "company-status-updated" && e.data.status === "APPROVED"));
    ok("manager dashboard now shows approved", (await (await page("/dashboard", mc)).text()).includes("re approved"));
    ok("approving an APPROVED company → 409", (await patch(orgId, { action: "APPROVE" })).status === 409);
    ok("suspend without note → 400", (await patch(orgId, { action: "SUSPEND" })).status === 400);
    r = await patch(orgId, { action: "SUSPEND", note: "Policy violation test" }); ok("suspend with note → 200", r.status === 200);
    const sh = await (await page("/dashboard", mc)).text();
    ok("suspended dashboard shows state and reason", sh.includes("Account suspended") && sh.includes("Policy violation test"));
    ok("suspended company cannot resubmit profile → 409", (await post("/api/company/profile", good, { cookie: mc })).status === 409);
    r = await patch(orgId, { action: "APPROVE" }); ok("reinstate suspended → APPROVED", r.status === 200);
    ok("every action audit-logged", (await c.query("select count(*)::int n from audit_log where target_id=$1", [orgId])).rows[0].n === 3);

    console.log("\nReject → resubmit flow & tenant isolation");
    await post("/api/auth/register", { name: "Beta Freight", email: "beta@beta.test" });
    const keyB = outbox().find((m) => m.to === "beta@beta.test").html.match(/ZT-[A-Za-z0-9_-]+/)[0];
    const mcB = cookieOf(await post("/api/auth/login", { email: "beta@beta.test", accessKey: keyB }));
    const orgB = (await c.query("select id from organizations where email='beta@beta.test'")).rows[0].id;
    ok("company B submits profile", (await post("/api/company/profile", { ...good, cacOrBnNumber: "BN7654321" }, { cookie: mcB })).status === 200);
    ok("reject pending company with note → 200", (await patch(orgB, { action: "REJECT", note: "CAC number could not be verified" })).status === 200);
    const bh = await (await page("/dashboard", mcB)).text();
    ok("rejected dashboard shows reviewer note + wizard again", bh.includes("not approved") && bh.includes("CAC number could not be verified") && bh.includes("Business identity"));
    ok("rejected company can resubmit → PENDING", (await post("/api/company/profile", { ...good, cacOrBnNumber: "BN7654322" }, { cookie: mcB })).status === 200);
    const pb = (await c.query("select cac_or_bn_number, review_note, reviewed_at from company_profiles where org_id=$1", [orgB])).rows[0];
    ok("resubmission updates profile and clears old review", pb.cac_or_bn_number === "BN7654322" && pb.review_note === null && pb.reviewed_at === null);
    ok("A's profile unaffected by B's changes", (await c.query("select cac_or_bn_number from company_profiles where org_id=$1", [orgId])).rows[0].cac_or_bn_number === "RC123456");
    const bp = await (await fetch(BASE + "/api/company/profile", { headers: { cookie: mcB } })).json();
    ok("B's profile API returns only B's data", bp.profile.cacOrBnNumber === "BN7654322" && !JSON.stringify(bp).includes("RC123456"));

    console.log("\nRealtime tokens");
    ok("realtime token without session → 401", (await post("/api/realtime/token", {})).status === 401);
    const tokA = await (await post("/api/realtime/token", {}, { cookie: mc })).json();
    const tokB = await (await post("/api/realtime/token", {}, { cookie: mcB })).json();
    const tokO = await (await post("/api/realtime/token", {}, { cookie: oc })).json();
    ok("manager token: subscribe-only, own org channels only", JSON.stringify(JSON.parse(tokA.capability)) === JSON.stringify({ [`org:${orgId}:*`]: ["subscribe"] }) && tokA.clientId === `manager:${orgId}`);
    ok("manager token is signed", !!tokA.mac && tokA.keyName === "testapp.testkey");
    ok("B's token grants nothing for A's org", !tokB.capability.includes(orgId) && tokB.capability.includes(orgB));
    ok("owner token: owner:global subscribe only", JSON.stringify(JSON.parse(tokO.capability)) === JSON.stringify({ "owner:global": ["subscribe"] }));

    console.log("\nVehicles, driver links & lockout");
    let codes = [];
    const api = (method, path, { cookie, body, driver, ip } = {}) => fetch(BASE + path, { method, redirect: "manual",
      headers: { "content-type": "application/json", "x-forwarded-for": ip ?? freshIp(), ...(cookie ? { cookie } : {}), ...(driver ? { "x-driver-token": driver } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const rawOf = (link) => link.split("/d/")[1];
    const vcount = async () => (await c.query("select count(*)::int n from vehicles")).rows[0].n;
    const keyX = outbox().find((m) => m.to === "xss@acme.test").html.match(/ZT-[A-Za-z0-9_-]+/)[0];
    const mcX = cookieOf(await post("/api/auth/login", { email: "xss@acme.test", accessKey: keyX }));

    ok("POST /api/vehicles without session → 401", (await api("POST", "/api/vehicles", { body: { label: "T" } })).status === 401);
    ok("POST /api/vehicles as owner → 401", (await api("POST", "/api/vehicles", { cookie: oc, body: { label: "T" } })).status === 401);
    r = await api("POST", "/api/vehicles", { cookie: mcX, body: { label: "Sneaky" } }); let gj = await r.json();
    ok("UNVERIFIED company blocked server-side (403)", r.status === 403 && gj.status === "UNVERIFIED");
    r = await api("POST", "/api/vehicles", { cookie: mcB, body: { label: "Sneaky" } }); gj = await r.json();
    ok("PENDING company blocked server-side (403)", r.status === 403 && gj.status === "PENDING");
    ok("blocked requests created nothing", (await vcount()) === 0);

    r = await api("POST", "/api/vehicles", { cookie: mc, body: { label: "" } }); ok("empty label → 400", r.status === 400);
    r = await api("POST", "/api/vehicles", { cookie: mc, body: { label: "x".repeat(61) } }); ok("label over 60 chars → 400", r.status === 400);
    r = await api("POST", "/api/vehicles", { cookie: mc, body: { label: "Truck 01", plateNumber: "abc-123xy", driverName: "Musa" } });
    const created = await r.json();
    ok("approved company creates vehicle → 201 with one-time link", r.status === 201 && new RegExp(`^${BASE}/d/[A-Za-z0-9_-]{30,}$`).test(created.token.link));
    ok("plate number normalized to upper-case", created.vehicle.plateNumber === "ABC-123XY");
    const raw1 = rawOf(created.token.link), tok1 = created.token.id, veh1 = created.vehicle.id;
    const trow = (await c.query("select token_hash, status from driver_tokens where id=$1", [tok1])).rows[0];
    ok("only a 64-char hash is stored, never the raw token", trow.token_hash.length === 64 && trow.token_hash !== raw1 && trow.status === "ACTIVE");
    ok("raw token appears nowhere in the database", (await c.query("select count(*)::int n from driver_tokens where token_hash=$1", [raw1])).rows[0].n === 0);
    ok("vehicle_status row created (offline)", (await c.query("select online from vehicle_status where vehicle_id=$1", [veh1])).rows[0]?.online === false);
    ok("vehicle-added published on org fleet channel", rtEvents().some((e) => e.channel === `org:${orgId}:fleet` && e.event === "vehicle-added" && e.data.vehicleId === veh1));
    let lv = await (await api("GET", "/api/vehicles", { cookie: mc })).json();
    ok("list shows vehicle with active link metadata only", lv.vehicles.length === 1 && lv.vehicles[0].activeToken?.id === tok1 && !JSON.stringify(lv).includes(raw1) && !JSON.stringify(lv).includes("token_hash") && !JSON.stringify(lv).includes("tokenHash"));

    console.log("\nDriver session & pages");
    r = await api("POST", "/api/driver/session", { driver: raw1 }); let dj = await r.json();
    ok("valid driver token → 200 with vehicle + org", r.status === 200 && dj.vehicle.label === "Truck 01" && dj.org.name === "Acme Logistics" && dj.tokenId === tok1);
    ok("last_seen_at recorded", (await c.query("select last_seen_at from driver_tokens where id=$1", [tok1])).rows[0].last_seen_at !== null);
    ok("missing token header → 401", (await api("POST", "/api/driver/session", {})).status === 401);
    ok("malformed token → 401", (await api("POST", "/api/driver/session", { driver: "short" })).status === 401);
    ok("well-formed but unknown token → 401", (await api("POST", "/api/driver/session", { driver: "A".repeat(32) })).status === 401);
    ok("token in body/query is NOT accepted (header only)", (await api("POST", `/api/driver/session?token=${raw1}`, { body: { token: raw1 } })).status === 401);
    let html1 = await (await page("/d/" + raw1)).text();
    ok("driver page opens for a valid link", html1.includes('data-driver-state') ? !html1.includes('data-driver-state="locked"') : html1.includes("Loading"));
    ok("driver page: invalid link shows 'not valid'", (await (await page("/d/" + "B".repeat(32))).text()).includes('data-driver-state="locked"'));
    ok("driver page sets noindex + no-referrer", /noindex/.test(html1) && /name="referrer" content="no-referrer"/.test(html1));
    ok("driver page: multi-char junk path is safe", (await page("/d/<script>alert(1)</script>")).status < 500);

    console.log("\nDriver realtime token");
    r = await api("POST", "/api/driver/realtime-token", { driver: raw1 }); const dtok = await r.json();
    ok("driver token: subscribe-only on its own vehicle channel", r.status === 200 && JSON.stringify(JSON.parse(dtok.capability)) === JSON.stringify({ [`vehicle:${veh1}`]: ["subscribe"] }));
    ok("driver token is short-lived (10 min) and tied to the link", dtok.ttl === 600000 && dtok.clientId === `driver:${tok1}`);
    ok("driver realtime token without header → 401", (await api("POST", "/api/driver/realtime-token", {})).status === 401);

    console.log("\nRegenerate link");
    r = await api("POST", `/api/vehicles/${veh1}/token`, { cookie: mc }); const regen = await r.json();
    ok("new link → 201", r.status === 201 && regen.token.link !== created.token.link);
    const raw2 = rawOf(regen.token.link), tok2 = regen.token.id;
    r = await api("POST", "/api/driver/session", { driver: raw1 }); dj = await r.json();
    ok("old link now → 410 REVOKED", r.status === 410 && dj.code === "REVOKED");
    ok("new link → 200", (await api("POST", "/api/driver/session", { driver: raw2 })).status === 200);
    ok("exactly one ACTIVE link per vehicle", (await c.query("select count(*)::int n from driver_tokens where vehicle_id=$1 and status='ACTIVE'", [veh1])).rows[0].n === 1);
    ok("database refuses a second ACTIVE link for a vehicle", await c.query("insert into driver_tokens (vehicle_id, org_id, token_hash) values ($1,$2,$3)", [veh1, orgId, "f".repeat(64)]).then(() => false, (e) => e.code === "23505"));
    ok("token-revoked pushed to the vehicle channel with old tokenId", rtEvents().some((e) => e.channel === `vehicle:${veh1}` && e.event === "token-revoked" && e.data.tokenId === tok1));
    ok("old link's realtime token also refused (410)", (await api("POST", "/api/driver/realtime-token", { driver: raw1 })).status === 410);
    ok("driver page for old link shows revoked", (await (await page("/d/" + raw1)).text()).includes("Access revoked by your manager"));

    console.log("\nRevoke (✕)");
    ok("revoke without session → 401", (await api("DELETE", `/api/tokens/${tok2}`)).status === 401);
    ok("revoke with invalid id → 400", (await api("DELETE", "/api/tokens/nope", { cookie: mc })).status === 400);
    ok("revoke unknown id → 404", (await api("DELETE", "/api/tokens/00000000-0000-4000-8000-000000000000", { cookie: mc })).status === 404);
    r = await api("DELETE", `/api/tokens/${tok2}`, { cookie: mc }); ok("revoke → 200", r.status === 200);
    r = await api("POST", "/api/driver/session", { driver: raw2 }); ok("revoked link → 410 immediately", r.status === 410);
    ok("vehicle marked offline", (await c.query("select online from vehicle_status where vehicle_id=$1", [veh1])).rows[0].online === false);
    ok("revocation audit-logged", (await c.query("select count(*)::int n from audit_log where action='TOKEN_REVOKED' and target_id=$1", [tok2])).rows[0].n === 1);
    ok("token-revoked + vehicle-removed published", rtEvents().some((e) => e.channel === `vehicle:${veh1}` && e.event === "token-revoked" && e.data.tokenId === tok2) && rtEvents().some((e) => e.channel === `org:${orgId}:fleet` && e.event === "vehicle-removed" && e.data.vehicleId === veh1));
    ok("revoking twice → 409", (await api("DELETE", `/api/tokens/${tok2}`, { cookie: mc })).status === 409);
    lv = await (await api("GET", "/api/vehicles", { cookie: mc })).json();
    ok("list shows vehicle with no active link", lv.vehicles[0].activeToken === null);
    ok("regenerating after revoke works", (await api("POST", `/api/vehicles/${veh1}/token`, { cookie: mc })).status === 201);

    console.log("\nSuspension cuts off drivers & provisioning");
    const live = (await (await api("POST", `/api/vehicles/${veh1}/token`, { cookie: mc })).json()).token;
    const rawLive = rawOf(live.link);
    ok("link works while approved", (await api("POST", "/api/driver/session", { driver: rawLive })).status === 200);
    await patch(orgId, { action: "SUSPEND", note: "Suspending for lockout test" });
    r = await api("POST", "/api/driver/session", { driver: rawLive }); dj = await r.json();
    ok("suspended org: driver session → 403 ORG_DISABLED", r.status === 403 && dj.code === "ORG_DISABLED");
    ok("suspended org: driver realtime token → 403", (await api("POST", "/api/driver/realtime-token", { driver: rawLive })).status === 403);
    ok("suspended org: driver page shows disabled", (await (await page("/d/" + rawLive)).text()).includes("Tracking is currently disabled"));
    r = await api("POST", "/api/vehicles", { cookie: mc, body: { label: "While suspended" } }); gj = await r.json();
    ok("suspended org: cannot add vehicles (403)", r.status === 403 && gj.status === "SUSPENDED");
    ok("suspended org: cannot issue new links (403)", (await api("POST", `/api/vehicles/${veh1}/token`, { cookie: mc })).status === 403);
    await patch(orgId, { action: "APPROVE" });
    ok("reinstated org: same link works again", (await api("POST", "/api/driver/session", { driver: rawLive })).status === 200);

    console.log("\nTenant isolation");
    await patch(orgB, { action: "APPROVE" });
    r = await api("POST", "/api/vehicles", { cookie: mcB, body: { label: "Beta Van 1" } }); const bv = await r.json();
    ok("company B (approved) creates its own vehicle", r.status === 201);
    const rawB = rawOf(bv.token.link);
    ok("B cannot revoke A's link (404)", (await api("DELETE", `/api/tokens/${live.id}`, { cookie: mcB })).status === 404);
    ok("B cannot issue a link for A's vehicle (404)", (await api("POST", `/api/vehicles/${veh1}/token`, { cookie: mcB })).status === 404);
    ok("A's link still works after B's attempts", (await api("POST", "/api/driver/session", { driver: rawLive })).status === 200);
    const la = (await (await api("GET", "/api/vehicles", { cookie: mc })).json()).vehicles, lb = (await (await api("GET", "/api/vehicles", { cookie: mcB })).json()).vehicles;
    ok("each company lists only its own vehicles", la.every((v) => v.label !== "Beta Van 1") && lb.length === 1 && lb[0].label === "Beta Van 1");
    ok("B's driver token belongs to B's org, not A's", (await (await api("POST", "/api/driver/session", { driver: rawB })).json()).org.name === "Beta Freight");
    ok("owner stats count provisioned vehicles", (await (await ownerGet("/api/owner/stats")).json()).vehicles === (await vcount()));

    console.log("\nDriver endpoint abuse limits");
    const bf = "198.51.100.7"; codes = [];
    for (let i = 0; i < 32; i++) codes.push((await api("POST", "/api/driver/session", { driver: "Z".repeat(31) + String.fromCharCode(97 + (i % 26)), ip: bf })).status);
    ok("token guessing: 30 failures per IP, then 429", codes.slice(0, 30).every((x) => x === 401) && codes[30] === 429 && codes[31] === 429, codes.join(","));
    ok("a valid link still works from that throttled IP (shared carrier IPs)", (await api("POST", "/api/driver/session", { driver: rawB, ip: bf })).status === 200);
    const rl = (await (await api("POST", "/api/vehicles", { cookie: mc, body: { label: "RateLimit Van" } })).json()).token; const rawRL = rawOf(rl.link);
    codes = [];
    for (let i = 0; i < 62; i++) codes.push((await api("POST", "/api/driver/session", { driver: rawRL })).status);
    ok("per-token limit: 60/min then 429", codes.slice(0, 60).every((x) => x === 200) && codes[60] === 429, codes.slice(58).join(","));

    console.log("\nTelemetry ingest");
    const mk = await (await api("POST", "/api/vehicles", { cookie: mc, body: { label: "Telemetry Van" } })).json();
    const rawT = rawOf(mk.token.link), vidT = mk.vehicle.id;
    const mkB = await (await api("POST", "/api/vehicles", { cookie: mcB, body: { label: "Beta Telemetry" } })).json();
    const rawBT = rawOf(mkB.token.link), vidBT = mkB.vehicle.id;
    const T0 = Date.now(); let n = 0;
    const eid = () => `evt${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const ping = (o = {}) => ({ kind: "ping", clientEventId: eid(), ts: T0, lat: 6.335, lng: 5.6037, speedKmh: 50, accuracyM: 9, heading: 90, batteryPct: 80, charging: false, appState: "FOREGROUND", ...o });
    const inc = (o = {}) => ({ kind: "incident", clientEventId: eid(), ts: T0, type: "LOW_BATTERY", message: "Battery low (19%)", lat: 6.335, lng: 5.6037, ...o });
    const tpost = (ev, drv = rawT, extra = {}) => api("POST", "/api/telemetry", { driver: drv, body: ev, ...extra });
    const q1 = async (sql, p = []) => (await c.query(sql, p)).rows;
    const cntInc = async (type, v = vidT) => (await q1("select count(*)::int n from incidents where vehicle_id=$1 and type=$2", [v, type]))[0].n;

    ok("telemetry without link header → 401", (await api("POST", "/api/telemetry", { body: ping() })).status === 401);
    ok("telemetry with revoked link → 410, nothing stored", (await tpost(ping(), raw1)).status === 410 && (await q1("select count(*)::int n from telemetry where vehicle_id=$1", [veh1]))[0].n === 0);

    const first = ping({ ts: T0 });
    r = await tpost({ ...first, vehicleId: veh1, orgId: orgB, vehicle_id: veh1 }); let tj = await r.json();
    ok("valid ping → 200 accepted", r.status === 200 && tj.accepted === 1 && tj.duplicates === 0 && Math.abs(tj.now - Date.now()) < 5000);
    let trow2 = (await q1("select * from telemetry where client_event_id=$1", [`${vidT}:${first.clientEventId}`]))[0];
    ok("ping stored with speed, battery, charging, app state", trow2 && trow2.speed_kmh === 50 && trow2.battery_pct === 80 && trow2.charging === false && trow2.app_state === "FOREGROUND" && trow2.accuracy_m === 9 && trow2.heading === 90);
    ok("identity comes from the link; vehicleId/orgId in the body are ignored", trow2.vehicle_id === vidT && trow2.org_id === orgId);
    ok("stored event id is namespaced by vehicle", trow2.client_event_id === `${vidT}:${first.clientEventId}`);

    r = await tpost(first); tj = await r.json();
    ok("replaying the same event → duplicates:1, no new row", r.status === 200 && tj.accepted === 0 && tj.duplicates === 1 && (await q1("select count(*)::int n from telemetry where client_event_id=$1", [`${vidT}:${first.clientEventId}`]))[0].n === 1);
    r = await tpost(first, rawBT);
    ok("another company reusing the same event id is NOT suppressed", (await r.json()).accepted === 1 && (await q1("select count(*)::int n from telemetry where client_event_id like $1", [`%:${first.clientEventId}`]))[0].n === 2);

    let vs = (await q1("select * from vehicle_status where vehicle_id=$1", [vidT]))[0];
    ok("vehicle_status holds the live position", vs.last_lat === 6.335 && vs.last_lng === 5.6037 && vs.last_speed_kmh === 50 && vs.last_battery_pct === 80 && vs.online === true && vs.app_state === "FOREGROUND");
    ok("exactly one CONNECTED incident on first contact", (await cntInc("CONNECTED")) === 1);
    ok("first ping sampled into the audit log (GPS_PING)", (await cntInc("GPS_PING")) === 1);
    await tpost(ping({ ts: T0 + 10_000, lat: 6.336 }));
    ok("ping 10s later: no extra CONNECTED, GPS_PING still sampled to 1/min", (await cntInc("CONNECTED")) === 1 && (await cntInc("GPS_PING")) === 1);
    await tpost(ping({ ts: T0 + 61_000, lat: 6.34, speedKmh: 72.4 }));
    ok("ping 61s later: second GPS_PING entry", (await cntInc("GPS_PING")) === 2);
    ok("GPS_PING message carries the speed", (await q1("select message from incidents where vehicle_id=$1 and type='GPS_PING' order by ts desc limit 1", [vidT]))[0].message === "72 km/h");

    r = await tpost(ping({ ts: T0 - 30_000, lat: 1.0, lng: 1.0 }));
    vs = (await q1("select * from vehicle_status where vehicle_id=$1", [vidT]))[0];
    ok("older (out-of-order) ping is stored but does NOT move the live position back", (await r.json()).accepted === 1 && vs.last_lat === 6.34 && vs.last_speed_kmh === 72.4);

    console.log("\nTelemetry validation");
    const bad = [
      ["latitude 91", ping({ lat: 91 })], ["longitude -181", ping({ lng: -181 })], ["negative speed", ping({ speedKmh: -1 })], ["speed 500 km/h", ping({ speedKmh: 500 })],
      ["battery 101%", ping({ batteryPct: 101 })], ["fractional battery", ping({ batteryPct: 50.5 })], ["unknown app state", ping({ appState: "SLEEPING" })],
      ["missing latitude", (() => { const p = ping(); delete p.lat; return p; })()], ["non-numeric latitude", ping({ lat: "6.3" })],
      ["short event id", ping({ clientEventId: "abc" })], ["event id with spaces/symbols", ping({ clientEventId: "bad id!!bad id!!" })],
      ["unknown kind", { ...ping(), kind: "teleport" }], ["client-sent DISCONNECTED", inc({ type: "DISCONNECTED" })], ["client-sent CONNECTED", inc({ type: "CONNECTED" })],
      ["client-sent GPS_PING", inc({ type: "GPS_PING" })], ["g-force 101", inc({ type: "IMPACT", gForce: 101 })], ["message over 200 chars", inc({ message: "x".repeat(201) })],
    ];
    for (const [label, ev] of bad) { r = await tpost(ev); ok(`rejects ${label} (400)`, r.status === 400, String(r.status)); }
    r = await tpost(ping({ ts: Date.now() + 10 * 60 * 1000 })); ok("timestamp 10 min in the future → 400 BAD_TIMESTAMP", r.status === 400 && (await r.json()).code === "BAD_TIMESTAMP");
    ok("timestamp 9 days old → 400", (await tpost(ping({ ts: Date.now() - 9 * 24 * 3600 * 1000 }))).status === 400);
    r = await fetch(BASE + "/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-driver-token": rawT, "x-forwarded-for": freshIp() }, body: "{not json" }); ok("malformed JSON → 400", r.status === 400);
    r = await fetch(BASE + "/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-driver-token": rawT, "x-forwarded-for": freshIp() }, body: JSON.stringify({ ...ping(), junk: "x".repeat(21000) }) }); ok("oversized payload → 413", r.status === 413);
    ok("none of the invalid events were stored", (await q1("select count(*)::int n from telemetry where vehicle_id=$1", [vidT]))[0].n === 4);

    console.log("\nIncidents & app state");
    r = await tpost(inc({ type: "IMPACT", gForce: 4.2, ts: T0 + 70_000, message: "Severe impact" })); ok("IMPACT incident with g-force accepted", (await r.json()).accepted === 1);
    ok("incident stored with g-force and position", (await q1("select g_force, lat from incidents where vehicle_id=$1 and type='IMPACT'", [vidT]))[0]?.g_force === 4.2);
    await tpost(inc({ type: "BACKGROUNDED", ts: T0 + 80_000, message: "Driver switched away from the app" }));
    ok("BACKGROUNDED incident flips live app state", (await q1("select app_state from vehicle_status where vehicle_id=$1", [vidT]))[0].app_state === "BACKGROUNDED");
    await tpost(inc({ type: "FOREGROUNDED", ts: T0 + 90_000, message: "Driver returned" }));
    ok("FOREGROUNDED incident restores it", (await q1("select app_state from vehicle_status where vehicle_id=$1", [vidT]))[0].app_state === "FOREGROUND");
    await tpost(inc({ type: "BACKGROUNDED", ts: T0 + 100_000 }));
    await tpost(ping({ ts: T0 + 110_000, appState: "FOREGROUND" }));
    ok("a newer FOREGROUND ping overrides an older BACKGROUNDED incident", (await q1("select app_state from vehicle_status where vehicle_id=$1", [vidT]))[0].app_state === "FOREGROUND");
    await tpost(ping({ ts: T0 + 120_000, appState: "BACKGROUNDED", batteryPct: 19, charging: true }));
    vs = (await q1("select * from vehicle_status where vehicle_id=$1", [vidT]))[0];
    ok("BACKGROUNDED ping + battery stored on the live status", vs.app_state === "BACKGROUNDED" && vs.last_battery_pct === 19);

    console.log("\nDisconnect / reconnect log");
    await c.query("update vehicle_status set last_seen_at = now() - interval '5 minutes', online = true where vehicle_id=$1", [vidT]);
    const dBefore = await cntInc("DISCONNECTED"), cBefore = await cntInc("CONNECTED");
    await tpost(ping({ ts: T0 + 130_000 }));
    ok("a silent gap is logged as DISCONNECTED then CONNECTED", (await cntInc("DISCONNECTED")) === dBefore + 1 && (await cntInc("CONNECTED")) === cBefore + 1);

    console.log("\nTelemetry realtime events");
    const fe = rtEvents().filter((e) => e.channel === `org:${orgId}:fleet`);
    const pos = fe.find((e) => e.event === "position" && e.data.vehicleId === vidT && e.data.lat === 6.34);
    ok("position event published to the company's fleet channel", !!pos && pos.data.label === "Telemetry Van" && pos.data.speedKmh === 72.4 && pos.data.batteryPct === 80);
    ok("incident events published (CONNECTED, IMPACT, BACKGROUNDED)", ["CONNECTED", "IMPACT", "BACKGROUNDED"].every((t) => fe.some((e) => e.event === "incident" && e.data.type === t && e.data.vehicleId === vidT)));
    ok("vehicle-status event published on connect", fe.some((e) => e.event === "vehicle-status" && e.data.vehicleId === vidT && e.data.online === true));
    ok("company B's data never goes to A's channel", !rtEvents().some((e) => e.channel === `org:${orgId}:fleet` && e.data?.vehicleId === vidBT) && rtEvents().some((e) => e.channel === `org:${orgB}:fleet` && e.data?.vehicleId === vidBT));
    ok("B's live status is B's own", (await q1("select last_lat from vehicle_status where vehicle_id=$1", [vidBT]))[0].last_lat === 6.335);

    console.log("\nTelemetry stops when access ends");
    const storedBefore = (await q1("select count(*)::int n from telemetry where vehicle_id=$1", [vidT]))[0].n;
    await api("DELETE", `/api/tokens/${mk.token.id}`, { cookie: mc });
    ok("revoked link can't send telemetry (410)", (await tpost(ping({ ts: T0 + 140_000 }))).status === 410);
    ok("nothing stored after revocation", (await q1("select count(*)::int n from telemetry where vehicle_id=$1", [vidT]))[0].n === storedBefore);

    console.log("\nBatch sync (/api/telemetry/batch)");
    const newVeh = async (cookie, label) => { const j = await (await api("POST", "/api/vehicles", { cookie, body: { label } })).json(); return { raw: rawOf(j.token.link), vid: j.vehicle.id, tid: j.token.id }; };
    const bpost = (events, drv, extra = {}) => api("POST", "/api/telemetry/batch", { driver: drv, body: { events }, ...extra });
    const tcount = async (v) => (await q1("select count(*)::int n from telemetry where vehicle_id=$1", [v]))[0].n;
    const B0 = Date.now() - 120_000;
    const bx = await newVeh(mc, "Batch Van");

    ok("batch without link header → 401", (await api("POST", "/api/telemetry/batch", { body: { events: [ping()] } })).status === 401);
    ok("batch with revoked link → 410", (await bpost([ping()], raw1)).status === 410);
    for (const [label, body] of [["{}", {}], ["empty events", { events: [] }], ["events not an array", { events: "x" }], ["bare array (no wrapper)", [ping()]]]) {
      r = await api("POST", "/api/telemetry/batch", { driver: bx.raw, body }); ok(`batch rejects ${label} (400)`, r.status === 400, String(r.status));
    }
    r = await fetch(BASE + "/api/telemetry/batch", { method: "POST", headers: { "content-type": "application/json", "x-driver-token": bx.raw, "x-forwarded-for": freshIp() }, body: "{oops" }); ok("batch malformed JSON → 400", r.status === 400);
    r = await bpost(Array.from({ length: 201 }, (_, i) => ping({ ts: B0 + i })), bx.raw); ok("batch with 201 events → 413 (limit is 200)", r.status === 413);
    ok("nothing stored by rejected batches", (await tcount(bx.vid)) === 0);

    const big = Array.from({ length: 200 }, (_, i) => ping({ ts: B0 + i * 500, lat: 6.3 + i * 0.0001, speedKmh: 40 }));
    const t0 = Date.now(); r = await bpost(big, bx.raw); let bres = await r.json();
    ok("200-event batch → all accepted", r.status === 200 && bres.accepted === 200 && bres.duplicates === 0 && bres.rejected === 0 && Math.abs(bres.now - Date.now()) < 5000, JSON.stringify(bres));
    ok(`200 events stored in one request (${Date.now() - t0} ms)`, (await tcount(bx.vid)) === 200 && Date.now() - t0 < 4000);
    ok("live position = newest event of the batch", (await q1("select last_lat from vehicle_status where vehicle_id=$1", [bx.vid]))[0].last_lat === 6.3 + 199 * 0.0001);
    const posBefore = rtEvents().filter((e) => e.event === "position" && e.data.vehicleId === bx.vid).length;
    r = await bpost(big, bx.raw); bres = await r.json();
    ok("replaying the identical batch → 0 accepted, 200 duplicates, no new rows", bres.accepted === 0 && bres.duplicates === 200 && (await tcount(bx.vid)) === 200);
    ok("a replay publishes no new position", rtEvents().filter((e) => e.event === "position" && e.data.vehicleId === bx.vid).length === posBefore);
    ok("one position event for the whole backlog (not 200)", posBefore === 1, String(posBefore));

    const bx2 = await newVeh(mc, "Reverse Van");
    const asc = Array.from({ length: 30 }, (_, i) => ping({ ts: B0 + i * 1000, lat: 7 + i * 0.01, speedKmh: i }));
    r = await bpost([...asc].reverse(), bx2.raw);
    vs = (await q1("select * from vehicle_status where vehicle_id=$1", [bx2.vid]))[0];
    ok("events delivered newest-first still end at the newest position", (await r.json()).accepted === 30 && Math.abs(vs.last_lat - (7 + 29 * 0.01)) < 1e-9 && vs.last_speed_kmh === 29);
    r = await bpost([ping({ ts: B0 - 60_000, lat: 1, lng: 1 })], bx2.raw);
    ok("a later batch of OLDER data never moves the live position back", (await r.json()).accepted === 1 && (await q1("select last_lat from vehicle_status where vehicle_id=$1", [bx2.vid]))[0].last_lat > 7);

    const bx3 = await newVeh(mc, "Mixed Van");
    const good1 = ping({ ts: B0 }), good2 = ping({ ts: B0 + 1000 }), good3 = inc({ type: "IMPACT", gForce: 4.4, ts: B0 + 2000, message: "Pothole / road shock: 4.4 G" });
    const badLat = ping({ lat: 91, ts: B0 }), badOld = ping({ ts: Date.now() - 9 * 24 * 3600 * 1000 }), badType = inc({ type: "DISCONNECTED", ts: B0 });
    r = await bpost([good1, badLat, good2, badOld, good3, badType], bx3.raw); bres = await r.json();
    ok("mixed batch: valid events accepted, bad ones rejected individually", r.status === 200 && bres.accepted === 3 && bres.rejected === 3, JSON.stringify(bres));
    ok("rejected ids are reported so the phone stops retrying them", [badLat, badOld, badType].every((e) => bres.rejectedIds.includes(e.clientEventId)));
    ok("good events were stored (2 pings + IMPACT with g-force)", (await tcount(bx3.vid)) === 2 && (await q1("select g_force from incidents where vehicle_id=$1 and type='IMPACT'", [bx3.vid]))[0]?.g_force === 4.4);
    r = await bpost([good1, good1], bx3.raw); bres = await r.json();
    ok("same id twice in one request counts once", bres.accepted === 0 && bres.duplicates === 2);
    const dup = ping({ ts: B0 + 5000 }); r = await bpost([dup, dup], (await newVeh(mc, "Twice Van")).raw); bres = await r.json();
    ok("fresh event repeated inside one request → 1 accepted, 1 duplicate", bres.accepted === 1 && bres.duplicates === 1, JSON.stringify(bres));

    const bx4 = await newVeh(mc, "Trail Van");
    const trail = Array.from({ length: 14 }, (_, i) => ping({ ts: B0 + i * 10_000, lat: 6.5 + i * 0.001 }));
    await bpost(trail, bx4.raw);
    const trailLog = await q1("select ts from incidents where vehicle_id=$1 and type='GPS_PING' order by ts", [bx4.vid]);
    ok("an offline backlog logs a GPS trail: one entry per minute across the batch", trailLog.length === 3 && [0, 60_000, 120_000].every((d, i) => Math.abs(new Date(trailLog[i].ts).getTime() - (B0 + d)) < 1000), String(trailLog.length));
    ok("one CONNECTED for the whole backlog", (await cntInc("CONNECTED", bx4.vid)) === 1);

    const bx5 = await newVeh(mc, "Gap Van");
    await bpost([ping({ ts: B0 })], bx5.raw);
    await c.query("update vehicle_status set last_seen_at = now() - interval '5 minutes', online = true where vehicle_id=$1", [bx5.vid]);
    await bpost([ping({ ts: B0 + 2000 })], bx5.raw);
    ok("backlog arriving after a long silence logs DISCONNECTED then CONNECTED", (await cntInc("DISCONNECTED", bx5.vid)) === 1 && (await cntInc("CONNECTED", bx5.vid)) === 2);

    const shared = ping({ ts: B0 }); const bB = await newVeh(mcB, "Beta Batch");
    await bpost([shared], bx5.raw); r = await bpost([shared], bB.raw);
    ok("batch from another company reusing the same event id is stored, not suppressed", (await r.json()).accepted === 1 && (await tcount(bB.vid)) === 1);
    ok("each company's batch data stays on its own vehicle/org", (await q1("select count(*)::int n from telemetry where vehicle_id=$1 and org_id=$2", [bB.vid, orgB]))[0].n === 1);

    const bx6 = await newVeh(mc, "Revoke Batch Van");
    await bpost([ping({ ts: B0 })], bx6.raw);
    await api("DELETE", `/api/tokens/${bx6.tid}`, { cookie: mc });
    ok("batch after revocation → 410 and nothing stored", (await bpost([ping({ ts: B0 + 5000 })], bx6.raw)).status === 410 && (await tcount(bx6.vid)) === 1);

    console.log("\nFleet live API");
    const NOW0 = Date.now();
    const lget = (path, cookie) => api("GET", path, { cookie });
    ok("live fleet without session → 401", (await lget("/api/fleet/live")).status === 401);
    ok("live fleet as owner → 401", (await lget("/api/fleet/live", oc)).status === 401);
    ok("live fleet for an unapproved company → 403", (await lget("/api/fleet/live", mcX)).status === 403);
    const LV = {};
    for (const name of ["L-Moving", "L-Idle", "L-Bg", "L-Off", "L-Wait", "L-Revoked"]) LV[name] = await newVeh(mc, name);
    const lbeta = await newVeh(mcB, "L-Beta");
    await tpost(ping({ ts: NOW0, speedKmh: 40, batteryPct: 76, lat: 6.31, lng: 5.61 }), LV["L-Moving"].raw);
    await tpost(ping({ ts: NOW0, speedKmh: 0, lat: 6.32, lng: 5.62 }), LV["L-Idle"].raw);
    await tpost(ping({ ts: NOW0, speedKmh: 20, appState: "BACKGROUNDED", lat: 6.33, lng: 5.63 }), LV["L-Bg"].raw);
    await tpost(ping({ ts: NOW0, speedKmh: 15, lat: 6.34, lng: 5.64 }), LV["L-Off"].raw);
    await tpost(ping({ ts: NOW0, lat: 6.35, lng: 5.65 }), LV["L-Revoked"].raw);
    await api("DELETE", `/api/tokens/${LV["L-Revoked"].tid}`, { cookie: mc });
    await tpost(ping({ ts: NOW0, lat: 6.4, lng: 5.7 }), lbeta.raw);
    await c.query("update vehicle_status set last_seen_at = now() - interval '5 minutes', online = true where vehicle_id=$1", [LV["L-Off"].vid]);

    r = await lget("/api/fleet/live", mc); const ljF = await r.json();
    const byLabel = Object.fromEntries(ljF.vehicles.filter((v) => v.label.startsWith("L-")).map((v) => [v.label, v]));
    ok("live fleet → 200, no-store, with server time", r.status === 200 && r.headers.get("cache-control") === "no-store" && Math.abs(ljF.now - Date.now()) < 5000);
    ok("statuses computed: moving / idle / backgrounded / offline / waiting", byLabel["L-Moving"]?.status === "moving" && byLabel["L-Idle"]?.status === "idle" && byLabel["L-Bg"]?.status === "backgrounded" && byLabel["L-Off"]?.status === "offline" && byLabel["L-Wait"]?.status === "waiting", JSON.stringify(Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, v.status]))));
    ok("live position, speed and battery returned", byLabel["L-Moving"].lat === 6.31 && byLabel["L-Moving"].lng === 5.61 && byLabel["L-Moving"].speedKmh === 40 && byLabel["L-Moving"].batteryPct === 76 && typeof byLabel["L-Moving"].lastSeenAt === "number");
    ok("a revoked link's vehicle is removed from the live map", !byLabel["L-Revoked"] && (await q1("select 1 from vehicles where id=$1", [LV["L-Revoked"].vid])).length === 1);
    ok("a vehicle with no position yet is 'waiting' with null coordinates", byLabel["L-Wait"].lat === null && byLabel["L-Wait"].lng === null);
    ok("silent for 5 min: marked offline in the database by the read-time sweep", (await q1("select online from vehicle_status where vehicle_id=$1", [LV["L-Off"].vid]))[0].online === false);
    ok("exactly one DISCONNECTED incident logged", (await cntInc("DISCONNECTED", LV["L-Off"].vid)) === 1);
    await lget("/api/fleet/live", mc); await lget("/api/fleet/live", mc);
    ok("repeated reads never log it again", (await cntInc("DISCONNECTED", LV["L-Off"].vid)) === 1);
    ok("DISCONNECTED timestamp = last contact + 60 s", Math.abs(new Date((await q1("select ts from incidents where vehicle_id=$1 and type='DISCONNECTED'", [LV["L-Off"].vid]))[0].ts).getTime() - (Date.now() - 5 * 60 * 1000 + 60 * 1000)) < 15_000);
    ok("sweep publishes DISCONNECTED + offline status to the fleet channel", rtEvents().some((e) => e.channel === `org:${orgId}:fleet` && e.event === "incident" && e.data.type === "DISCONNECTED" && e.data.vehicleId === LV["L-Off"].vid) && rtEvents().some((e) => e.channel === `org:${orgId}:fleet` && e.event === "vehicle-status" && e.data.vehicleId === LV["L-Off"].vid && e.data.online === false));
    await tpost(ping({ ts: Date.now(), lat: 6.34, lng: 5.64 }), LV["L-Off"].raw);
    ok("the vehicle returning logs a second CONNECTED and shows live again", (await cntInc("CONNECTED", LV["L-Off"].vid)) === 2 && (await (await lget("/api/fleet/live", mc)).json()).vehicles.find((v) => v.label === "L-Off").status === "moving");
    const lbF = await (await lget("/api/fleet/live", mcB)).json();
    ok("company B sees only its own vehicles", lbF.vehicles.length >= 1 && lbF.vehicles.every((v) => !v.label.startsWith("L-") || v.label === "L-Beta") && lbF.vehicles.some((v) => v.label === "L-Beta"));
    ok("company A never sees B's vehicle", !ljF.vehicles.some((v) => v.label === "L-Beta") && !JSON.stringify(ljF).includes(lbeta.vid));
    ok("live fleet exposes no token hashes or secrets", !/token|hash|password/i.test(JSON.stringify(ljF)));

    console.log("\nRoute history API");
    const hv = await newVeh(mc, "H-Route"), hv2 = await newVeh(mc, "H-Other");
    const base = Date.now() - 30 * 60_000;
    const line = Array.from({ length: 40 }, (_, i) => ping({ ts: base + i * 30_000, lat: 6.3 + i * 0.001, lng: 5.6, speedKmh: 30 + i, appState: "FOREGROUND" }));
    await bpost(line, hv.raw);
    await bpost([ping({ ts: base, lat: 9, lng: 9, speedKmh: 99 })], hv2.raw);
    await bpost([
      inc({ type: "IMPACT", gForce: 4.8, ts: Date.now() - 20 * 60_000, lat: 6.31, lng: 5.6, message: "Severe impact" }),
      inc({ type: "POTHOLE", gForce: 3.9, ts: Date.now() - 10 * 60_000, lat: 6.32, lng: 5.6 }),
      inc({ type: "IMPACT", gForce: 7.1, ts: Date.now() - 2 * 3600_000, lat: 6.33, lng: 5.6 }),
      inc({ type: "LOW_BATTERY", ts: Date.now() - 15 * 60_000, lat: 6.3, lng: 5.6 }),
      inc({ type: "IMPACT", gForce: 5.5, ts: Date.now() - 5 * 60_000, lat: null, lng: null }),
    ], hv.raw);
    const hist = (id, qs = "", cookie = mc) => lget(`/api/vehicles/${id}/history${qs}`, cookie);
    const hr = (a, b) => `?from=${Date.now() - a}&to=${Date.now() - b}`;
    ok("history without session → 401", (await hist(hv.vid, "", null)).status === 401);
    ok("history with invalid vehicle id → 400", (await hist("nope")).status === 400);
    ok("another company's vehicle → 404 (existence not revealed)", (await hist(hv.vid, "", mcB)).status === 404);
    ok("unknown vehicle → 404", (await hist("00000000-0000-4000-8000-000000000000")).status === 404);
    ok("history for an unapproved company → 403", (await hist(hv.vid, "", mcX)).status === 403);
    ok("bad date → 400", (await hist(hv.vid, "?from=banana")).status === 400);
    ok("from after to → 400", (await hist(hv.vid, `?from=${Date.now()}&to=${Date.now() - 1000}`)).status === 400);
    ok("range over 31 days → 400", (await hist(hv.vid, `?from=${Date.now() - 32 * 86400_000}&to=${Date.now()}`)).status === 400);
    r = await hist(hv.vid, hr(3600_000, 0)); let hj = await r.json();
    ok("route: all 40 positions, oldest first", r.status === 200 && hj.points.length === 40 && hj.points.every((p, i) => i === 0 || p.t > hj.points[i - 1].t) && hj.points[0].lat === 6.3 && hj.points[39].lat === 6.3 + 39 * 0.001, JSON.stringify(hj.summary));
    ok("route excludes other vehicles' data", hj.points.every((p) => p.lat < 7));
    ok("summary: distance ≈ 4.34 km, duration 19.5 min, max 69 km/h", Math.abs(hj.summary.distanceKm - 4.34) < 0.05 && hj.summary.durationMs === 39 * 30_000 && hj.summary.maxSpeedKmh === 69 && hj.summary.pointCount === 40 && hj.sampled === false);
    ok("impacts in range with position: IMPACT + POTHOLE (not the old one, the no-GPS one, or battery)", hj.impacts.length === 2 && hj.summary.impactCount === 2 && hj.impacts.every((i) => i.lat != null && ["IMPACT", "POTHOLE"].includes(i.type)) && hj.impacts.some((i) => i.gForce === 4.8));
    hj = await (await hist(hv.vid, `?from=${base + 20 * 30_000}&to=${Date.now()}`)).json();
    ok("narrower range returns only positions inside it (points 20–39 = 20)", hj.points.length === 20 && hj.points[0].lat === 6.3 + 20 * 0.001);
    ok("ISO dates are accepted too", (await (await hist(hv.vid, `?from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`)).json()).points.length === 40);
    hj = await (await hist(hv.vid, hr(3 * 3600_000, 1.5 * 3600_000))).json();
    ok("empty range → no points, zero summary", hj.points.length === 0 && hj.summary.pointCount === 0 && hj.summary.distanceKm === 0 && hj.summary.maxSpeedKmh === null);
    ok("…but the old impact falls inside that range", hj.impacts.length === 1 && hj.impacts[0].gForce === 7.1);
    hj = await (await hist(hv.vid)).json();
    ok("default range is the last 24 hours", hj.points.length === 40 && Math.abs(hj.to - Date.now()) < 5000 && Math.abs((hj.to - hj.from) - 86400_000) < 5000);

    const bigV = await newVeh(mc, "H-Big");
    await c.query(`insert into telemetry (vehicle_id, org_id, ts, lat, lng, speed_kmh, app_state, client_event_id)
      select $1::uuid, $2::uuid, now() - (g * interval '10 seconds'), 6.3 + g * 0.00001, 5.6, 30, 'FOREGROUND', $1 || ':big' || g from generate_series(1, 5000) g`, [bigV.vid, orgId]);
    const tb = Date.now(); r = await hist(bigV.vid); hj = await r.json();
    ok(`5,000 positions → drawn from a ≤2,000-point sample (${Date.now() - tb} ms)`, r.status === 200 && hj.points.length <= 2000 && hj.points.length > 1500 && hj.sampled === true && hj.totalPoints === 5000 && hj.summary.pointCount === 5000 && Date.now() - tb < 3000);
    const times = (await q1("select min(ts) mn, max(ts) mx from telemetry where vehicle_id=$1", [bigV.vid]))[0];
    ok("sample keeps the true first and last positions, in order", hj.points[0].t === new Date(times.mn).getTime() && hj.points[hj.points.length - 1].t === new Date(times.mx).getTime() && hj.points.every((p, i) => i === 0 || p.t >= hj.points[i - 1].t));
    ok("distance is computed from ALL positions, not the sample (≈5.56 km)", Math.abs(hj.summary.distanceKm - 4999 * 0.00001 * 111.19) < 0.1, String(hj.summary.distanceKm));
    const hugeV = await newVeh(mc, "H-Huge");
    await c.query(`insert into telemetry (vehicle_id, org_id, ts, lat, lng, speed_kmh, app_state, client_event_id)
      select $1::uuid, $2::uuid, now() - (g * interval '1 second'), 6.3 + g * 0.000001, 5.6, 30, 'FOREGROUND', $1 || ':huge' || g from generate_series(1, 25000) g`, [hugeV.vid, orgId]);
    hj = await (await hist(hugeV.vid)).json();
    ok("25,000 positions: thinned in SQL, still ≤2,000 drawn, true count reported", hj.points.length <= 2000 && hj.totalPoints === 25000 && hj.sampled === true);
    ok("thinned route still spans the whole period (first/last kept)", Math.abs(hj.points[0].t - (Date.now() - 25000_000)) < 5000 && Math.abs(hj.points[hj.points.length - 1].t - (Date.now() - 1000)) < 5000);

    console.log("\nIncident feed API");
    const ig = (qs = "", cookie = mc) => lget(`/api/incidents${qs}`, cookie);
    ok("feed without session → 401", (await ig("", null)).status === 401);
    ok("feed as owner → 401", (await ig("", oc)).status === 401);
    ok("feed for an unapproved company → 403", (await ig("", mcX)).status === 403);
    ok("unknown incident type → 400", (await ig("?type=NUKE")).status === 400);
    ok("invalid vehicleId → 400", (await ig("?vehicleId=nope")).status === 400);
    ok("non-numeric since → 400", (await ig("?since=yesterday")).status === 400);
    ok("malformed cursor → 400", (await ig("?before=abc")).status === 400);
    const fv = await newVeh(mc, "F-Feed");
    await c.query(`insert into incidents (vehicle_id, org_id, type, message, ts) select $1::uuid, $2::uuid, 'GPS_PING', 'ping ' || g, now() - (g * interval '1 minute') from generate_series(1, 260) g`, [fv.vid, orgId]);
    r = await ig(`?vehicleId=${fv.vid}`); let fjF = await r.json();
    ok("default page = 50, newest first, with a next cursor", r.status === 200 && fjF.incidents.length === 50 && fjF.nextCursor !== null && fjF.incidents.every((x, i) => i === 0 || x.ts <= fjF.incidents[i - 1].ts));
    ok("each item carries the vehicle's label", fjF.incidents.every((x) => x.label === "F-Feed"));
    ok("limit is capped at 200", (await (await ig(`?vehicleId=${fv.vid}&limit=500`)).json()).incidents.length === 200);
    const seen = []; let cur = null, pages = 0;
    do { fjF = await (await ig(`?vehicleId=${fv.vid}&limit=100${cur ? `&before=${cur}` : ""}`)).json(); seen.push(...fjF.incidents); cur = fjF.nextCursor; pages++; } while (cur && pages < 10);
    ok("pagination walks all 260 events in 3 pages, none missing or repeated", pages === 3 && seen.length === 260 && new Set(seen.map((x) => x.id)).size === 260);
    ok("pages are strictly newest → oldest", seen.every((x, i) => i === 0 || x.ts < seen[i - 1].ts || (x.ts === seen[i - 1].ts && x.id < seen[i - 1].id)));
    ok("last page has no cursor", cur === null);
    const tieV = await newVeh(mc, "F-Ties");
    await c.query(`insert into incidents (vehicle_id, org_id, type, message, ts) select $1::uuid, $2::uuid, 'GPS_PING', 'tie ' || g, '2026-01-01T00:00:00Z' from generate_series(1, 5) g`, [tieV.vid, orgId]);
    const tseen = []; cur = null;
    do { fjF = await (await ig(`?vehicleId=${tieV.vid}&limit=2${cur ? `&before=${cur}` : ""}`)).json(); tseen.push(...fjF.incidents); cur = fjF.nextCursor; } while (cur);
    ok("events with the SAME timestamp paginate without loss or duplicates", tseen.length === 5 && new Set(tseen.map((x) => x.id)).size === 5);
    fjF = await (await ig(`?vehicleId=${fv.vid}&type=impact,pothole`)).json(); ok("type filter (case-insensitive) with no matches → empty", fjF.incidents.length === 0);
    fjF = await (await ig(`?vehicleId=${hv.vid}&type=impact,pothole`)).json();
    ok("type filter IMPACT,POTHOLE returns only those", fjF.incidents.length >= 3 && fjF.incidents.every((x) => ["IMPACT", "POTHOLE"].includes(x.type)));
    fjF = await (await ig(`?vehicleId=${hv.vid}&type=LOW_BATTERY`)).json(); ok("single-type filter", fjF.incidents.length === 1 && fjF.incidents[0].type === "LOW_BATTERY");
    fjF = await (await ig(`?vehicleId=${fv.vid}&since=${Date.now() - 10 * 60_000}&limit=200`)).json(); ok("since filter keeps only recent events (last 10 min = 9–10)", fjF.incidents.length >= 9 && fjF.incidents.length <= 10);
    const all = await (await ig("?limit=200")).json();
    const mine = new Set((await q1("select id from vehicles where org_id=$1", [orgId])).map((x) => x.id));
    ok("feed contains only this company's vehicles", all.incidents.length > 0 && all.incidents.every((x) => mine.has(x.vehicleId)));
    fjF = await (await ig(`?vehicleId=${lbeta.vid}`)).json(); ok("asking for another company's vehicle returns nothing (no leak)", fjF.incidents.length === 0 && fjF.nextCursor === null);
    const bfeed = await (await ig("?limit=200", mcB)).json();
    ok("company B's feed has B's events and none of A's", bfeed.incidents.some((x) => x.vehicleId === lbeta.vid) && bfeed.incidents.every((x) => !mine.has(x.vehicleId)));
    for (const t of ["GPS_PING", "CONNECTED", "DISCONNECTED", "IMPACT", "POTHOLE", "LOW_BATTERY", "BACKGROUNDED"]) {
      const one = await (await ig(`?type=${t}&limit=1`)).json();
      ok(`unified feed includes ${t} events`, one.incidents.length === 1 && one.incidents[0].type === t, t);
    }

    console.log("\nScheduled jobs (cron)");
    const CRON = "cron-secret-for-tests-1234567890";
    const cronGet = (path, authz) => fetch(BASE + path, { headers: authz === null ? {} : { authorization: authz ?? `Bearer ${CRON}`, "x-forwarded-for": freshIp() } });
    for (const path of ["/api/cron/cleanup", "/api/cron/sweep"]) {
      ok(`${path}: no credentials → 401`, (await cronGet(path, null)).status === 401);
      ok(`${path}: wrong secret → 401`, (await cronGet(path, "Bearer nope-nope-nope-nope-nope")).status === 401);
      ok(`${path}: secret without 'Bearer' → 401`, (await cronGet(path, CRON)).status === 401);
      ok(`${path}: manager or owner session is not enough → 401`, (await fetch(BASE + path, { headers: { cookie: oc } })).status === 401 && (await fetch(BASE + path, { headers: { cookie: mc } })).status === 401);
      ok(`${path}: secret in the query string is ignored → 401`, (await fetch(`${BASE}${path}?secret=${CRON}`)).status === 401);
    }
    const rt0 = await newVeh(mc, "R-Ret");
    const insT = (days, n, tag) => c.query(`insert into telemetry (vehicle_id, org_id, ts, lat, lng, app_state, client_event_id) select $1::uuid, $2::uuid, now() - ($3 * interval '1 day') - (g * interval '1 second'), 6.3, 5.6, 'FOREGROUND', $1 || ':${tag}' || g from generate_series(1, $4) g`, [rt0.vid, orgId, days, n]);
    const insI = (days, n) => c.query(`insert into incidents (vehicle_id, org_id, type, message, ts) select $1::uuid, $2::uuid, 'GPS_PING', 'old', now() - ($3 * interval '1 day') - (g * interval '1 second') from generate_series(1, $4) g`, [rt0.vid, orgId, days, n]);
    await insT(31, 7, "t31"); await insT(100, 3, "t100"); await insT(29, 6, "t29"); await insI(91, 4); await insI(89, 5);
    const keepT = (await q1("select count(*)::int n from telemetry where vehicle_id=$1 and ts > now() - interval '30 days'", [rt0.vid]))[0].n;
    const keepI = (await q1("select count(*)::int n from incidents where vehicle_id=$1 and ts > now() - interval '90 days'", [rt0.vid]))[0].n;
    await c.query("insert into password_resets (org_id, token_hash, expires_at, used_at) values ($1, 'old-expired-hash', now() - interval '3 days', null), ($1, 'old-used-hash', now() + interval '1 hour', now()), ($1, 'fresh-hash', now() + interval '20 minutes', null)", [orgId]);
    await c.query("insert into rate_limits (key, count, window_start) values ('retention-old', 5, now() - interval '3 days'), ('retention-fresh', 1, now())");
    const auditBefore = (await q1("select count(*)::int n from audit_log"))[0].n;
    r = await cronGet("/api/cron/cleanup"); let cj = await r.json();
    ok("cleanup with the secret → 200", r.status === 200 && cj.ok === true);
    ok("telemetry older than 30 days deleted, newer kept", (await q1("select count(*)::int n from telemetry where vehicle_id=$1 and ts < now() - interval '30 days'", [rt0.vid]))[0].n === 0 && (await q1("select count(*)::int n from telemetry where vehicle_id=$1 and ts > now() - interval '30 days'", [rt0.vid]))[0].n === keepT);
    ok("incidents older than 90 days deleted, newer kept", (await q1("select count(*)::int n from incidents where vehicle_id=$1 and ts < now() - interval '90 days'", [rt0.vid]))[0].n === 0 && (await q1("select count(*)::int n from incidents where vehicle_id=$1 and ts > now() - interval '90 days'", [rt0.vid]))[0].n === keepI);
    ok("report counts what it deleted (≥10 telemetry, ≥4 incidents)", cj.telemetry >= 10 && cj.incidents >= 4 && typeof cj.durationMs === "number", JSON.stringify(cj));
    ok("expired and used password-reset rows deleted, a live one kept", (await q1("select token_hash from password_resets where token_hash in ('old-expired-hash','old-used-hash','fresh-hash') order by 1")).map((x) => x.token_hash).join() === "fresh-hash");
    ok("stale rate-limit counters deleted, current ones kept", (await q1("select key from rate_limits where key like 'retention-%' order by 1")).map((x) => x.key).join() === "retention-fresh");
    ok("the audit log is never purged", (await q1("select count(*)::int n from audit_log"))[0].n === auditBefore);
    r = await cronGet("/api/cron/cleanup"); cj = await r.json();
    ok("running it again is harmless (nothing left to delete)", r.status === 200 && cj.telemetry === 0 && cj.incidents === 0);
    await insT(40, 25_000, "bulk");
    const tB = Date.now(); cj = await (await cronGet("/api/cron/cleanup")).json();
    ok(`25,000-row backlog cleared in batches (${Date.now() - tB} ms)`, cj.telemetry === 25_000 && (await q1("select count(*)::int n from telemetry where vehicle_id=$1 and ts < now() - interval '30 days'", [rt0.vid]))[0].n === 0 && Date.now() - tB < 30_000, JSON.stringify(cj));

    const sw1 = await newVeh(mc, "S-One"), sw2 = await newVeh(mcB, "S-Two");
    await tpost(ping({ ts: Date.now() }), sw1.raw); await bpost([ping({ ts: Date.now() })], sw2.raw);
    await c.query("update vehicle_status set last_seen_at = now() - interval '10 minutes', online = true where vehicle_id in ($1, $2)", [sw1.vid, sw2.vid]);
    r = await cronGet("/api/cron/sweep"); cj = await r.json();
    ok("sweep job marks silent vehicles offline across ALL companies", r.status === 200 && cj.disconnected >= 2 && (await q1("select count(*)::int n from vehicle_status where online=false and vehicle_id in ($1,$2)", [sw1.vid, sw2.vid]))[0].n === 2);
    ok("…logging one DISCONNECTED each", (await cntInc("DISCONNECTED", sw1.vid)) === 1 && (await cntInc("DISCONNECTED", sw2.vid)) === 1);
    ok("a second sweep finds nothing new", (await (await cronGet("/api/cron/sweep")).json()).disconnected === 0 && (await cntInc("DISCONNECTED", sw1.vid)) === 1);
    ok("the daily job also sweeps", (await (await cronGet("/api/cron/cleanup")).json()).disconnected === 0);

    console.log("\nCross-site request guard");
    const post2 = (path, body, headers = {}) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers }, body: JSON.stringify(body) });
    r = await post2("/api/vehicles", { label: "Evil Van" }, { cookie: mc, origin: "https://evil.example" });
    ok("signed-in POST from another origin → 403", r.status === 403 && (await q1("select 1 from vehicles where label='Evil Van'")).length === 0);
    ok("POST claiming Sec-Fetch-Site: cross-site (no Origin) → 403", (await post2("/api/auth/logout", {}, { cookie: mc, "sec-fetch-site": "cross-site" })).status === 403);
    ok("login from another origin is blocked too (login CSRF)", (await post2("/api/auth/login", { email: "manager@acme.test", accessKey: NEW }, { origin: "https://evil.example" })).status === 403);
    ok("owner status change from another origin → 403", (await fetch(`${BASE}/api/owner/companies/${orgId}/status`, { method: "PATCH", headers: { "content-type": "application/json", cookie: oc, origin: "https://evil.example" }, body: JSON.stringify({ action: "SUSPEND", note: "csrf" }) })).status === 403 && (await q1("select status from organizations where id=$1", [orgId]))[0].status === "APPROVED");
    ok("revoke (DELETE) from another origin → 403", (await fetch(`${BASE}/api/tokens/${sw1.tid}`, { method: "DELETE", headers: { cookie: mc, origin: "https://evil.example" } })).status === 403);
    ok("same-origin POST is allowed", (await post2("/api/vehicles", { label: "Origin Van" }, { cookie: mc, origin: BASE, "sec-fetch-site": "same-origin" })).status === 201);
    ok("non-browser clients (no Origin header) are allowed", (await post2("/api/vehicles", { label: "Curl Van" }, { cookie: mc })).status === 201);
    ok("reads are unaffected by Origin", (await fetch(BASE + "/api/vehicles", { headers: { cookie: mc, origin: "https://evil.example" } })).status === 200);
    ok("driver phones are exempt (token header, not a cookie)", (await post2("/api/driver/session", {}, { "x-driver-token": rawLive, origin: "https://anywhere.example" })).status === 200);

    console.log("\nSecurity headers, legal pages, health, audit");
    r = await fetch(BASE + "/"); const csp = r.headers.get("content-security-policy") ?? "";
    ok("Content-Security-Policy is set", csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"), csp);
    ok("CSP forbids eval and foreign scripts", !csp.includes("unsafe-eval") && /script-src 'self' 'unsafe-inline'(;|$)/.test(csp));
    ok("CSP allows exactly the map tiles and Ably", csp.includes("basemaps.cartocdn.com") && csp.includes("tile.openstreetmap.org") && csp.includes("wss://*.ably.io") && csp.includes("*.ably.net") && !csp.includes("*.*") && !/ \* /.test(csp));
    ok("COOP, HSTS, nosniff, frame-deny, referrer policy all present", r.headers.get("cross-origin-opener-policy") === "same-origin" && /max-age=\d{8,}/.test(r.headers.get("strict-transport-security")) && r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("x-frame-options") === "DENY" && r.headers.get("referrer-policy") === "strict-origin-when-cross-origin");
    ok("APIs carry the same headers", (await fetch(BASE + "/api/health")).headers.get("content-security-policy") === csp);
    r = await fetch(BASE + "/privacy"); let pgTxt = await r.text();
    ok("privacy notice page", r.status === 200 && pgTxt.includes("Privacy Notice") && pgTxt.includes("30 days") && pgTxt.includes("90 days") && pgTxt.includes("lawyer"));
    r = await fetch(BASE + "/terms"); pgTxt = await r.text();
    ok("terms of service page", r.status === 200 && pgTxt.includes("Terms of Service") && pgTxt.includes("not a safety or emergency system"));
    pgTxt = await (await fetch(BASE + "/")).text();
    ok("landing footer links to both", pgTxt.includes('href="/privacy"') && pgTxt.includes('href="/terms"'));
    ok("registration page links to both", (await (await fetch(BASE + "/register")).text()).includes('href="/terms"'));
    r = await fetch(BASE + "/api/health"); ok("health check → 200 {ok:true}, no-store", r.status === 200 && (await r.json()).ok === true && r.headers.get("cache-control") === "no-store");
    ok("audit API: no session / manager → 401", (await fetch(BASE + "/api/owner/audit")).status === 401 && (await fetch(BASE + "/api/owner/audit", { headers: { cookie: mc } })).status === 401);
    r = await fetch(BASE + "/api/owner/audit?limit=200", { headers: { cookie: oc } }); const aj = await r.json();
    ok("audit API lists owner decisions with company names", r.status === 200 && aj.entries.some((x) => x.action === "COMPANY_APPROVED" && x.company === "Acme Logistics") && aj.entries.some((x) => x.action === "COMPANY_SUSPENDED" && x.note === "Policy violation test"));
    ok("…and manager link revocations", aj.entries.some((x) => x.action === "TOKEN_REVOKED" && x.actor === `manager:${orgId}`));
    ok("audit entries are newest first", aj.entries.every((x, i) => i === 0 || x.ts <= aj.entries[i - 1].ts));
    ok("audit limit is honoured and capped", (await (await fetch(BASE + "/api/owner/audit?limit=3", { headers: { cookie: oc } })).json()).entries.length === 3);
    ok("owner page shows the audit log", (await (await fetch(BASE + "/owner", { headers: { cookie: oc } })).text()).includes("Audit log"));

    console.log("\nEnvironment checker");
    const bcryptHash = bcrypt.hashSync("owner-password-123", 4);
    const goodVars = { DATABASE_URL: "postgres://u:p@ep-x.neon.tech/db?sslmode=require", JWT_SECRET: "x".repeat(40), OWNER_EMAIL: "owner@example.com", BREVO_API_KEY: "xkeysib-" + "a".repeat(40), BREVO_SENDER_EMAIL: "noreply@example.com", ABLY_API_KEY: "AbCdEf.GhIjKl:secret_value-123", APP_URL: "https://zerotracker.example.com", CRON_SECRET: "c".repeat(24) };
    const envFile = (vars) => Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    const runCheck = (fileVars, procVars = {}, flags = {}) => {
      const dir = mkdtempSync(join(tmpdir(), "zt-env-")); writeFileSync(join(dir, ".env.local"), envFile(fileVars));
      const out = spawnSync("node", ["scripts/check-env.mjs"], { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH, ZT_ENV_DIR: dir, ...procVars, ...flags } });
      return { code: out.status, text: out.stdout + out.stderr };
    };
    let ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$") });
    ok("complete, correct .env.local passes (hash written with escaped \\$)", ck.code === 0 && ck.text.includes("looks good"), ck.text);
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash });
    ok("UNESCAPED $ in the hash is caught (Next.js would corrupt it)", ck.code === 1 && ck.text.includes("OWNER_PASSWORD_HASH") && ck.text.includes("bcrypt"), ck.text);
    ck = runCheck({}, { ...goodVars, OWNER_PASSWORD_HASH: bcryptHash });
    ok("Vercel-style real environment variables (no escaping) pass", ck.code === 0, ck.text);
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$"), JWT_SECRET: "short" });
    ok("short JWT_SECRET rejected", ck.code === 1 && ck.text.includes("JWT_SECRET"));
    ck = runCheck({}, {});
    ok("empty environment lists what is missing", ck.code === 1 && ["DATABASE_URL", "JWT_SECRET", "OWNER_EMAIL", "OWNER_PASSWORD_HASH", "ABLY_API_KEY", "APP_URL", "CRON_SECRET"].every((n) => ck.text.includes(n)), ck.text);
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$"), BREVO_API_KEY: "console", REALTIME_DRIVER: "console" });
    ok("console email/realtime modes: warning in development", ck.code === 0 && ck.text.includes("⚠"), ck.text);
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$"), BREVO_API_KEY: "console", REALTIME_DRIVER: "console" }, {}, { ZT_CHECK_PRODUCTION: "1" });
    ok("…but an ERROR in production", ck.code === 1 && ck.text.includes("console") && ck.text.includes("production"), ck.text);
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$"), APP_URL: "http://zerotracker.example.com" }, {}, { ZT_CHECK_PRODUCTION: "1" });
    ok("http:// APP_URL rejected for production", ck.code === 1 && ck.text.includes("https"), ck.text);
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$"), APP_URL: "https://zerotracker.example.com/" });
    ok("APP_URL with a trailing slash rejected", ck.code === 1 && ck.text.includes("APP_URL"));
    ck = runCheck({ ...goodVars, OWNER_PASSWORD_HASH: bcryptHash.replace(/\$/g, "\\$"), ABLY_API_KEY: "justakey" });
    ok("malformed Ably key rejected", ck.code === 1 && ck.text.includes("ABLY_API_KEY"));
    const hp = spawnSync("node", ["scripts/hash-password.mjs", "a-long-owner-password"], { encoding: "utf8" });
    const printed = hp.stdout.match(/\$2[aby]\$12\$[./A-Za-z0-9]{53}/)?.[0];
    ok("hash-password prints a verifiable bcrypt hash plus the escaped .env.local form", hp.status === 0 && !!printed && bcrypt.compareSync("a-long-owner-password", printed) && hp.stdout.includes("\\$2"));
    ok("hash-password refuses a short password", spawnSync("node", ["scripts/hash-password.mjs", "short"], { encoding: "utf8" }).status === 1);

    console.log("\nRate limiting");
    const ip = "203.0.113.9"; codes = [];
    for (let i = 0; i < 7; i++) codes.push((await post("/api/owner/login", { email: "owner@zerotracker.test", password: "bad" }, { ip })).status);
    ok("owner login: 5 attempts allowed then 429", codes.slice(0, 5).every((s) => s === 401) && codes[5] === 429 && codes[6] === 429, codes.join(","));
    codes = [];
    for (let i = 0; i < 10; i++) codes.push((await post("/api/auth/login", { email: "victim@acme.test", accessKey: "guess-guess-1" })).status);
    ok("login: per-email brute-force lock after 8 tries", codes.slice(0, 8).every((s) => s === 401) && codes[8] === 429, codes.join(","));
    r = await post("/api/owner/login", { email: "owner@zerotracker.test", password: OWNER_PW }, { ip });
    ok("429 includes Retry-After header", r.status === 429 && r.headers.get("retry-after") === "900");
  } finally {
    srv.kill("SIGTERM"); await c.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("\n--- server log ---\n" + log.slice(-2000)); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
