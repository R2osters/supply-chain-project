// SCIP installer front-end: screens, navigation and the bridge to the Tauri engine.
// Contract: docs/installer.md (commands, events, InstallPlan). Pure rules live in logic.js.
//
// Runs in two environments:
//  - inside the installer (Tauri 2, withGlobalTauri): window.__TAURI__.core.invoke / event.listen;
//  - in a plain browser (file:// or any static server): a built-in MOCK engine simulates every
//    command and event so the screens can be reviewed. Query parameters (mock only):
//      ?mode=upgrade | ?mode=uninstall   start in update or uninstall mode
//      ?step=3 | 05b | 10b | 11 | summary jump to a screen (earlier screens are pre-filled)
//      ?err=1                            the provisioning step fails once (screen 10b), Retry resumes
//      ?checks=fail                      a blocking system check fails (screen 03)
//      ?theme=dark|light  ?lang=fr|en    force theme/language for this load (not remembered)
//    Mock database test (05b): host "nopostgis" → PostGIS missing, user "readonly" → no create
//    rights, host "bad" or an empty password → connection error, anything else succeeds.
(function () {
  "use strict";

  const { icon, i18n, logic: L } = window.SCIP;
  const t = i18n.t;
  const params = new URLSearchParams(location.search);

  // -----------------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errMessage = (e) => (typeof e === "string" ? e : e?.message ? String(e.message) : String(e));
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* storage unavailable: preference simply not remembered */
      }
    },
  };

  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
  }

  // -----------------------------------------------------------------------------------------------
  // Engine bridge
  // -----------------------------------------------------------------------------------------------

  // Argument names for commands that take an input. Tauri maps these keys to the Rust command's
  // parameter names (camelCase in JS ↔ snake_case in Rust), so they must match the engine.
  const cmd = {
    getContext: () => engine.invoke("get_context"),
    runSystemChecks: () => engine.invoke("run_system_checks"),
    testDatabase: (params) => engine.invoke("test_database", { params }),
    startInstall: (plan) => engine.invoke("start_install", { plan }),
    retryInstall: () => engine.invoke("retry_install"),
    launchScip: (createDesktopShortcut) => engine.invoke("launch_scip", { createDesktopShortcut }),
    startUninstall: (removeData) => engine.invoke("start_uninstall", { removeData }),
    readLog: () => engine.invoke("read_log"),
  };

  function tauriEngine(T) {
    return {
      mock: false,
      invoke: (name, args) => T.core.invoke(name, args),
      listen: (event, cb) => T.event.listen(event, (e) => cb(e.payload)),
      // Needs the "core:window:allow-close" permission; the engine may also exit on its own.
      close: async () => {
        try {
          await T.window.getCurrentWindow().close();
        } catch {
          window.close();
        }
      },
      openExternal: (url) => {
        // Never navigate the installer's webview away; hand links to the system browser.
        if (T.opener?.openUrl) T.opener.openUrl(url);
        else if (T.shell?.open) T.shell.open(url);
      },
    };
  }

  /** Simulated engine for browser review. Timings are realistic but shortened. */
  function mockEngine() {
    const mode = ["upgrade", "uninstall"].includes(params.get("mode")) ? params.get("mode") : "install";
    const jump = L.screenFromParam(params.get("step"));
    // Jumping straight to 10b/11 runs the simulated install fast so those screens appear quickly.
    const speed = ["install-error", "done"].includes(jump) ? 0.06 : 1;
    let failOnce = params.get("err") === "1" || jump === "install-error";
    const listeners = {};
    const logLines = [];
    const doneSteps = new Set();
    let fraction = 0;
    let steps = [];
    let removeData = false;
    const L10 = (fr, en) => (i18n.getLang() === "en" ? en : fr);
    const emit = (ev, payload) => (listeners[ev] || []).forEach((cb) => cb(payload));
    const wait = (ms) => sleep(ms * speed);
    const log = (s) => {
      const line = `${new Date().toISOString().slice(11, 19)}  ${s}`;
      logLines.push(line);
      emit("install://log", { line });
    };

    const installSteps = () => [
      { id: "extract", w: 0.55, n: 16, label: L10("Copie des fichiers", "Copying files"), logs: (i) => i % 4 === 0 && `extract: resources/app/${["api", "web", "postgres", "postgis"][i / 4]}/…` },
      { id: "shortcuts", w: 0.03, n: 2, label: L10("Raccourcis", "Shortcuts"), logs: (i) => i === 0 && "shortcut: Start Menu\\Programs\\SCIP.lnk" },
      { id: "register", w: 0.02, n: 2, label: L10("Enregistrement de la désinstallation", "Registering the uninstaller"), logs: (i) => i === 0 && "registry: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SCIP" },
      {
        id: "provision",
        w: 0.35,
        n: 8,
        failAt: 5,
        label: L10("Préparation de la base et de l'organisation", "Preparing the database and organisation"),
        logs: (i) =>
          (mode === "upgrade"
            ? ["provision: config.json kept", "postgres: starting (port 5433)", "migrate: 3 pending migrations", "migrate: 20260914_vehicle_estimates applied", "migrate: done", "api: started on 127.0.0.1:3001", "api: health ok", "postgres: stopped"]
            : ["initdb: data directory created", "postgres: starting (port 5433)", "postgis: CREATE EXTENSION postgis", "migrate: 42 migrations applied", "api: started on 127.0.0.1:3001", "organisation: created", "admin: account created", "sources: settings saved"])[i],
      },
      { id: "finish", w: 0.05, n: 2, label: L10("Finalisation", "Finishing"), logs: (i) => i === 1 && "done: SCIP installed" },
    ];
    const uninstallSteps = () =>
      [
        { id: "stop", w: 0.1, n: 2, label: L10("Arrêt de SCIP", "Stopping SCIP") },
        { id: "shortcuts", w: 0.1, n: 2, label: L10("Suppression des raccourcis", "Removing shortcuts") },
        { id: "files", w: 0.5, n: 8, label: L10("Suppression des fichiers", "Removing files") },
        removeData && { id: "data", w: 0.25, n: 5, label: L10("Suppression des données", "Deleting data") },
        { id: "register", w: 0.05, n: 1, label: L10("Nettoyage du registre", "Cleaning the registry") },
      ].filter(Boolean);

    async function run() {
      const total = steps.reduce((a, s) => a + s.w, 0);
      let base = steps.filter((s) => doneSteps.has(s.id)).reduce((a, s) => a + s.w, 0);
      for (const st of steps) {
        if (doneSteps.has(st.id)) continue;
        emit("install://step", { id: st.id, status: "running", label: st.label });
        log(`${st.id}: start`);
        for (let i = 0; i < st.n; i++) {
          await wait(st.id === "provision" ? 520 : 180);
          if (st.failAt === i && failOnce) {
            failOnce = false;
            log("provision: error: connection to 127.0.0.1:5433 timed out after 30 s");
            emit("install://step", { id: st.id, status: "failed", label: st.label });
            emit("install://error", {
              step: st.id,
              code: "NETWORK_TIMEOUT",
              message: L10("La connexion au service local de SCIP a expiré (réseau). Les fichiers sont en place ; seule la préparation de la base reste à faire.", "The connection to SCIP's local service timed out (network). Files are in place; only the database preparation remains."),
              retryable: true,
            });
            return;
          }
          const line = st.logs && st.logs(i);
          if (line) log(line);
          fraction = (base + (st.w * (i + 1)) / st.n) / total;
          const mb = Math.round(fraction * 412);
          emit("install://progress", { fraction, detail: st.id === "extract" ? L10(`${mb} Mo sur 412 Mo`, `${mb} MB of 412 MB`) : st.label });
        }
        doneSteps.add(st.id);
        base += st.w;
        emit("install://step", { id: st.id, status: "done", label: st.label });
      }
      emit("install://progress", { fraction: 1, detail: L10("Terminé", "Done") });
      log("done");
      await wait(400);
      emit("install://done", null);
    }

    const DIR = "C:\\Users\\ama.mensah\\AppData\\Local\\Programs\\SCIP";
    const handlers = {
      async get_context() {
        await sleep(80);
        return {
          mode,
          version: "0.2.0",
          existing: mode === "install" ? null : { version: "0.1.4", dir: DIR },
          locale: (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en",
          payloadBytes: 431906816,
          defaultInstallDir: DIR,
        };
      },
      async run_system_checks() {
        await sleep(900 * speed);
        const failDisk = params.get("checks") === "fail";
        return [
          { id: "os", status: "ok", label: L10("Système d'exploitation", "Operating system"), detail: "Windows 11 Famille 24H2 (26200)" },
          failDisk
            ? { id: "disk", status: "fail", label: L10("Espace disque", "Disk space"), detail: L10("1,4 Go libres sur C: pour 2 Go requis. Libérez de l'espace puis relancez.", "1.4 GB free on C: of 2 GB required. Free some space, then run again.") }
            : { id: "disk", status: "ok", label: L10("Espace disque", "Disk space"), detail: L10("38,2 Go libres sur C: (2 Go requis)", "38.2 GB free on C: (2 GB required)") },
          { id: "ram", status: "warn", label: L10("Mémoire", "Memory"), detail: L10("3,8 Go : SCIP fonctionnera, plus lentement avec beaucoup de véhicules (4 Go conseillés).", "3.8 GB: SCIP will run, slower with many vehicles (4 GB recommended).") },
          { id: "webview2", status: "ok", label: "WebView2", detail: "Runtime 129.0.2792.65" },
          { id: "port-api", status: "ok", label: L10("Port de l'API", "API port"), detail: L10("3001 libre", "3001 free") },
          { id: "port-gps", status: "ok", label: L10("Port des boîtiers GPS", "GPS tracker port"), detail: L10("5023 libre", "5023 free") },
        ];
      },
      async test_database({ params: p }) {
        await sleep(1100);
        if (p.host === "bad" || !p.password) {
          return { ok: false, serverVersion: null, postgis: "missing", canCreate: false, message: L10(`Connexion refusée par ${p.host}:${p.port} (mot de passe incorrect ou serveur injoignable).`, `Connection refused by ${p.host}:${p.port} (wrong password or server unreachable).`) };
        }
        if (p.host === "nopostgis") return { ok: true, serverVersion: "15.6", postgis: "missing", canCreate: true, message: "PostGIS not available" };
        if (p.user === "readonly") return { ok: true, serverVersion: "16.4", postgis: "installed", canCreate: false, message: "permission denied for schema public" };
        return { ok: true, serverVersion: "16.4", postgis: "available", canCreate: true, message: "ok" };
      },
      async start_install({ plan }) {
        console.info("[mock] start_install", JSON.parse(JSON.stringify(plan)));
        steps = installSteps();
        doneSteps.clear();
        run();
      },
      async retry_install() {
        run();
      },
      async start_uninstall({ removeData: rd }) {
        removeData = !!rd;
        steps = uninstallSteps();
        doneSteps.clear();
        run();
      },
      async launch_scip(args) {
        console.info("[mock] launch_scip", args);
      },
      async read_log() {
        await sleep(150);
        return logLines.join("\n");
      },
    };

    return {
      mock: true,
      invoke: async (name, args) => {
        if (!handlers[name]) throw { code: "UNKNOWN_COMMAND", message: name };
        return handlers[name](args || {});
      },
      listen: async (event, cb) => {
        (listeners[event] = listeners[event] || []).push(cb);
        return () => (listeners[event] = listeners[event].filter((f) => f !== cb));
      },
      close: async () => {
        document.body.innerHTML = `<p style="padding:40px;font:500 12px 'IBM Plex Mono',monospace;color:var(--dim)">${esc(t("mock.closed", { cmd: "close" }))}</p>`;
      },
      openExternal: (url) => window.open(url, "_blank", "noopener"),
    };
  }

  const engine = window.__TAURI__?.core?.invoke ? tauriEngine(window.__TAURI__) : mockEngine();

  // -----------------------------------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------------------------------

  let S = L.initialState("install"); // wizard data (see logic.initialState)
  let ctx = null; // get_context result
  let screen = "welcome";
  let fromSummary = false; // "Modifier" on the summary: Continue returns to the summary
  const ui = {
    touched: new Set(),
    showPw: {},
    checksRunning: false,
    checksError: null,
    dbTesting: false,
    steps: [], // [{ id, status, label }] from install://step
    fraction: 0,
    detail: "",
    log: [],
    fullLog: null, // read_log result, shown on 10b
    journalOpen: false,
    error: null, // install://error payload
    removeData: false,
    vehiclesChosen: false,
    busy: false, // guards double clicks on one-shot actions
  };

  const isUninstall = () => ctx?.mode === "uninstall";
  const isUpgrade = () => ctx?.mode === "upgrade";

  // -----------------------------------------------------------------------------------------------
  // Theme and language
  // -----------------------------------------------------------------------------------------------

  const THEME_KEY = "scip-installer-theme";
  const LANG_KEY = "scip-installer-lang";
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = $("#theme-toggle");
    btn.innerHTML = icon("sun-moon", 16);
    btn.setAttribute("aria-label", t(theme === "dark" ? "toggle.theme.dark" : "toggle.theme.light"));
    btn.title = btn.getAttribute("aria-label");
  }
  const currentTheme = () => document.documentElement.dataset.theme || "light";
  function setTheme(theme) {
    store.set(THEME_KEY, theme);
    applyTheme(theme);
    if (screen === "welcome") rerender();
  }

  function setLang(lang) {
    store.set(LANG_KEY, lang);
    applyLang(lang);
  }

  function applyLang(lang) {
    i18n.setLang(lang);
    document.documentElement.lang = lang;
    document.title = t(isUninstall() ? "app.uninstallTitle" : "app.title");
    const btn = $("#lang-toggle");
    btn.textContent = lang.toUpperCase();
    btn.setAttribute("aria-label", t("toggle.lang"));
    btn.title = t("toggle.lang");
    $("#rail-nav").setAttribute("aria-label", t("rail.label"));
    $("#mock-banner").textContent = t("mock.banner");
    applyTheme(currentTheme());
    rerender();
  }

  // -----------------------------------------------------------------------------------------------
  // Small render helpers
  // -----------------------------------------------------------------------------------------------

  function head(titleKey, leadHtml, kicker) {
    const k = kicker ?? defaultKicker();
    return `<div class="head">
      ${k ? `<span class="kicker">${esc(k)}</span>` : ""}
      <h1 id="screen-title" tabindex="-1">${esc(t(titleKey))}</h1>
      ${leadHtml ? `<p class="lead">${leadHtml}</p>` : ""}
    </div>`;
  }

  function defaultKicker() {
    if (isUninstall()) return t("kicker.uninstall");
    const k = t("kicker.step", { n: L.stepNumber(screen, S), total: L.visibleRail(S).length });
    return isUpgrade() ? `${k} · ${t("kicker.upgrade")}` : k;
  }

  function field(id, bind, labelKey, opts = {}) {
    const v = getPath(S, bind) ?? "";
    const type = opts.type || "text";
    const optional = opts.optional ? `<span class="opt">${esc(t("common.optional"))}</span>` : "";
    const describedBy = [opts.help && `${id}-help`, `${id}-err`].filter(Boolean).join(" ");
    const attrs = `id="${id}" data-bind="${bind}" data-err="${id}" aria-describedby="${describedBy}" ${opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : 'autocomplete="off"'} ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ""} ${opts.list ? `list="${opts.list}"` : ""} spellcheck="false"`;
    let control;
    if (type === "password") {
      const shown = !!ui.showPw[id];
      control = `<span class="pw" data-pw="${id}"><input ${attrs} type="${shown ? "text" : "password"}" value="${esc(v)}">
        <button type="button" class="icon-btn" data-action="toggle-pw" data-target="${id}" aria-pressed="${shown}" aria-label="${esc(t(shown ? "common.hidePassword" : "common.showPassword"))}" title="${esc(t(shown ? "common.hidePassword" : "common.showPassword"))}">${icon(shown ? "eye-off" : "eye", 16)}</button></span>`;
    } else {
      control = `<input class="input" ${attrs} type="${type}" value="${esc(v)}">`;
    }
    return `<div class="field ${opts.cls || ""}">
      <label class="label" for="${id}">${esc(t(labelKey))}${optional}</label>
      ${control}
      ${opts.help ? `<span class="help" id="${id}-help">${opts.help}</span>` : ""}
      <span id="${id}-err" class="err-slot"></span>
    </div>`;
  }

  function errHtml(msg) {
    return msg ? `<span class="err">${icon("circle-alert", 13)}<span>${esc(msg)}</span></span>` : "";
  }

  /** Writes each error slot and flags its input; `errors` maps an input id to a message or null. */
  function applyErrors(errors) {
    for (const [id, msg] of Object.entries(errors)) {
      const slot = document.getElementById(`${id}-err`);
      if (slot) slot.innerHTML = errHtml(msg);
      const input = document.getElementById(id);
      if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
      const pw = document.querySelector(`[data-pw="${id}"]`);
      if (pw) pw.classList.toggle("invalid", !!msg);
    }
  }

  const shown = (id) => ui.touched.has(id);

  /** Radio group made of option cards or pills; arrow keys handled globally (see onKeydown). */
  function radioGroup({ id, bind, labelKey, options, cls = "options two", kind = "card" }) {
    const value = getPath(S, bind);
    const anyChecked = options.some((o) => o.value === value);
    const items = options
      .map((o, i) => {
        const checked = o.value === value;
        const tabindex = checked || (!anyChecked && i === 0) ? 0 : -1;
        const common = `id="${id}-${o.value}" role="radio" aria-checked="${checked}" tabindex="${tabindex}" data-action="choose" data-bind="${bind}" data-value="${o.value}"`;
        if (kind === "pill") return `<button type="button" ${common}>${o.icon ? icon(o.icon, 15) : ""}${esc(o.title)}</button>`;
        return `<button type="button" class="option" ${common} aria-describedby="${id}-${o.value}-desc">
          <span class="o-top"><span class="o-icon">${icon(o.icon, 18)}</span>${o.badge ? `<span class="badge"><span class="dot"></span>${esc(o.badge)}</span>` : ""}<span class="o-radio" aria-hidden="true"></span></span>
          <span class="o-title">${esc(o.title)}</span>
          <span class="o-desc" id="${id}-${o.value}-desc">${esc(o.desc)}</span>
        </button>`;
      })
      .join("");
    return `<div class="${kind === "pill" ? "segmented" : cls}" role="radiogroup" aria-label="${esc(t(labelKey))}">${items}</div>`;
  }

  function segmentedAction({ label, action, current, options }) {
    return `<div class="segmented" role="radiogroup" aria-label="${esc(label)}">${options
      .map((o) => `<button type="button" role="radio" aria-checked="${o.value === current}" tabindex="${o.value === current ? 0 : -1}" data-action="${action}" data-value="${o.value}">${o.icon ? icon(o.icon, 15) : ""}${esc(o.label)}</button>`)
      .join("")}</div>`;
  }

  function alertBox(kind, iconName, title, text, attrs = "") {
    return `<div class="alert ${kind}" ${attrs}>${icon(iconName, 16)}<div class="a-body"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ""}</div></div>`;
  }

  const STATUS_ICON = { ok: "check", warn: "triangle-alert", fail: "x" };

  function stepLabel(s) {
    // Prefer our own translation for known ids so a language switch mid-install stays consistent.
    const key = (isUninstall() ? "un.step." : "inst.step.") + s.id;
    const tr = t(key);
    return tr !== key ? tr : s.label || s.id;
  }

  /** Label/value separator: French typography puts a space before the colon. */
  const colon = () => (i18n.getLang() === "fr" ? " : " : ": ");

  function formatMB(bytes) {
    return Math.round((bytes || 0) / 1e6).toLocaleString(i18n.getLang() === "en" ? "en-GB" : "fr-FR");
  }

  // -----------------------------------------------------------------------------------------------
  // Screens. Each: render() → HTML, foot() → footer model, update() → patch after typing,
  // enter() → side effects when the screen is shown, onEnterKey() → custom Enter handling.
  // -----------------------------------------------------------------------------------------------

  const DATA_DIR = "%LOCALAPPDATA%\\com.scip.desktop";

  const views = {
    welcome: {
      render() {
        const upgrade = isUpgrade()
          ? alertBox("info", "info", t("welcome.upgrade", { from: ctx.existing?.version ?? "", to: ctx.version }), "")
          : "";
        return `${head("welcome.title", esc(t("welcome.lead")))}
          ${upgrade}
          <div class="meta">
            <div class="meta-row">${icon("circle-check", 16)}<span>${esc(t("welcome.prereq"))}</span></div>
            <div class="meta-row">${icon("package", 16)}<span class="selectable">${esc(t("welcome.where", { dir: ctx.existing?.dir || ctx.defaultInstallDir }))}</span></div>
          </div>
          <div class="grid two">
            <div class="field"><span class="label" id="w-lang">${esc(t("welcome.lang"))}</span>
              ${segmentedAction({ label: t("welcome.lang"), action: "set-lang", current: i18n.getLang(), options: [{ value: "fr", label: "Français" }, { value: "en", label: "English" }] })}</div>
            <div class="field"><span class="label">${esc(t("welcome.theme"))}</span>
              ${segmentedAction({ label: t("welcome.theme"), action: "set-theme", current: currentTheme(), options: [{ value: "light", label: t("welcome.themeLight") }, { value: "dark", label: t("welcome.themeDark") }] })}</div>
          </div>`;
      },
      foot: () => ({ primary: { label: t("btn.start"), icon: "arrow-right" } }),
    },

    license: {
      render() {
        const text = i18n
          .license()
          .map(([h, p]) => `<h3>${esc(h)}</h3>${p ? `<p>${esc(p)}</p>` : ""}`)
          .join("");
        return `${head("license.title", esc(t("license.lead")))}
          <div class="license selectable" tabindex="0" role="region" aria-label="${esc(t("license.region"))}">${text}</div>
          <label class="check strong"><input type="checkbox" id="license-accept" data-bind="licenseAccepted" ${S.licenseAccepted ? "checked" : ""}><span>${esc(t("license.accept"))}</span></label>`;
      },
    },

    system: {
      enter() {
        if (!S.checks && !ui.checksRunning) runChecks();
      },
      render() {
        let body;
        if (ui.checksRunning) {
          body = `<div class="alert info" role="status">${icon("loader-circle", 16, "spin")}<div class="a-body"><b>${esc(t("system.running"))}</b></div></div>`;
        } else if (ui.checksError) {
          body = alertBox("crit", "octagon-alert", t("system.error", { message: ui.checksError }), "", 'role="alert"');
        } else if (S.checks) {
          const rows = S.checks
            .map(
              (c) => `<li><span class="mark ${c.status}">${icon(STATUS_ICON[c.status] || "circle", 16)}</span>
              <span class="c-body"><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></span>
              <span class="c-status">${esc(t("status." + c.status))}</span></li>`
            )
            .join("");
          const fails = S.checks.filter((c) => c.status === "fail").length;
          const warns = S.checks.filter((c) => c.status === "warn").length;
          const summary = fails
            ? alertBox("crit", "octagon-alert", t("system.blocking"), "", 'role="alert"')
            : warns
              ? alertBox("warn", "triangle-alert", t("system.warnings", { n: warns }), "", 'role="status"')
              : alertBox("ok", "circle-check", t("system.allOk"), "", 'role="status"');
          body = `<ul class="checks" aria-label="${esc(t("system.title"))}">${rows}</ul>${summary}`;
        } else body = "";
        const upgrade = isUpgrade() ? alertBox("info", "info", t("system.upgrade", { version: ctx.existing?.version ?? "" }), t("system.upgradeDetail")) : "";
        return `${head("system.title", esc(t("system.lead")))}
          ${upgrade}
          ${body}
          <div class="row"><button type="button" class="btn" data-action="rerun-checks" ${ui.checksRunning ? "disabled" : ""}>${icon("rotate-cw", 15)}${esc(t("system.rerun"))}</button></div>`;
      },
    },

    type: {
      render() {
        return `${head("type.title", esc(t("type.lead")))}
          ${radioGroup({
            id: "kind",
            bind: "kind",
            labelKey: "type.group",
            options: [
              { value: "production", icon: "factory", title: t("type.production"), desc: t("type.productionDesc") },
              { value: "demo", icon: "flask-conical", title: t("type.demo"), desc: t("type.demoDesc") },
            ],
          })}`;
      },
    },

    database: {
      render() {
        return `${head("db.title", esc(t("db.lead")))}
          ${radioGroup({
            id: "dbmode",
            bind: "dbMode",
            labelKey: "db.group",
            options: [
              { value: "embedded", icon: "database", title: t("db.embedded"), desc: t("db.embeddedDesc"), badge: t("common.recommended") },
              { value: "external", icon: "server", title: t("db.external"), desc: t("db.externalDesc") },
            ],
          })}`;
      },
    },

    "database-external": {
      render() {
        return `${head("dbx.title", esc(t("dbx.lead")))}
          <div class="grid dbx">
            ${field("db-host", "db.host", "dbx.host")}
            ${field("db-port", "db.port", "dbx.port", { inputmode: "numeric" })}
          </div>
          <div class="grid two">
            ${field("db-name", "db.database", "dbx.database")}
            ${field("db-user", "db.user", "dbx.user", { autocomplete: "username" })}
            ${field("db-password", "db.password", "dbx.password", { type: "password", autocomplete: "current-password" })}
          </div>
          <label class="check"><input type="checkbox" id="db-ssl" data-bind="db.ssl" ${S.db.ssl ? "checked" : ""}><span>${esc(t("dbx.ssl"))}</span></label>
          <div class="row"><button type="button" class="btn" id="db-test" data-action="test-db">${ui.dbTesting ? icon("loader-circle", 15, "spin") : icon("database", 15)}${esc(t(ui.dbTesting ? "dbx.testing" : "dbx.test"))}</button></div>
          <div id="dbx-result" aria-live="polite">${dbResultHtml()}</div>`;
      },
      update() {
        applyErrors({ "db-port": shown("db-port") && !L.isValidPort(S.db.port) ? t("dbx.portInvalid") : null });
        $("#dbx-result").innerHTML = dbResultHtml();
        $("#db-test").disabled = ui.dbTesting || !L.dbFormValid(S.db);
      },
      onEnterKey() {
        // Enter runs the test until it passes for these values, then continues.
        if (!L.screenValid("database-external", S) && L.dbFormValid(S.db) && !ui.dbTesting) {
          testDatabase();
          return true;
        }
        return false;
      },
    },

    organisation: {
      render() {
        const o = S.org;
        const countries = L.COUNTRIES.map((c) => ({ code: c.code, name: i18n.countryName(c.code) })).sort((a, b) => a.name.localeCompare(b.name, i18n.getLang()));
        const countryOptions = `<option value="" ${o.country ? "" : "selected"} disabled>${esc(t("org.countryPlaceholder"))}</option>` + countries.map((c) => `<option value="${c.code}" ${o.country === c.code ? "selected" : ""}>${esc(c.name)}</option>`).join("");
        const currencyOptions = `<option value="" ${o.currency ? "" : "selected"} disabled>—</option>` + L.CURRENCIES.map((c) => `<option ${o.currency === c ? "selected" : ""}>${c}</option>`).join("");
        const zones = [...new Set(L.COUNTRIES.map((c) => c.timezone).concat("UTC"))].sort();
        const rows = o.sites
          .map((s, i) => {
            const n = i + 1;
            const cell = (key, labelKey, extra = "") => `<input class="input" id="site-${i}-${key}" data-bind="org.sites.${i}.${key}" aria-label="${esc(t(labelKey))} (${esc(t("org.siteN", { n }))})" aria-describedby="site-${i}-err" value="${esc(s[key])}" autocomplete="off" spellcheck="false" ${extra}>`;
            return `<div class="site-row" role="group" aria-label="${esc(t("org.siteN", { n }))}">
              ${cell("name", "org.siteName")}${cell("city", "org.siteCity")}${cell("lat", "org.siteLat", 'inputmode="decimal" placeholder="5.6037"')}${cell("lon", "org.siteLon", 'inputmode="decimal" placeholder="-0.1870"')}
              <button type="button" class="icon-btn" data-action="remove-site" data-index="${i}" aria-label="${esc(t("org.removeSite", { n }))}" title="${esc(t("org.removeSite", { n }))}">${icon("trash-2", 15)}</button>
              <span class="site-err" id="site-${i}-err"></span>
            </div>`;
          })
          .join("");
        return `${head("org.title", esc(t("org.lead")))}
          <div class="grid two">
            ${field("org-name", "org.name", "org.name", { cls: "", autocomplete: "organization" })}
            <div class="field"><label class="label" for="org-country">${esc(t("org.country"))}</label>
              <select class="input" id="org-country" data-bind="org.country" data-rerender="country">${countryOptions}</select></div>
            <div class="field"><label class="label" for="org-currency">${esc(t("org.currency"))}</label>
              <select class="input" id="org-currency" data-bind="org.currency" aria-describedby="org-deduced">${currencyOptions}</select>
              <span class="help" id="org-deduced">${esc(t("org.timezoneHint"))}</span></div>
            ${field("org-tz", "org.timezone", "org.timezone", { list: "tz-list" })}
          </div>
          <datalist id="tz-list">${zones.map((z) => `<option value="${z}">`).join("")}</datalist>
          <div class="section">
            <h2>${esc(t("org.sites"))}</h2>
            <span class="help">${esc(t("org.sitesHint"))}</span>
            <div class="sites">
              ${o.sites.length ? `<div class="site-row site-head" aria-hidden="true"><span>${esc(t("org.siteName"))}</span><span>${esc(t("org.siteCity"))}</span><span>${esc(t("org.siteLat"))}</span><span>${esc(t("org.siteLon"))}</span><span></span></div>` : ""}
              ${rows}
            </div>
            <div class="row"><button type="button" class="btn sm" data-action="add-site">${icon("plus", 14)}${esc(t("org.addSite"))}</button></div>
          </div>`;
      },
      update() {
        applyErrors({ "org-tz": shown("org-tz") && S.org.timezone && !L.isValidTimezone(S.org.timezone) ? t("org.timezoneInvalid") : null });
        S.org.sites.forEach((s, i) => {
          const res = L.validateSite(s);
          const keys = ["name", "city", "lat", "lon"];
          // Only complain about a row once the user has left one of its fields.
          const visible = keys.some((k) => shown(`site-${i}-${k}`));
          const msgs = visible ? [...new Set(Object.values(res.errors))].map((code) => t("org.err." + code)) : [];
          const slot = document.getElementById(`site-${i}-err`);
          if (slot) slot.innerHTML = msgs.length ? errHtml(msgs.join(" ")) : "";
          keys.forEach((k) => document.getElementById(`site-${i}-${k}`)?.setAttribute("aria-invalid", visible && res.errors[k] ? "true" : "false"));
        });
      },
    },

    sources: {
      render() {
        const v = S.sources.vehicles;
        return `${head("src.title", esc(t("src.lead")))}
          <div class="section">
            <h2>${esc(t("src.vehicles"))}</h2>
            ${radioGroup({
              id: "veh",
              bind: "sources.vehicles",
              labelKey: "src.vehicles",
              kind: "pill",
              options: [
                { value: "live", icon: "radio", title: t("src.live") },
                { value: "simulation", icon: "monitor-play", title: t("src.simulation") },
              ],
            })}
            <span class="help">${esc(t(v === "live" ? "src.liveDesc" : "src.simulationDesc"))}</span>
          </div>
          <div class="section">
            <h2>${esc(t("src.ships"))}</h2>
            ${field("src-ais", "sources.aisStreamKey", "src.aisKey", { type: "password", optional: true, help: esc(t("src.aisHint")).replace("aisstream.io", '<a href="https://aisstream.io" data-external>aisstream.io</a>') })}
          </div>
          <div class="section">
            <h2>${esc(t("src.planes"))}</h2>
            <div class="grid two">
              ${field("src-os-id", "sources.openskyClientId", "src.openskyId", { optional: true })}
              ${field("src-os-secret", "sources.openskyClientSecret", "src.openskySecret", { type: "password", optional: true })}
            </div>
            <span class="help">${esc(t("src.openskyHint"))}</span>
          </div>
          <div class="section">
            <h2>${esc(t("src.traffic"))}</h2>
            ${field("src-tomtom", "sources.tomtomKey", "src.tomtomKey", { type: "password", optional: true, help: esc(t("src.tomtomHint")) })}
          </div>`;
      },
    },

    admin: {
      render() {
        return `${head("admin.title", esc(t("admin.lead")))}
          <div class="grid two">
            ${field("adm-first", "admin.firstName", "admin.firstName", { autocomplete: "given-name" })}
            ${field("adm-last", "admin.lastName", "admin.lastName", { autocomplete: "family-name" })}
            ${field("adm-email", "admin.email", "admin.email", { type: "email", autocomplete: "email", cls: "span2" })}
            ${field("adm-pw", "admin.password", "admin.password", { type: "password", autocomplete: "new-password" })}
            ${field("adm-confirm", "admin.confirm", "admin.confirm", { type: "password", autocomplete: "new-password" })}
          </div>
          <ul class="rules" id="pw-rules" aria-label="${esc(t("admin.rules"))}"></ul>`;
      },
      update() {
        const a = S.admin;
        const r = L.passwordRules(a.password);
        const match = a.confirm !== "" && a.password === a.confirm;
        const rule = (met, text) => `<li class="${met ? "met" : ""}"><span class="mark">${icon(met ? "check" : "circle", 14)}</span><span>${esc(text)}</span><span class="sr-only">(${esc(t(met ? "admin.ruleMet" : "admin.ruleUnmet"))})</span></li>`;
        $("#pw-rules").innerHTML = rule(r.length, t("admin.rule.length")) + rule(r.variety, t("admin.rule.variety", { n: r.classes })) + rule(match, t("admin.rule.match"));
        $("#adm-pw").setAttribute("aria-describedby", "adm-pw-err pw-rules");
        applyErrors({
          "adm-email": shown("adm-email") && !L.isValidEmail(a.email) ? t("admin.emailInvalid") : null,
          "adm-confirm": shown("adm-confirm") && a.confirm && !match ? t("admin.rule.match") + colon() + t("admin.ruleUnmet") : null,
        });
      },
    },

    summary: {
      render() {
        const block = (title, bodyHtml, target) => `<div class="sum-block"><span class="s-title">${esc(title)}</span><div class="s-body">${bodyHtml}</div>
          ${target && !isUpgrade() ? `<button type="button" class="btn sm" data-action="modify" data-target="${target}" aria-label="${esc(t("btn.modify") + colon() + title)}">${icon("pencil", 13)}${esc(t("btn.modify"))}</button>` : "<span></span>"}</div>`;
        const dir = ctx.existing?.dir || ctx.defaultInstallDir;
        const blocks = [
          block(
            t("sum.install"),
            `${isUpgrade() ? `<span>${esc(t("sum.upgradeFrom", { from: ctx.existing?.version ?? "", to: ctx.version }))}</span>` : `<span>SCIP ${esc(ctx.version)}</span>`}
             <span class="sub selectable">${esc(t("sum.dir") + colon() + dir)}</span>
             <span class="sub">${esc(t("sum.bytes", { n: formatMB(ctx.payloadBytes) }))}</span>`
          ),
        ];
        if (!isUpgrade()) {
          blocks.push(block(t("step.type"), `<span>${esc(t(S.kind === "demo" ? "type.demo" : "type.production"))}</span>`, "type"));
          const d = S.db;
          blocks.push(block(t("step.database"), `<span>${esc(S.dbMode === "external" ? t("sum.external", { user: d.user, host: d.host, port: d.port, database: d.database, ssl: d.ssl ? " · SSL" : "" }) : t("sum.embedded"))}</span>`, "database"));
          if (S.kind === "production") {
            const o = S.org;
            const sites = o.sites.filter((s) => !L.isBlankSite(s));
            blocks.push(
              block(
                t("step.organisation"),
                `<span>${esc(o.name)}</span><span class="sub">${esc(i18n.countryName(o.country))} · ${esc(o.currency)} · ${esc(o.timezone)}</span>
                 <span class="sub">${sites.length ? esc(t("sum.sites", { n: sites.length }) + colon()) + esc(sites.map((s) => s.name).join(", ")) : esc(t("sum.noSites"))}</span>`,
                "organisation"
              )
            );
          }
          const src = S.sources;
          const keys = [src.aisStreamKey.trim() && "AISStream", src.openskyClientId.trim() && "OpenSky", src.tomtomKey.trim() && "TomTom"].filter(Boolean);
          blocks.push(
            block(
              t("step.sources"),
              `<span>${esc(t(src.vehicles === "live" ? "src.live" : "src.simulation"))}</span>
               <span class="sub">${esc(t("sum.keys") + colon())}${esc(keys.length ? keys.join(", ") : t("common.none"))}${src.openskyClientId.trim() ? "" : " · " + esc(t("sum.anonymous"))}</span>`,
              "sources"
            )
          );
          if (S.kind === "production") {
            const a = S.admin;
            blocks.push(block(t("step.admin"), `<span>${esc(t("sum.adminLine", { first: a.firstName, last: a.lastName, email: a.email }))}</span><span class="sub">${"•".repeat(12)}</span>`, "admin"));
          }
        }
        return `${head("sum.title", esc(t(isUpgrade() ? "sum.leadUpgrade" : "sum.lead")))}<div class="sum">${blocks.join("")}</div>`;
      },
      foot: () => ({ primary: { label: t(isUpgrade() ? "btn.update" : "btn.install"), action: startInstall, icon: "arrow-right" } }),
    },

    install: {
      render() {
        const title = isUninstall() ? "inst.titleUninstall" : isUpgrade() ? "inst.titleUpgrade" : "inst.title";
        return `${head(title, esc(t("inst.lead")))}${progressHtml()}${stepsHtml()}${journalHtml(false)}`;
      },
      foot: () => ({ back: false, primary: null, hint: "" }),
    },

    "install-error": {
      render() {
        const e = ui.error || {};
        const failed = ui.steps.find((s) => s.id === e.step);
        return `${head(isUninstall() ? "un.errTitle" : "err.title", esc(t("err.lead")))}
          <div class="alert crit" role="alert">${icon("octagon-alert", 16)}<div class="a-body"><b>${esc(e.message || "")}</b>
            <span class="mono" style="font-size:11px;letter-spacing:.04em">${esc(t("err.at", { step: failed ? stepLabel(failed) : e.step || "?", code: e.code || "?" }))}</span></div></div>
          ${e.retryable === false ? alertBox("warn", "triangle-alert", t("err.notRetryable"), "") : ""}
          ${progressHtml(true)}${stepsHtml()}${journalHtml(true)}`;
      },
      foot: () => ({
        back: false,
        extra: [
          { label: t("btn.close"), action: () => engine.close() },
          { label: t(ui.journalOpen ? "btn.hideLog" : "btn.viewLog"), icon: "file-text", action: viewFullLog, id: "view-log" },
        ],
        primary: ui.error?.retryable === false ? null : { label: t("btn.retry"), icon: "rotate-cw", action: retry },
      }),
    },

    done: {
      render() {
        const demo = S.kind === "demo" && !isUpgrade();
        return `<div class="success-mark">${icon("circle-check", 24)}</div>
          ${head(isUpgrade() ? "done.titleUpgrade" : "done.title", esc(t("done.lead")))}
          <ol class="next">
            <li>${esc(t(demo ? "done.next1Demo" : "done.next1"))}</li>
            <li>${esc(t("done.next2"))}</li>
            <li>${esc(t("done.next3"))}</li>
          </ol>
          <label class="check"><input type="checkbox" id="desktop-shortcut" data-bind="desktopShortcut" ${S.desktopShortcut ? "checked" : ""}><span>${esc(t("done.shortcut"))}</span></label>`;
      },
      foot: () => ({ back: false, extra: [{ label: t("btn.close"), action: () => engine.close() }], primary: { label: t("btn.openScip"), icon: "arrow-right", action: launch } }),
    },

    // ---- Uninstall mode ----
    "un-confirm": {
      render() {
        const warn = ui.removeData
          ? alertBox("crit", "triangle-alert", t("un.warn"), t("un.warnDetail"), 'role="alert"')
          : alertBox("info", "info", t("un.keep"), "");
        return `${head("un.title", esc(t("un.lead", { version: ctx.existing?.version || ctx.version })))}
          <div class="meta"><div class="meta-row">${icon("package", 16)}<span class="selectable">${esc(ctx.existing?.dir || ctx.defaultInstallDir)}</span></div></div>
          <label class="check strong"><input type="checkbox" id="remove-data" data-ui="removeData" ${ui.removeData ? "checked" : ""} aria-describedby="remove-data-hint">
            <span style="display:flex;flex-direction:column;gap:2px"><span>${esc(t("un.removeData"))}</span><span class="help" id="remove-data-hint" style="font-weight:400">${esc(t("un.removeDataHint", { dir: DATA_DIR }))}</span></span></label>
          <div id="un-warn">${warn}</div>`;
      },
      foot: () => ({ back: false, extra: [{ label: t("btn.close"), action: () => engine.close() }], primary: { label: t("un.confirm"), icon: "trash-2", action: startUninstall } }),
    },
    "un-done": {
      render() {
        return `<div class="success-mark">${icon("circle-check", 24)}</div>
          ${head("un.doneTitle", esc(t("un.doneLead")))}
          ${alertBox("info", "info", ui.removeData ? t("un.doneRemoved") : t("un.doneKept", { dir: DATA_DIR }), "")}`;
      },
      foot: () => ({ back: false, primary: { label: t("btn.close"), action: () => engine.close() } }),
    },
  };
  // Uninstall progress/error reuse the install screens (same events, different titles).
  views["un-progress"] = views.install;
  views["un-error"] = views["install-error"];

  // ---- Fragments shared by 10 / 10b ----

  function progressHtml(failed = false) {
    const pct = Math.round(ui.fraction * 100);
    return `<div class="progress">
      <div class="progress-top"><span class="detail" id="prog-detail">${esc(ui.detail)}</span><span class="mono" id="prog-pct">${esc(t("inst.percent", { p: pct }))}</span></div>
      <div class="bar ${failed ? "failed" : ""}" role="progressbar" id="prog-bar" aria-label="${esc(t("inst.progress"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i id="prog-fill" style="width:${pct}%"></i></div>
    </div>`;
  }

  function stepsHtml() {
    const items = ui.steps
      .map((s) => {
        const mk = s.status === "running" ? icon("loader-circle", 16, "spin") : s.status === "done" ? icon("check", 16) : s.status === "failed" ? icon("x", 16) : icon("circle", 14);
        const cls = { done: "ok", failed: "fail", running: "running", pending: "pending" }[s.status] || "pending";
        return `<li class="${s.status}"><span class="mark ${cls}">${mk}</span><span>${esc(stepLabel(s))}</span><span class="st">${esc(t("inst.status." + s.status))}</span></li>`;
      })
      .join("");
    return `<ul class="isteps" id="isteps">${items}</ul>`;
  }

  function journalHtml(tall) {
    const text = ui.fullLog ?? ui.log.join("\n");
    return `<div class="journal">
      ${screen === "install" || screen === "un-progress" ? `<button type="button" class="btn sm" style="align-self:flex-start" data-action="toggle-journal" aria-expanded="${ui.journalOpen}" aria-controls="journal">${icon("chevron-down", 14)}${esc(t("inst.journal"))}</button>` : ""}
      <pre id="journal" class="${tall ? "tall" : ""}" tabindex="0" aria-label="${esc(t(tall ? "err.logTitle" : "inst.journal"))}" ${ui.journalOpen ? "" : "hidden"}>${esc(text)}</pre>
    </div>`;
  }

  function dbResultHtml() {
    const tst = ui.dbTesting ? null : S.dbTest;
    if (ui.dbTesting) return "";
    if (!tst) return `<span class="help">${esc(t("dbx.needTest"))}</span>`;
    if (tst.key !== L.dbTestKey(S.db)) return alertBox("info", "info", t("dbx.stale"), "");
    const r = tst.result;
    if (!r.ok) return alertBox("crit", "octagon-alert", t("dbx.failed"), r.message || "");
    if (r.postgis === "missing") return alertBox("crit", "octagon-alert", t("dbx.postgisMissing"), t("dbx.postgisMissingDetail"));
    if (r.canCreate === false) return alertBox("crit", "octagon-alert", t("dbx.noCreate"), t("dbx.noCreateDetail", { user: S.db.user, database: S.db.database }));
    return alertBox("ok", "circle-check", t("dbx.ok"), t("dbx.okDetail", { version: r.serverVersion || "?", postgis: t("dbx.postgis." + r.postgis) }));
  }

  // -----------------------------------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------------------------------

  const body = () => $("#body");

  function railItems() {
    if (isUninstall()) {
      const cur = { "un-confirm": 0, "un-progress": 1, "un-error": 1, "un-done": 2 }[screen];
      return ["un.rail.confirm", "un.rail.progress", "un.rail.done"].map((key, i) => ({
        label: t(key),
        state: i < cur ? "done" : i > cur ? "pending" : screen === "un-error" ? "failed" : "current",
      }));
    }
    // Steps that do not apply (update: 04–08, demo: 06 and 08) are left out rather than listed
    // as skipped: a column of "sauté" read as unfinished work.
    const rail = L.visibleRail(S);
    const cur = rail.indexOf(L.SCREENS[screen].rail);
    return rail.map((id, i) => {
      let state = "pending";
      if (i === cur) state = screen === "install-error" ? "failed" : "current";
      else if (i < cur) state = "done";
      return { label: t("step." + id), state };
    });
  }

  function renderRail() {
    $("#steps").innerHTML = railItems()
      .map((it, i) => {
        const mk = it.state === "done" ? icon("check", 13) : it.state === "failed" ? icon("x", 13) : it.state === "skipped" ? "–" : String(i + 1);
        const cls = it.state === "failed" ? "current failed" : it.state;
        const sr = it.state === "done" ? t("rail.done") : it.state === "skipped" ? t("rail.skipped") : it.state === "current" || it.state === "failed" ? t("rail.current") : "";
        return `<li class="${cls}" ${it.state === "current" || it.state === "failed" ? 'aria-current="step"' : ""}>
          <span class="mk" aria-hidden="true">${mk}</span><span class="lb">${esc(it.label)}</span>
          ${it.state === "skipped" ? `<span class="tag" aria-hidden="true">${esc(t("rail.skipped"))}</span>` : ""}
          ${sr ? `<span class="sr-only">(${esc(sr)})</span>` : ""}</li>`;
      })
      .join("");
    $("#version").textContent = ctx ? t("rail.version", { version: ctx.version }) : "";
  }

  /** Footer model → buttons. Defaults: Back if there is a previous screen, Continue = next. */
  let footModel = null;
  function renderFoot() {
    const v = views[screen];
    const m = Object.assign({ back: true, extra: [], primary: {} }, v.foot ? v.foot() : {});
    const prev = m.back ? L.prevScreen(screen, S) : null;
    if (m.primary) {
      m.primary = Object.assign({ label: t("btn.continue"), action: next, enabled: () => L.screenValid(screen, S) }, m.primary);
      if (!m.primary.enabled) m.primary.enabled = () => true;
    }
    footModel = { ...m, prev };
    // The install screen has no actions: drop the empty bar rather than show a blank strip.
    $("#foot").hidden = !prev && !m.primary && !(m.extra || []).length && !m.hint;
    const extra = (m.extra || []).map((b, i) => `<button type="button" class="btn" data-foot="extra-${i}" ${b.id ? `id="${b.id}"` : ""}>${b.icon ? icon(b.icon, 15) : ""}${esc(b.label)}</button>`).join("");
    $("#foot").innerHTML = `
      ${prev ? `<button type="button" class="btn" data-foot="back">${icon("arrow-left", 15)}${esc(t("btn.back"))}</button>` : ""}
      ${m.hint ? `<span class="hint">${esc(m.hint)}</span>` : ""}
      <span class="spacer"></span>
      ${extra}
      ${m.primary ? `<button type="button" class="btn primary" id="primary" data-foot="primary">${esc(m.primary.label)}${m.primary.icon ? icon(m.primary.icon, 16) : ""}</button>` : ""}`;
    updateFoot();
  }

  function updateFoot() {
    const btn = $("#primary");
    if (btn && footModel?.primary) btn.disabled = ui.busy || !footModel.primary.enabled();
  }

  /** Full re-render of the current screen; keeps focus and caret on the same control. */
  function rerender() {
    if (!ctx) return;
    const active = document.activeElement;
    const focusId = active && active.id && body().contains(active) ? active.id : null;
    const caret = focusId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    renderRail();
    body().innerHTML = views[screen].render();
    views[screen].update?.();
    renderFoot();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && typeof el.setSelectionRange === "function") {
          try {
            el.setSelectionRange(caret[0], caret[1]);
          } catch {
            /* some input types (email) do not support selection ranges */
          }
        }
      }
    }
  }

  function announce(text) {
    const a = $("#announcer");
    a.textContent = "";
    // A tick later so repeated identical messages are still announced.
    setTimeout(() => (a.textContent = text), 30);
  }

  /** Shows a screen, moves focus to its title and runs its enter() hook. */
  function goto(next) {
    screen = next;
    ui.touched.clear();
    body().scrollTop = 0;
    rerender();
    const h = $("#screen-title");
    if (h) h.focus({ preventScroll: true });
    announce(h ? h.textContent : "");
    views[screen].enter?.();
  }

  // -----------------------------------------------------------------------------------------------
  // Navigation and actions
  // -----------------------------------------------------------------------------------------------

  function next() {
    if (!L.screenValid(screen, S)) return;
    if (fromSummary) {
      // After "Modifier": pass through the external DB sub-screen if needed, then back to the
      // summary unless a step became required and is not filled in yet.
      if (screen === "database" && S.dbMode === "external") return goto("database-external");
      const invalid = L.firstInvalidScreen(S);
      if (invalid) return goto(invalid);
      fromSummary = false;
      return goto("summary");
    }
    const n = L.nextScreen(screen, S);
    if (n) goto(n);
  }

  function back() {
    const p = L.prevScreen(screen, S);
    if (p) goto(p);
  }

  async function runChecks() {
    ui.checksRunning = true;
    ui.checksError = null;
    rerender();
    try {
      S.checks = await cmd.runSystemChecks();
    } catch (e) {
      S.checks = null;
      ui.checksError = errMessage(e);
    } finally {
      ui.checksRunning = false;
      if (screen === "system") {
        rerender();
        announce(S.checks ? t(L.checksPass(S.checks) ? "system.allOk" : "system.blocking") : ui.checksError || "");
      }
    }
  }

  async function testDatabase() {
    if (ui.dbTesting || !L.dbFormValid(S.db)) return;
    ui.dbTesting = true;
    const key = L.dbTestKey(S.db);
    const input = { host: S.db.host.trim(), port: Number(String(S.db.port).trim()), database: S.db.database.trim(), user: S.db.user.trim(), password: S.db.password, ssl: !!S.db.ssl };
    rerender();
    let result;
    try {
      result = await cmd.testDatabase(input);
    } catch (e) {
      result = { ok: false, message: errMessage(e) };
    }
    S.dbTest = { key, result };
    ui.dbTesting = false;
    if (screen === "database-external") {
      rerender();
      $("#dbx-result")?.scrollIntoView({ block: "nearest" });
    }
  }

  async function startInstall() {
    if (ui.busy) return;
    const plan = L.buildPlan(S);
    fromSummary = false;
    ui.steps = ["extract", "shortcuts", "register", "provision", "finish"].map((id) => ({ id, status: "pending", label: "" }));
    Object.assign(ui, { fraction: 0, detail: "", log: [], fullLog: null, error: null, journalOpen: false });
    goto("install");
    try {
      await cmd.startInstall(plan);
    } catch (e) {
      onError({ step: "extract", code: e?.code || "START_FAILED", message: errMessage(e), retryable: false });
    }
  }

  async function retry() {
    if (ui.busy) return;
    ui.busy = true;
    const failed = ui.steps.find((s) => s.status === "failed");
    if (failed) failed.status = "pending";
    ui.error = null;
    ui.fullLog = null;
    ui.journalOpen = false;
    goto(isUninstall() ? "un-progress" : "install");
    try {
      if (isUninstall()) await cmd.startUninstall(ui.removeData);
      else await cmd.retryInstall();
    } catch (e) {
      onError({ step: failed?.id || "", code: e?.code || "RETRY_FAILED", message: errMessage(e), retryable: true });
    } finally {
      ui.busy = false;
      updateFoot();
    }
  }

  async function viewFullLog() {
    ui.journalOpen = !ui.journalOpen;
    if (ui.journalOpen) {
      try {
        ui.fullLog = await cmd.readLog();
      } catch (e) {
        ui.fullLog = ui.log.join("\n") + "\n" + errMessage(e);
      }
    }
    rerender();
    const pre = $("#journal");
    if (pre && ui.journalOpen) {
      pre.scrollTop = pre.scrollHeight;
      pre.focus();
    } else $("#view-log")?.focus();
  }

  async function launch() {
    if (ui.busy) return;
    ui.busy = true;
    updateFoot();
    try {
      await cmd.launchScip(!!S.desktopShortcut);
      if (engine.mock) engine.close();
    } catch (e) {
      ui.busy = false;
      updateFoot();
      announce(errMessage(e));
    }
  }

  async function startUninstall() {
    if (ui.busy) return;
    ui.steps = [];
    Object.assign(ui, { fraction: 0, detail: "", log: [], fullLog: null, error: null, journalOpen: false });
    goto("un-progress");
    try {
      await cmd.startUninstall(ui.removeData);
    } catch (e) {
      onError({ step: "", code: e?.code || "START_FAILED", message: errMessage(e), retryable: true });
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Engine events (install://*). Patched in place: progress can arrive many times per second.
  // -----------------------------------------------------------------------------------------------

  const onProgressScreen = () => ["install", "un-progress", "install-error", "un-error"].includes(screen);

  function onStep(p) {
    let s = ui.steps.find((x) => x.id === p.id);
    if (!s) ui.steps.push((s = { id: p.id, status: "pending", label: "" }));
    s.status = p.status;
    s.label = p.label || s.label;
    if (!onProgressScreen()) return;
    const list = $("#isteps");
    if (list) list.outerHTML = stepsHtml();
    const key = { running: "inst.announceRunning", done: "inst.announceDone", failed: "inst.announceFailed" }[p.status];
    if (key) announce(t(key, { label: stepLabel(s) }));
  }

  function onProgress(p) {
    ui.fraction = Math.max(0, Math.min(1, Number(p.fraction) || 0));
    ui.detail = p.detail || "";
    const pct = Math.round(ui.fraction * 100);
    const fill = $("#prog-fill");
    if (!fill) return;
    fill.style.width = pct + "%";
    $("#prog-bar").setAttribute("aria-valuenow", pct);
    $("#prog-pct").textContent = t("inst.percent", { p: pct });
    $("#prog-detail").textContent = ui.detail;
  }

  function onLog(p) {
    ui.log.push(p.line);
    const pre = $("#journal");
    if (!pre || ui.fullLog !== null) return;
    // Follow the tail only if the reader is already at the bottom (do not yank them back).
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.append((pre.textContent ? "\n" : "") + p.line);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function onError(p) {
    ui.error = p || { message: "?" };
    const s = ui.steps.find((x) => x.id === ui.error.step);
    if (s) s.status = "failed";
    // Collapsed on 10b: "Voir le journal" then fetches the complete log with read_log.
    ui.journalOpen = false;
    ui.fullLog = null;
    goto(isUninstall() ? "un-error" : "install-error");
  }

  function onDone() {
    for (const s of ui.steps) s.status = "done";
    goto(isUninstall() ? "un-done" : "done");
  }

  // -----------------------------------------------------------------------------------------------
  // DOM events (delegated)
  // -----------------------------------------------------------------------------------------------

  const actions = {
    choose(el) {
      const bind = el.dataset.bind;
      const value = el.dataset.value;
      if (getPath(S, bind) === value) return;
      setPath(S, bind, value);
      // A new installation type implies the matching vehicle source, unless the user already chose one.
      if (bind === "sources.vehicles") ui.vehiclesChosen = true;
      if (bind === "kind" && !ui.vehiclesChosen) S.sources.vehicles = value === "demo" ? "simulation" : "live";
      rerender();
    },
    "set-lang": (el) => setLang(el.dataset.value),
    "set-theme": (el) => setTheme(el.dataset.value),
    "toggle-pw"(el) {
      const id = el.dataset.target;
      ui.showPw[id] = !ui.showPw[id];
      const input = document.getElementById(id);
      input.type = ui.showPw[id] ? "text" : "password";
      el.setAttribute("aria-pressed", String(ui.showPw[id]));
      const label = t(ui.showPw[id] ? "common.hidePassword" : "common.showPassword");
      el.setAttribute("aria-label", label);
      el.title = label;
      el.innerHTML = icon(ui.showPw[id] ? "eye-off" : "eye", 16);
    },
    "rerun-checks": () => runChecks(),
    "test-db": () => testDatabase(),
    "add-site"() {
      S.org.sites.push({ name: "", city: "", lat: "", lon: "" });
      rerender();
      document.getElementById(`site-${S.org.sites.length - 1}-name`)?.focus();
    },
    "remove-site"(el) {
      const i = Number(el.dataset.index);
      S.org.sites.splice(i, 1);
      // Drop "touched" marks: row indexes shift after a removal.
      [...ui.touched].filter((k) => k.startsWith("site-")).forEach((k) => ui.touched.delete(k));
      rerender();
      const target = document.getElementById(`site-${Math.min(i, S.org.sites.length - 1)}-name`) || $('[data-action="add-site"]');
      target?.focus();
    },
    modify(el) {
      fromSummary = true;
      goto(el.dataset.target);
    },
    "toggle-journal"(el) {
      ui.journalOpen = !ui.journalOpen;
      el.setAttribute("aria-expanded", String(ui.journalOpen));
      const pre = $("#journal");
      pre.hidden = !ui.journalOpen;
      if (ui.journalOpen) pre.scrollTop = pre.scrollHeight;
    },
  };

  function onClick(e) {
    const ext = e.target.closest("a[data-external]");
    if (ext) {
      e.preventDefault();
      engine.openExternal(ext.href);
      return;
    }
    const f = e.target.closest("[data-foot]");
    if (f && !f.disabled) {
      const k = f.dataset.foot;
      if (k === "back") back();
      else if (k === "primary") footModel.primary.enabled() && footModel.primary.action();
      else if (k.startsWith("extra-")) footModel.extra[Number(k.slice(6))].action();
      return;
    }
    const a = e.target.closest("[data-action]");
    if (a && !a.disabled && actions[a.dataset.action]) actions[a.dataset.action](a);
  }

  function valueOf(el) {
    return el.type === "checkbox" ? el.checked : el.value;
  }

  function onInput(e) {
    const el = e.target;
    if (el.dataset.ui) {
      ui[el.dataset.ui] = valueOf(el);
      rerender();
      return;
    }
    if (!el.dataset.bind) return;
    setPath(S, el.dataset.bind, valueOf(el));
    if (el.dataset.rerender === "country") {
      // Currency and time zone follow the country; the user can still change them afterwards.
      const c = L.countryByCode(S.org.country);
      if (c) Object.assign(S.org, { currency: c.currency, timezone: c.timezone });
      rerender();
      return;
    }
    views[screen].update?.();
    updateFoot();
  }

  function onFocusOut(e) {
    const id = e.target.id;
    if (!id || !(e.target.dataset.bind || e.target.dataset.err)) return;
    if (e.target.value === "" && !ui.touched.has(id) && !/^site-/.test(id)) return; // untouched empty field: no nagging
    ui.touched.add(id);
    views[screen].update?.();
  }

  function onKeydown(e) {
    const el = e.target;
    // Arrow keys move and select within a radio group (WAI-ARIA radio pattern).
    if (el.getAttribute && el.getAttribute("role") === "radio" && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      const group = [...el.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')];
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const target = group[(group.indexOf(el) + dir + group.length) % group.length];
      e.preventDefault();
      target.focus();
      target.click();
      return;
    }
    // Enter in a field submits the step (Continue) when it is valid.
    if (e.key === "Enter" && !e.isComposing && (el.tagName === "INPUT" || el.tagName === "SELECT")) {
      e.preventDefault();
      if (views[screen].onEnterKey?.()) return;
      const p = footModel?.primary;
      if (p && !ui.busy && p.enabled()) p.action();
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------------------------------

  /** Mock only: fills earlier screens so ?step=N shows a realistic state. */
  async function prefillForJump(target) {
    S.licenseAccepted = true;
    S.checks = await cmd.runSystemChecks();
    S.kind = "production";
    S.dbMode = target === "database-external" ? "external" : "embedded";
    S.org = { name: "Accra Foods Distribution", country: "GH", currency: "GHS", timezone: "Africa/Accra", sites: [{ name: "Entrepôt Tema", city: "Tema", lat: "5.6698", lon: "-0.0166" }, { name: "Dépôt Kumasi", city: "Kumasi", lat: "", lon: "" }] };
    S.admin = { firstName: "Ama", lastName: "Mensah", email: "ama.mensah@accrafoods.com.gh", password: "Accra-Foods-2026", confirm: "Accra-Foods-2026" };
  }

  async function boot() {
    const forced = (k, allowed) => (engine.mock && allowed.includes(params.get(k)) ? params.get(k) : null);
    const storedTheme = forced("theme", ["light", "dark"]) || store.get(THEME_KEY);
    applyTheme(storedTheme || (darkQuery?.matches ? "dark" : "light"));
    darkQuery?.addEventListener?.("change", (q) => {
      if (store.get(THEME_KEY)) return; // an explicit choice wins over the system setting
      applyTheme(q.matches ? "dark" : "light");
      if (screen === "welcome") rerender();
    });

    const storedLang = forced("lang", ["fr", "en"]) || store.get(LANG_KEY);
    i18n.setLang(storedLang || ((navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en"));

    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeydown);
    $("#lang-toggle").addEventListener("click", () => setLang(i18n.getLang() === "fr" ? "en" : "fr"));
    $("#theme-toggle").addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));

    // Listen before anything can start so no early event is lost.
    await Promise.all([
      engine.listen("install://step", onStep),
      engine.listen("install://progress", onProgress),
      engine.listen("install://log", onLog),
      engine.listen("install://error", onError),
      engine.listen("install://done", onDone),
    ]);

    try {
      ctx = await cmd.getContext();
    } catch (e) {
      ctx = { mode: "install", version: "?", existing: null, locale: i18n.getLang(), payloadBytes: 0, defaultInstallDir: "" };
      console.error("get_context failed", e);
    }
    S = L.initialState(ctx.mode === "uninstall" ? "install" : ctx.mode);
    if (!storedLang && !navigator.language && ctx.locale) i18n.setLang(ctx.locale);

    const banner = $("#mock-banner");
    banner.hidden = !engine.mock;

    applyLang(i18n.getLang()); // applies strings to the static shell
    if (isUninstall()) return goto("un-confirm");

    const jump = engine.mock ? L.screenFromParam(params.get("step")) : null;
    if (jump && jump !== "welcome") {
      await prefillForJump(jump);
      if (["install", "install-error", "done"].includes(jump)) return startInstall();
      return goto(jump);
    }
    goto("welcome");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
