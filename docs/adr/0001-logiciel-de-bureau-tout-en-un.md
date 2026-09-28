# ADR 0001 — SCIP devient un logiciel de bureau Windows tout-en-un

- Statut : accepté
- Date : 2026-09-28

## Contexte

SCIP est aujourd'hui une plateforme web : front Next.js, API NestJS, service IA Python,
Postgres/PostGIS, Redis, MinIO et Mailhog, orchestrés par Docker. On veut un vrai logiciel
qu'on installe et qu'on lance depuis un `.exe`.

## Décision

1. **Tout-en-un local.** Le `.exe` embarque l'interface, l'API, la base et l'IA. Aucun serveur distant.
2. **Tauri 2** comme coque de bureau. Son cœur Rust sert aussi de superviseur des processus.
3. **Windows uniquement** (installeur NSIS).
4. **Bureau seulement.** La version serveur (Docker, Redis, MinIO) est abandonnée. Pas de mode double.
5. **IA embarquée** sous forme de sidecar PyInstaller.
6. **GPS (GT06) et app chauffeur** : réseau local ou redirection de port, documentés. Le PC doit rester allumé.

## Alternatives écartées

- **Electron** : environ 150 Mo de Chromium et une RAM élevée. Son seul atout (Node dans le main)
  ne sert pas, car l'API tourne dans son propre processus.
- **Client connecté à un serveur** : garde le temps réel et le multi-poste, mais ne répond pas
  au besoin d'un logiciel autonome.
- **SQLite/SpatiaLite à la place de Postgres** : réécriture du schéma Prisma et des requêtes
  PostGIS, pour gagner environ 80 Mo. Pas rentable.
- **Réécriture native (WPF, MAUI)** : on jetterait tout le front React.

## Conséquences

- Mono-poste : pas de partage de données entre collègues. La sauvegarde devient la responsabilité
  de l'utilisateur, d'où un export/import intégré (`pg_dump` / `pg_restore`).
- Installeur estimé entre 450 et 700 Mo, surtout à cause de l'IA (`ortools`, `scipy`, `pandas`,
  `statsmodels`) et de Postgres.
- Les positions GPS envoyées pendant que le PC est éteint sont perdues.
- Un certificat de signature de code est nécessaire, sinon SmartScreen bloque l'installation.
- Le multi-tenant reste dans le code, mais on ne crée qu'un seul tenant, au premier lancement.
