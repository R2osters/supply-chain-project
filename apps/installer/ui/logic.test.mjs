// Unit tests for the installer's pure logic. Run: node --test apps/installer/ui/logic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// logic.js is a UMD classic script: CommonJS default export here, window.SCIP.logic in the page.
const mod = await import("./logic.js");
const L = mod.default ?? globalThis.SCIP.logic;

function validProduction() {
  const s = L.initialState("install");
  s.checks = [{ id: "os", status: "ok" }];
  s.licenseAccepted = true;
  s.kind = "production";
  s.dbMode = "embedded";
  s.org = { name: "Accra Foods", country: "GH", currency: "GHS", timezone: "Africa/Accra", sites: [{ name: "Tema", city: "Tema", lat: "5,6698", lon: "-0.0166" }] };
  s.admin = { firstName: "Ama", lastName: "Mensah", email: "ama@accrafoods.com.gh", password: "Correct-horse-9", confirm: "Correct-horse-9" };
  return s;
}

test("password rules: length and 3 of 4 classes", () => {
  assert.equal(L.passwordRules("").ok, false);
  assert.equal(L.passwordRules("Short1!").length, false);
  const onlyLower = L.passwordRules("abcdefghijklmnop");
  assert.equal(onlyLower.length, true);
  assert.equal(onlyLower.classes, 1);
  assert.equal(onlyLower.ok, false);
  assert.equal(L.passwordRules("abcdefghijK1").ok, true); // lower + upper + digit
  assert.equal(L.passwordRules("abcdefghij1!").ok, true); // lower + digit + symbol
  assert.equal(L.passwordRules("ABCDEFGHIJ 1").ok, true); // space counts as a symbol
  assert.equal(L.passwordRules("éèàçùôîêâûÉ1").ok, true); // accented letters are letters
  assert.equal(L.passwordRules("Abcdefghij1").length, false); // 11 chars
});

test("email validation", () => {
  assert.ok(L.isValidEmail("ama@accrafoods.com.gh"));
  assert.ok(L.isValidEmail("  a.b+c@d.fr "));
  for (const bad of ["", "ama", "ama@", "ama@host", "a b@c.fr", "a@b..fr", "@b.fr"]) assert.equal(L.isValidEmail(bad), false, bad);
});

test("coordinates: optional, decimal comma, ranges", () => {
  assert.deepEqual(L.parseCoordinate("", "lat"), { ok: true, value: undefined });
  assert.deepEqual(L.parseCoordinate("5,6", "lat"), { ok: true, value: 5.6 });
  assert.deepEqual(L.parseCoordinate("-0.0166", "lon"), { ok: true, value: -0.0166 });
  assert.equal(L.parseCoordinate("91", "lat").ok, false);
  assert.equal(L.parseCoordinate("179.9", "lon").ok, true);
  assert.equal(L.parseCoordinate("-181", "lon").ok, false);
  assert.equal(L.parseCoordinate("abc", "lat").ok, false);
  assert.equal(L.parseCoordinate("1e3", "lat").ok, false);
});

test("site rows: blank ignored, name required, lat/lon as a pair", () => {
  assert.equal(L.validateSite({ name: "", city: "", lat: "", lon: "" }).ok, true);
  assert.equal(L.validateSite({ name: "", city: "Tema", lat: "", lon: "" }).errors.name, "required");
  assert.equal(L.validateSite({ name: "A", city: "", lat: "5", lon: "" }).errors.lon, "pair");
  assert.equal(L.validateSite({ name: "A", city: "", lat: "95", lon: "1" }).errors.lat, "range");
  assert.equal(L.validateSite({ name: "A", city: "", lat: "5", lon: "1" }).ok, true);
});

test("ports and timezones", () => {
  assert.ok(L.isValidPort("5432"));
  assert.ok(!L.isValidPort("0"));
  assert.ok(!L.isValidPort("65536"));
  assert.ok(!L.isValidPort("54a"));
  assert.ok(L.isValidTimezone("Africa/Accra"));
  assert.ok(!L.isValidTimezone("Mars/Olympus"));
  assert.ok(!L.isValidTimezone(""));
});

test("every country has a currency from the list and a valid IANA timezone", () => {
  assert.equal(L.COUNTRIES.length, 15);
  for (const c of L.COUNTRIES) {
    assert.ok(L.CURRENCIES.includes(c.currency), c.code);
    assert.ok(L.isValidTimezone(c.timezone), c.timezone);
  }
});

test("screen param parsing", () => {
  assert.equal(L.screenFromParam("3"), "system");
  assert.equal(L.screenFromParam("03"), "system");
  assert.equal(L.screenFromParam("5b"), "database-external");
  assert.equal(L.screenFromParam("10b"), "install-error");
  assert.equal(L.screenFromParam("11"), "done");
  assert.equal(L.screenFromParam("summary"), "summary");
  assert.equal(L.screenFromParam("12"), null);
  assert.equal(L.screenFromParam(null), null);
  assert.equal(L.stepNumber("database-external"), 5);
  assert.equal(L.stepNumber("install-error"), 10);
});

test("step skipping: demo skips 06 and 08, upgrade skips 04–08", () => {
  const s = L.initialState("install");
  s.kind = "demo";
  assert.ok(L.isSkipped("organisation", s));
  assert.ok(L.isSkipped("admin", s));
  assert.ok(!L.isSkipped("sources", s));
  const u = L.initialState("upgrade");
  for (const step of ["type", "database", "organisation", "sources", "admin"]) assert.ok(L.isSkipped(step, u), step);
  assert.ok(!L.isSkipped("summary", u));
});

