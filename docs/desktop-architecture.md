# Architecture du logiciel de bureau

Décision et alternatives : [ADR 0001](adr/0001-logiciel-de-bureau-tout-en-un.md).

## Vue d'ensemble

```
SCIP.exe (Tauri 2)
├── WebView2 ── interface React (export statique de apps/web)
└── Superviseur Rust
    ├── postgres.exe  (PostGIS)   127.0.0.1:<port libre>
    ├── node.exe api/main.js      127.0.0.1:<port libre>   + TCP GT06 0.0.0.0:5023
    └── scip-ai.exe (PyInstaller) 127.0.0.1:<port libre>
```

Les données vivent dans `%LOCALAPPDATA%\com.scip.desktop\` : `pgdata\`, `files\`, `models\`, `logs\`, `config.json`.

## Séquence de démarrage

1. Choisir des ports libres et générer (ou relire) les secrets locaux : JWT, jeton IA, mot de passe Postgres.
2. Au premier lancement, `initdb` puis `CREATE EXTENSION postgis`.
3. Démarrer Postgres et attendre qu'il réponde à `SELECT 1`, puis créer la base `scip` si elle manque.
4. Exécuter `prisma migrate deploy`.
5. Démarrer l'IA (facultative : un échec dégrade OPTIMIZE sans bloquer l'application), puis l'API, et attendre leurs endpoints `/health`.
6. Injecter l'URL de l'API dans la WebView, puis afficher l'interface. Au premier lancement,
   c'est l'assistant de configuration qui s'affiche (tenant et compte admin).

L'arrêt se fait dans l'ordre inverse. Si un processus plante, le superviseur le relance
(3 tentatives maximum), puis affiche une erreur avec le chemin des logs.

## Remplacement des briques serveur

| Avant | Après | Fichier concerné |
|---|---|---|
| Redis (health seulement) | supprimé | `modules/health/health.controller.ts` |
| MinIO / S3 | système de fichiers local | `modules/storage/storage.service.ts` |
| Mailhog | SMTP facultatif, configuré dans les réglages | `modules/mail/mail.service.ts` |
| `next start` (standalone) | `output: 'export'`, `shipments/[id]` devient `shipments?id=` | `apps/web` |
| Docker Compose | superviseur Tauri | `apps/desktop/src-tauri` |

## Structure cible

```
apps/
  api/        NestJS (inchangé, sauf les adaptateurs)
  web/        interface React, export statique
  desktop/    Tauri 2 : src-tauri/ (Rust), scripts de packaging
services/ai/  FastAPI, plus un spec PyInstaller
```

## Lots de travail

| Lot | Contenu | État |
|---|---|---|
| 1 | `apps/web` : export statique, `shipments/detail?id=`, URL d'API à l'exécution | fait |
| 2 | `apps/api` : stockage fichiers local (liens signés), SMTP facultatif, Redis retiré | fait |
| 3 | `apps/desktop` : Tauri 2, splash à la charte v1.0, passage de relais vers l'interface | fait |
| 4 | Superviseur : Postgres portable, migrations, API ; politique de relance ; Job Object | fait |
| 5 | Sidecar IA PyInstaller (~535 Mo), facultatif au démarrage | fait |
| 6 | Premier lancement : créer l'entreprise ou charger la démo ; inscription fermée ensuite | fait |
| 7 | Installeur NSIS, CI GitHub Actions | fait ; signature et mise à jour automatique à faire |
| 8 | Docker réduit au Postgres de développement, README et `DEPLOYMENT.md` | fait |

Reste à faire : certificat de signature de code, mise à jour automatique (plugin updater Tauri +
hébergement des versions), HTTPS sur le réseau local pour le GPS de la PWA chauffeur, sauvegarde
et restauration depuis l'interface.

## macOS et Linux

La même coque est construite pour macOS (Apple Silicon) et Linux (x86_64) par la CI : décision et
écarts dans l'[ADR 0002](adr/0002-macos-et-linux.md), installation dans
[DEPLOYMENT.md](../DEPLOYMENT.md#macos-and-linux). Ce qui change dans le schéma ci-dessus :

| | Windows | macOS | Linux |
|---|---|---|---|
| Fenêtre | WebView2 | WKWebView | WebKitGTK 4.1 |
| Données | `%LOCALAPPDATA%\com.scip.desktop\` | `~/Library/Application Support/com.scip.desktop/` | `~/.local/share/com.scip.desktop/` |
| Base embarquée | PostgreSQL 16 d'EDB | PostgreSQL 18 de conda-forge | PostgreSQL 18 de conda-forge |
| Services liés à la vie de SCIP | objet Job (`win_job.rs`) | nettoyage au démarrage (`unix_orphans.rs`) | signal à la mort du parent, et nettoyage au démarrage |
| Mise à jour | automatique, signée | manuelle | manuelle |

Le test de bout en bout qui manque sous Windows existe pour ces deux systèmes :
`apps/desktop/scripts/e2e-unix.mjs` installe le paquet sur le runner et le fait tourner.

## Tests

- Unitaires Rust (`npm run desktop:test`) : ports, secrets, chemins, spécifications des services,
  séquence de démarrage avec processus simulés, politique de relance, service facultatif dégradé.
- Unitaires API : liens signés du stockage, service de premier lancement.
- Unitaires web : résolution de l'URL d'API à l'exécution ; fond de carte hors connexion (style,
  découpe et filtrage des données).
- Vérifié à la main sur l'exécutable : premier lancement (initdb, PostGIS, migrations), chargement
  de la démo, connexion, détail d'expédition, prédiction IA, second lancement, arrêt propre.
- Pas encore automatisé : E2E sur l'exécutable (WebDriver Tauri).

## Réseau (GPS et app chauffeur)

Le logiciel écoute en TCP sur le port 5023 (GT06) et en HTTP sur le port 3001 (s'il est libre) :
l'API y sert aussi l'interface, donc la PWA chauffeur s'ouvre sur `http://<PC>:3001/drive`.
Au premier lancement, Windows demande d'autoriser « Node.js JavaScript Runtime » (le processus de l'API).
Limite connue : un navigateur de téléphone n'accorde le GPS qu'en HTTPS ; en HTTP sur le réseau local,
la PWA enregistre les livraisons mais pas la position. Pour les camions hors du réseau local,
il faut une redirection de port sur la box vers le PC, documentée dans `TRACKING.fr.md`.

