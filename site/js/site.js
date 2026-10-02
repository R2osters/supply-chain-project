/* SCIP — site vitrine · mouvement commun.
   Outils les moins chers d'abord : IntersectionObserver + CSS ; rAF
   seulement pour l'inclinaison des fenêtres et leur parallaxe.
   Révélations une seule fois, compteurs tabulaires, mouvement réduit =
   fondus courts (côté CSS) et aucune transformation (gardes ici). */
(function () {
  "use strict";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

  /* ---------- Séquence de chargement du héros ---------- */
  const seq = document.querySelector(".load-seq");
  if (seq) {
    document.fonts.ready.then(() => requestAnimationFrame(() => seq.classList.add("ready")));
    /* filet : si fonts.ready traîne, on lance quand même */
    setTimeout(() => seq.classList.add("ready"), 1200);
  }

  /* ---------- Révélations au scroll, une seule fois ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }
  }, { rootMargin: "-80px 0px" });
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.setProperty("--d", ((i % 4) * 0.07) + "s");
    io.observe(el);
  });

  /* ---------- Compteurs (1.6 s, sortie douce, tabular-nums) ---------- */
  const fmt = new Intl.NumberFormat("fr-FR");
  const counters = document.querySelectorAll("[data-count]");
  if (counters.length) {
    const cio = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cio.unobserve(e.target);
        const el = e.target;
        const target = parseFloat(el.dataset.count);
        if (reduced) { el.textContent = fmt.format(target); continue; }
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min((now - t0) / 1600, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = fmt.format(Math.round(target * eased));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }, { threshold: 0.4 });
    counters.forEach((el) => { el.textContent = "0"; cio.observe(el); });
  }

  /* ---------- Tilt des panneaux de verre (curseur, amorti) ---------- */
  if (finePointer && !reduced) {
    document.querySelectorAll(".tilt").forEach((panel) => {
      const max = parseFloat(panel.dataset.tilt || "5");
      let tx = 0, ty = 0, cx = 0, cy = 0, raf = null;
      const base = panel.dataset.tiltBase || "";
      const loop = () => {
        cx += (tx - cx) * 0.08;
        cy += (ty - cy) * 0.08;
        panel.style.transform = base + " rotateX(" + cy.toFixed(2) + "deg) rotateY(" + cx.toFixed(2) + "deg)";
        if (Math.abs(tx - cx) > 0.01 || Math.abs(ty - cy) > 0.01) raf = requestAnimationFrame(loop);
        else raf = null;
      };
      const onMove = (ev) => {
        const r = panel.getBoundingClientRect();
        tx = ((ev.clientX - r.left) / r.width - 0.5) * max * 2;
        ty = -((ev.clientY - r.top) / r.height - 0.5) * max * 2;
        if (!raf) raf = requestAnimationFrame(loop);
      };
      const zone = panel.closest(".tilt-zone") || panel;
      zone.addEventListener("pointermove", onMove);
      zone.addEventListener("pointerleave", () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(loop); });
    });
  }

  /* ---------- Parallaxe légère des fenêtres de capture au scroll
     (profondeur, pas décor : ±12 px, une transform, hors mouvement réduit). ---------- */
  const floats = document.querySelectorAll("[data-float]");
  if (floats.length && !reduced) {
    let ticking = false;
    const place = () => {
      ticking = false;
      const vh = innerHeight;
      floats.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) return;
        const k = parseFloat(el.dataset.float || "12");
        const p = ((r.top + r.height / 2) - vh / 2) / vh;      /* -0.5 … 0.5 */
        el.style.translate = "0 " + (p * -k).toFixed(1) + "px";
      });
    };
    addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(place); } }, { passive: true });
    place();
  }

  /* ---------- Vidéo : la couverture lance la lecture ---------- */
  const cover = document.querySelector(".play-cover");
  const video = document.querySelector(".film video");
  if (cover && video) {
    cover.addEventListener("click", () => {
      cover.classList.add("gone");
      video.setAttribute("controls", "");
      video.play().catch(() => {});
      setTimeout(() => cover.remove(), 450);
      const note = document.querySelector(".film [aria-live]");
      if (note) note.textContent = "Lecture du film : Le Signal, 2 min 50 s.";
    });
  }

  /* ---------- Dernière version publiée.
     Le HTML porte un lien et des textes valides sans script (page Releases, version du jour).
     Si l'API GitHub répond, le bouton devient un téléchargement direct et la version, le nom
     du fichier et sa taille suivent la dernière release. Sinon, rien ne change. ---------- */
  const REPO = "R2osters/supply-chain-project";
  const relTargets = document.querySelectorAll("[data-rel]");
  if (relTargets.length) {
    const CACHE_KEY = "scip-release";
    const CACHE_MS = 60 * 60 * 1000;                  /* l'API anonyme autorise 60 appels par heure et par adresse */
    const applyRelease = (rel) => {
      const tag = String(rel.tag || "");
      const name = String(rel.name || "");
      const url = String(rel.url || "");
      const size = Number(rel.size);
      /* On n'applique qu'une réponse cohérente : un tag de version, un .exe, un lien de cette release. */
      if (!/^v?\d+\.\d+\.\d+$/.test(tag) || !/^[\w.-]+\.exe$/i.test(name) || !(size > 0)) return;
      if (url !== "https://github.com/" + REPO + "/releases/download/" + tag + "/" + name) return;
      const version = tag.replace(/^v/i, "");
      const text = {
        v: "v" + version,
        n: version,
        file: name.replace(/-/g, "‑"),           /* trait d'union insécable, comme dans le HTML */
        size: Math.round(size / 1e6) + " Mo",
      };
      const href = {
        link: url,
        zip: "https://github.com/" + REPO + "/archive/refs/tags/" + tag + ".zip",
        tar: "https://github.com/" + REPO + "/archive/refs/tags/" + tag + ".tar.gz",
      };
      relTargets.forEach((el) => {
        const key = el.dataset.rel;
        if (key in text) el.textContent = text[key];
        else if (key in href) el.href = href[key];
      });
    };
    const readCache = () => {
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        return c && Date.now() - c.at < CACHE_MS ? c.rel : null;
      } catch (e) { return null; }
    };
    const cached = readCache();
    if (cached) applyRelease(cached);
    else {
      fetch("https://api.github.com/repos/" + REPO + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((data) => {
          const exe = (data.assets || []).find((a) => /\.exe$/i.test(a.name));
          if (!exe) return;
          const rel = { tag: data.tag_name, name: exe.name, size: exe.size, url: exe.browser_download_url };
          applyRelease(rel);
          try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rel: rel })); } catch (e) { /* stockage indisponible */ }
        })
        .catch(() => { /* quota ou réseau : le lien et les textes statiques restent */ });
    }
  }
})();
