// Startup screen. Shows supervisor progress and errors; once the API is ready, the real UI
// (static export of apps/web, see README) takes over. No bundler: Tauri's global API.
(function () {
  'use strict';

  var tauri = window.__TAURI__;
  var stepsEl = document.getElementById('steps');
  var rows = {};

  function setStep(progress) {
    var row = rows[progress.step];
    if (!row) {
      row = document.createElement('li');
      rows[progress.step] = row;
      stepsEl.appendChild(row);
    }
    row.textContent = progress.label;
    row.dataset.status = progress.status;
  }

  function showError(error) {
    document.getElementById('headline').textContent = 'Démarrage impossible';
    document.getElementById('subline').textContent = 'SCIP n’a pas pu lancer ses services locaux.';
    document.getElementById('error-title').textContent = error.message;
    var list = document.getElementById('error-details');
    list.textContent = '';
    (error.details || []).forEach(function (line) {
      var item = document.createElement('li');
      item.textContent = line;
      list.appendChild(item);
    });
    document.getElementById('error-log').textContent = error.logFile ? 'Journal : ' + error.logFile : '';
    document.getElementById('error').hidden = false;
    Object.keys(rows).forEach(function (key) {
      if (rows[key].dataset.status === 'running') rows[key].dataset.status = 'failed';
    });
  }

  // Must match RUNTIME_KEY in apps/web/src/lib/runtime-config.ts.
  var RUNTIME_KEY = 'scip.runtime';
  var handedOver = false;

  function showReady(ready) {
    document.body.classList.add('is-live');
    document.getElementById('headline').textContent = 'SCIP est prêt';
    document.getElementById('subline').textContent = 'API locale : ' + ready.apiBaseUrl;
    openInterface(ready.apiBaseUrl);
  }

  // The API port is chosen at each launch, so the interface learns it from here rather than
  // at build time. Both pages share the webview origin, hence the same localStorage.
  function openInterface(apiBaseUrl) {
    if (handedOver) return;
    handedOver = true;
    var origin = new URL(apiBaseUrl).origin;
    window.localStorage.setItem(RUNTIME_KEY, JSON.stringify({ apiUrl: apiBaseUrl, wsUrl: origin }));
    // A short pause lets the live dot register; reduced motion skips it.
    var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(function () { window.location.replace('/'); }, calm ? 0 : 400);
  }

  function applySnapshot(snapshot) {
    snapshot.steps.forEach(setStep);
    if (snapshot.error) showError(snapshot.error);
    if (snapshot.ready) showReady(snapshot.ready);
  }

  if (!tauri) {
    showError({ message: 'Cette page doit être ouverte dans l’application SCIP.', details: [] });
    return;
  }

  var listen = tauri.event.listen;
  var invoke = tauri.core.invoke;

  // Subscribe first, then read the snapshot: events are recorded before being emitted, so
  // nothing emitted in between can be lost (at worst it is applied twice, which is harmless).
  Promise.all([
    listen('supervisor://progress', function (e) { setStep(e.payload); }),
    listen('supervisor://error', function (e) { showError(e.payload); }),
    listen('supervisor://ready', function (e) { showReady(e.payload); }),
  ])
    .then(function () { return invoke('get_startup_status'); })
    .then(applySnapshot)
    .then(function () { return invoke('get_runtime_info'); })
    .then(function (info) {
      document.getElementById('footer').textContent =
        'Version ' + info.version + (info.dataDir ? ' · Données : ' + info.dataDir : '');
    })
    .catch(function (err) { showError({ message: String(err), details: [] }); });
})();
