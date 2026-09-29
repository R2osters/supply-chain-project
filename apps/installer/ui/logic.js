// Pure installer logic: validation, step skipping, navigation and InstallPlan building.
// No DOM, no Tauri: everything here is unit-tested by logic.test.mjs (node --test).
//
// Written as a UMD-style classic script rather than an ES module so that index.html also opens
// straight from file:// in a browser for review (Chromium refuses module scripts on file://).
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.SCIP = root.SCIP || {};
    root.SCIP.logic = api;
  }
})(globalThis, function () {
  "use strict";

  // ---------------------------------------------------------------------------------------------
  // Steps and screens
  // ---------------------------------------------------------------------------------------------

  /** The 11 steps shown in the left rail, in order. */
  const RAIL = ["welcome", "license", "system", "type", "database", "organisation", "sources", "admin", "summary", "install", "done"];

  /** Every screen of the install flow. Sub-screens map to the rail step they belong to. */
  const SCREENS = {
    welcome: { rail: "welcome", code: "01" },
    license: { rail: "license", code: "02" },
    system: { rail: "system", code: "03" },
    type: { rail: "type", code: "04" },
    database: { rail: "database", code: "05" },
    "database-external": { rail: "database", code: "05b" },
    organisation: { rail: "organisation", code: "06" },
    sources: { rail: "sources", code: "07" },
    admin: { rail: "admin", code: "08" },
    summary: { rail: "summary", code: "09" },
    install: { rail: "install", code: "10" },
    "install-error": { rail: "install", code: "10b" },
    done: { rail: "done", code: "11" },
  };

  /** Screens that collect the plan, in order (everything before the summary). */
  const INPUT_SCREENS = ["welcome", "license", "system", "type", "database", "database-external", "organisation", "sources", "admin"];

  /** Maps a ?step= value ("3", "03", "5b", "05b", "10b" or a screen id) to a screen id. */
  function screenFromParam(param) {
    if (param == null) return null;
    const p = String(param).trim().toLowerCase();
    if (SCREENS[p]) return p;
    const m = p.match(/^0*(\d{1,2})(b?)$/);
    if (!m) return null;
    const code = m[1].padStart(2, "0") + m[2];
    return Object.keys(SCREENS).find((id) => SCREENS[id].code === code) || null;
  }

  /** 1-based position of a screen's rail step ("ÉTAPE 3 SUR 11"). */
  function stepNumber(screen) {
    return RAIL.indexOf(SCREENS[screen].rail) + 1;
  }

  /**
   * Whether a rail step is skipped for this state.
   * Upgrade: the data already exists, so type → admin (04–08) are skipped.
   * Demo: the demo data brings its own organisation and accounts, so 06 and 08 are skipped.
   */
  function isSkipped(railStep, state) {
    if (state.mode === "upgrade" && ["type", "database", "organisation", "sources", "admin"].includes(railStep)) return true;
    if (state.mode !== "upgrade" && state.kind === "demo" && ["organisation", "admin"].includes(railStep)) return true;
    return false;
  }

  function isScreenSkipped(screen, state) {
    if (screen === "database-external" && state.dbMode !== "external") return true;
    return isSkipped(SCREENS[screen].rail, state);
  }

  /** Linear order used for Next/Back; error and done screens are reached by events only. */
  const FLOW = ["welcome", "license", "system", "type", "database", "database-external", "organisation", "sources", "admin", "summary", "install"];

  function nextScreen(screen, state) {
    const i = FLOW.indexOf(screen);
    if (i < 0) return null;
    for (let j = i + 1; j < FLOW.length; j++) if (!isScreenSkipped(FLOW[j], state)) return FLOW[j];
    return null;
  }

  function prevScreen(screen, state) {
    const i = FLOW.indexOf(screen);
    // No going back once installation started, nor before the first screen.
    if (i <= 0 || screen === "install") return null;
    for (let j = i - 1; j >= 0; j--) if (!isScreenSkipped(FLOW[j], state)) return FLOW[j];
    return null;
  }

  /**
   * First input screen that is not skipped and not valid, or null.
   * Used after "Modifier" from the summary: changing e.g. demo → production makes 06 and 08
   * required again, so we route there instead of straight back to the summary.
   */
  function firstInvalidScreen(state) {
    for (const s of INPUT_SCREENS) if (!isScreenSkipped(s, state) && !screenValid(s, state)) return s;
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Field validation
  // ---------------------------------------------------------------------------------------------

  const PASSWORD_MIN = 12;

  /** Live checklist for the admin password: ≥ 12 chars and ≥ 3 of the 4 character classes. */
  function passwordRules(pw) {
    const s = String(pw || "");
    const lower = /\p{Ll}/u.test(s);
    const upper = /\p{Lu}/u.test(s);
    const digit = /\p{Nd}/u.test(s);
    // Anything that is neither a letter nor a digit counts as a symbol (spaces included).
    const symbol = /[^\p{L}\p{Nd}]/u.test(s);
    const classes = [lower, upper, digit, symbol].filter(Boolean).length;
    const length = [...s].length >= PASSWORD_MIN;
    return { length, lower, upper, digit, symbol, classes, variety: classes >= 3, ok: length && classes >= 3 };
  }

  // Pragmatic check (one @, a dot in the domain, no spaces); the API does the authoritative one.
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(String(email || "").trim());
  }

  function isValidPort(port) {
    const s = String(port ?? "").trim();
    if (!/^\d{1,5}$/.test(s)) return false;
    const n = Number(s);
    return n >= 1 && n <= 65535;
  }

  /**
   * Parses an optional coordinate. Accepts a decimal comma (French keyboards).
   * Returns { ok, value } where value is undefined for an empty field.
   */
  function parseCoordinate(raw, kind) {
    const s = String(raw ?? "").trim();
    if (s === "") return { ok: true, value: undefined };
    const norm = s.replace(",", ".");
    if (!/^[-+]?\d+(\.\d+)?$/.test(norm)) return { ok: false, value: undefined };
    const n = Number(norm);
    const max = kind === "lat" ? 90 : 180;
    return Math.abs(n) <= max ? { ok: true, value: n } : { ok: false, value: undefined };
  }

  function isBlankSite(site) {
    return !["name", "city", "lat", "lon"].some((k) => String(site[k] ?? "").trim() !== "");
  }

  /**
   * Validates one site row. Blank rows are ignored (valid). Otherwise the name is required and
   * latitude/longitude must be both empty or both valid, since a point needs both.
   */
  function validateSite(site) {
    const errors = {};
    if (isBlankSite(site)) return { ok: true, blank: true, errors };
    if (!String(site.name || "").trim()) errors.name = "required";
    const lat = parseCoordinate(site.lat, "lat");
    const lon = parseCoordinate(site.lon, "lon");
    if (!lat.ok) errors.lat = "range";
    if (!lon.ok) errors.lon = "range";
    if (lat.ok && lon.ok && (lat.value === undefined) !== (lon.value === undefined)) {
      errors[lat.value === undefined ? "lat" : "lon"] = "pair";
    }
    return { ok: Object.keys(errors).length === 0, blank: false, errors };
  }

  function isValidTimezone(tz) {
    const s = String(tz || "").trim();
    if (!s) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: s });
      return true;
    } catch {
      return false;
    }
  }

  const isValidCurrency = (c) => /^[A-Z]{3}$/.test(String(c || "").trim());

  // ---------------------------------------------------------------------------------------------
  // Countries (screen 06): currency and timezone are deduced from the country, then editable.
  // ---------------------------------------------------------------------------------------------

  const COUNTRIES = [
    { code: "GH", currency: "GHS", timezone: "Africa/Accra" },
    { code: "FR", currency: "EUR", timezone: "Europe/Paris" },
    { code: "CI", currency: "XOF", timezone: "Africa/Abidjan" },
    { code: "SN", currency: "XOF", timezone: "Africa/Dakar" },
    { code: "NG", currency: "NGN", timezone: "Africa/Lagos" },
    { code: "BF", currency: "XOF", timezone: "Africa/Ouagadougou" },
    { code: "TG", currency: "XOF", timezone: "Africa/Lome" },
    { code: "BJ", currency: "XOF", timezone: "Africa/Porto-Novo" },
    { code: "CM", currency: "XAF", timezone: "Africa/Douala" },
    { code: "MA", currency: "MAD", timezone: "Africa/Casablanca" },
    { code: "BE", currency: "EUR", timezone: "Europe/Brussels" },
    { code: "CH", currency: "CHF", timezone: "Europe/Zurich" },
    { code: "CA", currency: "CAD", timezone: "America/Toronto" },
    { code: "US", currency: "USD", timezone: "America/New_York" },
    { code: "GB", currency: "GBP", timezone: "Europe/London" },
  ];

  const CURRENCIES = ["GHS", "EUR", "XOF", "NGN", "XAF", "MAD", "CHF", "CAD", "USD", "GBP"];

  const countryByCode = (code) => COUNTRIES.find((c) => c.code === code) || null;

  // ---------------------------------------------------------------------------------------------
  // Database test (05b)
  // ---------------------------------------------------------------------------------------------

  /** Identity of the values a test ran with: Continue is allowed only if nothing changed since. */
  function dbTestKey(db) {
    return JSON.stringify([String(db.host).trim(), String(db.port).trim(), String(db.database).trim(), String(db.user).trim(), db.password, !!db.ssl]);
  }

  /** A test "passes" when the server is reachable, PostGIS can be enabled and we can create objects. */
  function dbTestPasses(result) {
    return !!result && result.ok === true && result.postgis !== "missing" && result.canCreate !== false;
  }

  function dbFormValid(db) {
    return !!String(db.host || "").trim() && isValidPort(db.port) && !!String(db.database || "").trim() && !!String(db.user || "").trim();
  }

  // ---------------------------------------------------------------------------------------------
  // Per-screen validity (drives the Continue button)
  // ---------------------------------------------------------------------------------------------

  function checksPass(checks) {
    return Array.isArray(checks) && checks.length > 0 && !checks.some((c) => c.status === "fail");
  }

  function orgValid(org) {
    if (!String(org.name || "").trim() || !countryByCode(org.country)) return false;
    if (!isValidCurrency(org.currency) || !isValidTimezone(org.timezone)) return false;
    return org.sites.every((s) => validateSite(s).ok);
  }

  function adminValid(a) {
    return !!String(a.firstName || "").trim() && !!String(a.lastName || "").trim() && isValidEmail(a.email) && passwordRules(a.password).ok && a.password === a.confirm;
  }

  function screenValid(screen, state) {
    switch (screen) {
      case "license":
        return !!state.licenseAccepted;
      case "system":
        return checksPass(state.checks);
      case "type":
        return state.kind === "production" || state.kind === "demo";
      case "database":
        return state.dbMode === "embedded" || state.dbMode === "external";
      case "database-external":
        return dbFormValid(state.db) && !!state.dbTest && state.dbTest.key === dbTestKey(state.db) && dbTestPasses(state.dbTest.result);
      case "organisation":
        return orgValid(state.org);
      case "sources":
        return state.sources.vehicles === "live" || state.sources.vehicles === "simulation";
      case "admin":
        return adminValid(state.admin);
      default:
        return true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // InstallPlan (docs/installer.md)
  // ---------------------------------------------------------------------------------------------

  const optional = (v) => {
    const s = String(v ?? "").trim();
    return s ? s : undefined;
  };

  /**
   * Builds the InstallPlan exactly per the spec type. Optional keys are omitted, not sent empty,
   * so the engine can tell "not provided" from "provided".
   * Upgrade: 04–08 are skipped; the engine keeps the existing data and configuration, so we send
   * the neutral defaults (production, embedded, live) with no organisation or admin.
   */
  function buildPlan(state) {
    const upgrade = state.mode === "upgrade";
    const kind = upgrade ? "production" : state.kind;
    const plan = { kind };

    if (!upgrade && state.dbMode === "external") {
      const d = state.db;
      plan.database = {
        mode: "external",
        host: String(d.host).trim(),
        port: Number(String(d.port).trim()),
        database: String(d.database).trim(),
        user: String(d.user).trim(),
        password: d.password,
        ssl: !!d.ssl,
      };
    } else {
      plan.database = { mode: "embedded" };
    }

    if (!upgrade && kind === "production") {
      const o = state.org;
      plan.organisation = {
        name: o.name.trim(),
        country: o.country,
        currency: o.currency.trim().toUpperCase(),
        timezone: o.timezone.trim(),
        sites: o.sites
          .filter((s) => !isBlankSite(s))
          .map((s) => {
            const site = { name: s.name.trim(), city: String(s.city || "").trim() };
            const lat = parseCoordinate(s.lat, "lat").value;
            const lon = parseCoordinate(s.lon, "lon").value;
            if (lat !== undefined && lon !== undefined) {
              site.latitude = lat;
              site.longitude = lon;
            }
            return site;
          }),
      };
    }

    const src = state.sources;
    plan.sources = { vehicles: upgrade ? "live" : src.vehicles };
    if (!upgrade) {
      const keys = { aisStreamKey: src.aisStreamKey, openskyClientId: src.openskyClientId, openskyClientSecret: src.openskyClientSecret, tomtomKey: src.tomtomKey };
      for (const [k, v] of Object.entries(keys)) if (optional(v)) plan.sources[k] = optional(v);
    }

    if (!upgrade && kind === "production") {
      const a = state.admin;
      plan.admin = { firstName: a.firstName.trim(), lastName: a.lastName.trim(), email: a.email.trim(), password: a.password };
    }

    plan.desktopShortcut = !!state.desktopShortcut;
    return plan;
  }

  /** Fresh wizard state; mode comes from get_context. */
  function initialState(mode = "install") {
    return {
      mode,
      checks: null,
      licenseAccepted: false,
      kind: null,
      dbMode: null,
      db: { host: "localhost", port: "5432", database: "scip", user: "postgres", password: "", ssl: false },
      dbTest: null,
      org: { name: "", country: "", currency: "", timezone: "", sites: [{ name: "", city: "", lat: "", lon: "" }] },
      sources: { vehicles: "live", aisStreamKey: "", openskyClientId: "", openskyClientSecret: "", tomtomKey: "" },
      admin: { firstName: "", lastName: "", email: "", password: "", confirm: "" },
      desktopShortcut: true,
    };
  }

  return {
    RAIL,
    SCREENS,
    FLOW,
    INPUT_SCREENS,
    COUNTRIES,
    CURRENCIES,
    PASSWORD_MIN,
    screenFromParam,
    stepNumber,
    isSkipped,
    isScreenSkipped,
    nextScreen,
    prevScreen,
    firstInvalidScreen,
    passwordRules,
    isValidEmail,
    isValidPort,
    parseCoordinate,
    validateSite,
    isBlankSite,
    isValidTimezone,
    isValidCurrency,
    countryByCode,
    dbTestKey,
    dbTestPasses,
    dbFormValid,
    checksPass,
    orgValid,
    adminValid,
    screenValid,
    buildPlan,
    initialState,
  };
});