## Cartes hors connexion

Sans Internet, les tuiles OpenStreetMap ne chargent pas. Pour qu'une carte ne soit jamais un
rectangle gris (une présentation dans une salle sans réseau, par exemple), chaque carte dessine
sous les tuiles un fond vectoriel livré avec le logiciel : terres et mers, lacs et fleuves,
frontières, routes, villes et noms de pays, en clair comme en sombre.

- **Aucune bascule.** Le fond est dans le style commun (`apps/web/src/lib/map-style.ts`), entre
  l'arrière-plan et la couche raster. En ligne, les tuiles le recouvrent ; hors connexion, les
  requêtes échouent, MapLibre ne dessine pas ces tuiles et le fond apparaît. Une tuile qui manque
  laisse voir le fond à sa place. Les pages n'ont rien à détecter.
- **Même aspect en ligne.** La couche raster de la charte était translucide : elle est rendue
  opaque, sa transparence reportée dans la plage de luminosité. Mesuré sur les mêmes tuiles :
  au plus 1 niveau sur 255 d'écart en clair et en sombre (2 sur la carte maritime).
- **Couleurs.** Les couleurs d'OpenStreetMap Carto (terre, eau, frontières, routes, noms) passent
  par la même peinture raster que les tuiles : hors connexion, la carte ressemble à la carte en
  ligne dépouillée de ses détails. `useBasemapTheme` repeint tout au changement de thème.
- **Données.** Natural Earth (domaine public) : 1:50m pour le monde, 1:10m pour l'Afrique de
  l'Ouest (boîte `[-20, 2, 16, 25]`, le réseau de démonstration est au Ghana). Routes : toutes dans
  la boîte, les principales ailleurs en Afrique, aucune au-delà. Environ 4,3 Mo au total.
- **Libellés.** Glyphes Noto Sans (SIL Open Font License 1.1, empaquetés par OpenMapTiles), servis
  depuis l'origine de la page : `http://tauri.localhost` dans le logiciel, l'API pour un téléphone.
- **Construction.** `npm run basemap --workspace @scip/web` (`apps/web/scripts/fetch-basemap.mjs`,
  Node sans dépendance) télécharge des versions épinglées dans `apps/web/.basemap-cache/`, puis
  écrit `apps/web/public/basemap/`. Aucun des deux dossiers n'est versionné. `stage-web.mjs` le
  lance quand `public/basemap/basemap.json` manque ; après une modification du script, relancer
  `npm run basemap` (hors ligne, depuis le cache).
- **Limite connue.** Quand le réseau ne refuse pas mais laisse attendre (Wi-Fi sans accès
  Internet), les tuiles échouent après un délai, carte au repos, et MapLibre ne déclenche son
  événement `load` qu'au rendu suivant. Le fond s'affiche quand même, mais les couches que
  certaines pages ajoutent sur `load` attendent que l'on déplace ou zoome la carte.
- **Crédit.** « Made with Natural Earth » figure dans l'attribution de chaque carte ;
  `NOTICE.txt` et la licence de la police sont livrés avec les données.
