# Répétition de la démo et sauvegarde / restauration — conception

Date : 30 septembre 2026 · Statut : validée par l'utilisateur (« Oui, tout ») · Points P0 n° 4 et 5
de `docs/ROADMAP-presentation.md`.

## 1. Point 4 — démo reproductible

### Problème (constaté dans le code)

- Le simulateur (`jobs/telemetry-simulator.service.ts`) fait arriver les 11 livraisons en cours de
  la démo (`SHP-DEMO-0041` à `0055`) en 15 à 45 minutes de fonctionnement (×12) ; `ARRIVED` est
  définitif. Ensuite la carte est vide et « En retard » vaut 0.
- Les livraisons `DELAYED` du jeu de démo ne déclenchent aucun événement : pas de notification,
  pas de recommandation.
- Aucune recommandation n'est livrée : elles sont générées à la demande ou par le worker
  d'événements (`jobs/domain-event.worker.ts`) sur `SHIPMENT_DELAYED`.
- La démo ne peut être rechargée qu'avant la création d'une entreprise.

### Solution : `POST /setup/demo/rehearse`

« Préparer la démo » remet le monde de démo en scène **à l'instant présent**, autant de fois que
voulu. Réservé à une installation démo (`SetupService.status().demoAccounts === true`) et au rôle
`COMPANY_ADMIN` de l'entreprise de démo ; 409 sinon. Audité (`setup.demo.rehearse`).

Effets, dans une transaction :