test("navigation follows skips and the external database sub-screen", () => {
  const s = L.initialState("install");
  s.kind = "demo";
  s.dbMode = "embedded";
  assert.equal(L.nextScreen("database", s), "sources");
  assert.equal(L.nextScreen("sources", s), "summary");
  assert.equal(L.prevScreen("summary", s), "sources");
  assert.equal(L.prevScreen("sources", s), "database");
  s.dbMode = "external";
  assert.equal(L.nextScreen("database", s), "database-external");
  assert.equal(L.prevScreen("sources", s), "database-external");
  const u = L.initialState("upgrade");
  assert.equal(L.nextScreen("system", u), "summary");
  assert.equal(L.prevScreen("summary", u), "system");
  assert.equal(L.prevScreen("welcome", u), null);
  assert.equal(L.prevScreen("install", u), null);
});

test("database test must match current values and pass", () => {
  const s = validProduction();
  s.dbMode = "external";
  s.db.password = "pw";
  assert.equal(L.screenValid("database-external", s), false);
  s.dbTest = { key: L.dbTestKey(s.db), result: { ok: true, serverVersion: "16.2", postgis: "available", canCreate: true } };
  assert.equal(L.screenValid("database-external", s), true);
  s.db.password = "changed";
  assert.equal(L.screenValid("database-external", s), false);
  s.dbTest = { key: L.dbTestKey(s.db), result: { ok: true, serverVersion: "16.2", postgis: "missing", canCreate: true } };
  assert.equal(L.screenValid("database-external", s), false);
  s.dbTest.result = { ok: false, message: "refused" };
  assert.equal(L.screenValid("database-external", s), false);
});

test("firstInvalidScreen routes to newly required steps", () => {
  const s = validProduction();
  assert.equal(L.firstInvalidScreen(s), null);
  s.admin.confirm = "nope";
  assert.equal(L.firstInvalidScreen(s), "admin");
  const d = L.initialState("install");
  Object.assign(d, { checks: [{ status: "ok" }], licenseAccepted: true, kind: "demo", dbMode: "embedded" });
  assert.equal(L.firstInvalidScreen(d), null);
  d.kind = "production";
  assert.equal(L.firstInvalidScreen(d), "organisation");
});

test("system checks: a fail blocks, a warn does not", () => {
  assert.ok(L.checksPass([{ status: "ok" }, { status: "warn" }]));
  assert.ok(!L.checksPass([{ status: "ok" }, { status: "fail" }]));
  assert.ok(!L.checksPass(null));
});

test("buildPlan: production, embedded, optional keys omitted", () => {
  const plan = L.buildPlan(validProduction());
  assert.deepEqual(plan, {
    kind: "production",
    database: { mode: "embedded" },
    organisation: { name: "Accra Foods", country: "GH", currency: "GHS", timezone: "Africa/Accra", sites: [{ name: "Tema", city: "Tema", latitude: 5.6698, longitude: -0.0166 }] },
    sources: { vehicles: "live" },
    admin: { firstName: "Ama", lastName: "Mensah", email: "ama@accrafoods.com.gh", password: "Correct-horse-9" },
    desktopShortcut: true,
  });
});

test("buildPlan: demo + external database + keys, no organisation/admin", () => {
  const s = validProduction();
  s.kind = "demo";
  s.dbMode = "external";
  s.db = { host: " db.local ", port: "5433", database: "scip", user: "scip", password: "p w", ssl: true };
  s.sources = { vehicles: "simulation", aisStreamKey: " abc ", openskyClientId: "", openskyClientSecret: "  ", tomtomKey: "tt" };
  s.org.sites.push({ name: "", city: "", lat: "", lon: "" });
  s.desktopShortcut = false;
  const plan = L.buildPlan(s);
  assert.deepEqual(plan, {
    kind: "demo",
    database: { mode: "external", host: "db.local", port: 5433, database: "scip", user: "scip", password: "p w", ssl: true },
    sources: { vehicles: "simulation", aisStreamKey: "abc", tomtomKey: "tt" },
    desktopShortcut: false,
  });
});

test("buildPlan: blank site rows dropped, coordinates only when both set", () => {
  const s = validProduction();
  s.org.sites = [{ name: "A", city: "", lat: "", lon: "" }, { name: "", city: "", lat: "", lon: "" }];
  assert.deepEqual(L.buildPlan(s).organisation.sites, [{ name: "A", city: "" }]);
});

test("buildPlan: upgrade sends neutral defaults only", () => {
  const s = L.initialState("upgrade");
  assert.deepEqual(L.buildPlan(s), { kind: "production", database: { mode: "embedded" }, sources: { vehicles: "live" }, desktopShortcut: true });
});

test("the rail leaves out steps that do not apply and renumbers the rest", () => {
  const upgrade = { ...L.initialState("upgrade"), mode: "upgrade" };
  assert.deepEqual(L.visibleRail(upgrade), L.RAIL.filter((id) => !["type", "database", "organisation", "sources", "admin"].includes(id)));
  assert.equal(L.stepNumber("summary", upgrade), 4);
  const demo = { ...L.initialState("install"), kind: "demo" };
  assert.equal(L.visibleRail(demo).length, L.RAIL.length - 2);
  assert.equal(L.stepNumber("sources", demo), 6);
});