| Élément | Remise en scène |
|---|---|
| Livraisons de démo en cours ou arrivées depuis le chargement (`isDemoData`, numéros `SHP-DEMO-0041` à `0055`) | Statut `IN_TRANSIT`, `actualArrivalAt` vidé, positions GPS de ces livraisons supprimées, dernière position du véhicule remise à l'origine, départ prévu = maintenant. |
| Arrivée prévue, cas général | départ + durée réaliste (longueur de l'itinéraire / 60 km/h) : à l'heure. |
| Arrivée prévue, `SHP-DEMO-0054` et `0055` | maintenant + 5 min : intenable. Le calcul d'ETA existant (toutes les 30 s) les déclare `DELAYED` avec l'événement `DELAY_DETECTED` et publie `SHIPMENT_DELAYED` : notification puis recommandations, en direct. |
| Stock SKU-006 à l'entrepôt principal (WH-ACC) | Disponible = 2 jours de demande (620), en cours de livraison = 0. |
| Commandes d'achat créées par une recommandation acceptée (note « Raised from an accepted SCIP recommendation ») non reçues | `CANCELLED` : une répétition précédente ne masque pas la rupture. |
| Recommandations `PENDING` de l'entreprise | Supprimées : la liste se remplit en direct. |

Le simulateur oublie l'avancement de ces livraisons (`TelemetrySimulatorService.forget(ids)`), pour
qu'elles repartent de zéro. Durée ×12 : un trajet de 250 km dure environ 20 minutes réelles,
assez pour une présentation de 10 minutes.

Réponse : `{ shipments: number, delayedSoon: string[], inventoryReset: boolean, cancelledOrders: string[], clearedRecommendations: number }`.

Interface : Réglages → nouveau panneau « Démonstration » (installation démo et administrateur
seulement), bouton « Préparer la démo », résumé du résultat, lien vers le script.

### Script : `docs/DEMO-scenario.md`

Script minuté de 10 minutes, en français : préparation (la veille et 5 minutes avant), déroulé avec
les clics exacts et ce qu'il faut dire, questions probables, plan B (sans internet : cartes hors
ligne et trafic indisponible ; sans moteur IA : recommandations indisponibles, montrer la boucle
avec l'historique).

## 2. Point 5 — sauvegarde et restauration

### Principes

- Uniquement pour la base intégrée (mode `embedded`) ; en mode base externe, le panneau explique
  d'utiliser les outils de ce serveur.
- Uniquement dans la fenêtre SCIP de ce PC (commandes Tauri) : un téléphone sur le Wi-Fi ne voit
  pas le panneau. Même modèle de confiance que la récupération de mot de passe : qui a accès à ce
  PC a déjà accès au dossier de données.
- Une sauvegarde ne contient **aucun secret de l'installation** (`config.json`) ni les clés des
  sources (`settings.json`) : elle peut être copiée sur une clé USB sans exposer de clé API. Elle
  contient les comptes (empreintes Argon2 des mots de passe) : l'interface dit de la garder en lieu
  sûr.

### Format

Un fichier `SCIP-sauvegarde-AAAA-MM-JJ-HHMMSS.scip-backup` : archive tar (non compressée : le dump
est déjà compressé, les photos sont en JPEG) contenant :

- `manifest.json` : `{ format: 1, appVersion, createdAt, company, latestMigration, counts: { shipments, purchaseOrders, users }, files: n }` ;
- `database.dump` : `pg_dump --format=custom --no-owner --no-privileges` de la base `scip` ;
- `files/…` : copie du dossier `files` (preuves de livraison).

Dossier : `Documents\SCIP\Sauvegardes` (dossier « Documents » de Windows, redirections OneDrive
comprises) ; surcharge `SCIP_BACKUP_DIR` pour les tests.

### Shell (Rust, `apps/desktop/src-tauri/src/backup/`)

| Unité | Rôle |
|---|---|
| `manifest.rs` | Manifeste, nom de fichier, lecture d'une archive (manifeste seul), liste triée des sauvegardes du dossier. |
| `archive.rs` | Écriture et extraction tar (chemins relatifs uniquement, refus de `..` et des chemins absolus). |
| `pending.rs` | `pending-restore.json` dans le dossier de données : la restauration à faire au prochain démarrage. |
| `run.rs` | Création (pg_dump avec `PGPASSWORD`, copie des fichiers, comptages via psql) ; tâches de restauration pour le plan de démarrage. |

Commandes Tauri (ajoutées dans `build.rs`, `capabilities/default.json`, `generate_handler!`) :

- `list_backups() -> { directory, backups: [{ name, createdAt, sizeBytes, company, appVersion, counts }], embedded: bool }` ;
- `create_backup() -> BackupInfo` (quelques secondes ; exécuté hors du fil d'interface) ;
- `open_backups_folder()` ;
- `schedule_restore(name)` : vérifie l'archive (manifeste lisible ; `latestMigration` de la
  sauvegarde ≤ la dernière migration livrée, sinon refus « sauvegarde d'une version plus récente de
  SCIP »), crée d'abord une **sauvegarde de sécurité** (`…-avant-restauration.scip-backup`), écrit
  `pending-restore.json`, puis redémarre l'application.

Démarrage avec une restauration en attente : l'archive est extraite dans
`<données>/restore-staging`, le dossier `files` est remplacé, et le plan de démarrage devient
`initdb, postgres, drop-database, create-database, postgis, restore, migrate, ai, api` :
`drop-database` = `DROP DATABASE IF EXISTS scip WITH (FORCE)` sur la base `postgres` ;
`restore` = `pg_restore --no-owner --no-privileges --exit-on-error -d scip database.dump`. Les
migrations mettent à niveau une sauvegarde plus ancienne. L'écran de démarrage affiche
« Restauration de la sauvegarde ». Succès : `pending-restore.json` et `restore-staging` supprimés.
Échec : message d'erreur qui nomme la sauvegarde de sécurité à restaurer.

Ligne de commande (sans fenêtre, comme `--provision`) : `scip-desktop.exe --backup [--out DOSSIER]`
et `scip-desktop.exe --restore FICHIER` démarrent leur propre PostgreSQL sur le dossier de données
(refus si SCIP est déjà ouvert), écrivent des lignes JSON de progression, puis l'arrêtent.

### Web

Réglages → panneau « Sauvegarde » (visible dans la fenêtre SCIP, rôle `company:update`) : liste
(date, entreprise, taille, version), « Créer une sauvegarde », « Ouvrir le dossier », et pour
chaque sauvegarde « Restaurer… » avec une confirmation qui dit ce qui est remplacé et que SCIP
redémarre. Hors de la fenêtre SCIP : une phrase qui renvoie au PC où SCIP est installé.

## 3. Tests

- API (jest) : répétition refusée hors démo et hors administrateur ; effets sur une base de
  test réelle (statuts, horaires, stock, commandes annulées, recommandations supprimées, oubli du
  simulateur) ; les livraisons 0054/0055 passent `DELAYED` au prochain calcul d'ETA.
- Rust : manifeste, noms, tri, archive (aller-retour, refus des chemins dangereux), plan de
  démarrage avec et sans restauration en attente, comparaison des migrations.
- Web (vitest) : formatage des tailles et dates du panneau, état « hors fenêtre SCIP ».
- Bout en bout sur l'exécutable installé en mode test : `--backup`, modification des données,
  `--restore`, démarrage : les données d'avant sont revenues ; répétition de la démo : 2 retards
  détectés et au moins une recommandation en moins de 2 minutes.
