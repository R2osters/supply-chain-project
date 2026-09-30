# Installeur SCIP sur mesure

Décision : l'assistant NSIS standard est remplacé par un installeur SCIP dessiné dans la charte
(écrans : `SCIP Installeur - écrans.dc.html`, style : `SCIP Prototype.dc.html`). Choix validés :
installeur 100 % sur mesure ; « base de données existante » conservée ; « serveur existant » retiré
(SCIP reste tout-en-un, voir [ADR 0001](adr/0001-logiciel-de-bureau-tout-en-un.md)).

## Vue d'ensemble

```
SCIP-Setup-<version>.exe
├── programme d'installation (Tauri 2, WebView2) ── écrans HTML dans apps/installer/ui
└── charge utile collée en fin de fichier : tar.zst de { scip-desktop.exe, resources/ }
    + pied de 32 octets : magic "SCIPPAY1" (8) · offset u64 LE · longueur u64 LE · réservé u64
```

Un seul fichier à distribuer. L'installeur lit sa propre fin (`std::env::current_exe()`), vérifie le
pied, décompresse en flux vers le dossier d'installation en rapportant la progression en octets.

| Élément | Emplacement |
|---|---|
| Programme | `%LOCALAPPDATA%\Programs\SCIP\` (par utilisateur, sans droits administrateur) |
| Données | `%LOCALAPPDATA%\com.scip.desktop\` (inchangé, conservé par les mises à jour) |
| Désinstallation | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\SCIP`, commande `"<Programme>\uninstall.exe" --uninstall` (copie de l'installeur sans charge utile) |
| Raccourcis | Menu Démarrer `SCIP.lnk`, Bureau `SCIP.lnk` (option) |

## Parcours

| # | Écran | Contenu | Passe si |
|---|---|---|---|
| 01 | Bienvenue | langue FR/EN, thème, prérequis en une ligne, « Commencer » | — |
| 02 | Licence | texte défilant, case « J'accepte » obligatoire | cochée |
| 03 | Système | Windows ≥ 10 (1809), espace disque ≥ 2 Go, RAM ≥ 4 Go (sinon avertissement non bloquant), WebView2, ports 3001 et 5023 libres (avertissement), installation existante détectée → mode mise à jour | aucun contrôle bloquant en échec |
| 04 | Type | **Production** (base vide, vos données) · **Démonstration** (données fictives et comptes démo) | un choix |
| 05 | Base de données | **Intégrée** (recommandé : PostgreSQL 16 + PostGIS installés avec SCIP) · **Existante** | un choix |
| 05b | Base existante | hôte, port, base, utilisateur, mot de passe, SSL ; « Tester la connexion » : connexion, version ≥ 14, extension PostGIS disponible, droits de création | test réussi |
| 06 | Organisation | nom, pays, devise (déduite du pays, modifiable), fuseau, sites (entrepôts : nom, ville, latitude/longitude facultatives) | nom + pays (sauté en démo) |
| ~~07~~ | ~~Sources~~ | **Retiré** : SCIP est livré avec ses sources prêtes (navires en mer Baltique, avions, catastrophes, météo, caméras sans clé ; clés éventuelles intégrées au build via `keys.local.json`). Les véhicules suivent le type : simulation pour une démo, balises et téléphones sinon. Le récapitulatif le rappelle. | — |
| 08 | Administrateur | prénom, nom, e-mail, mot de passe (règles cochées en direct : 12 caractères, 3 types parmi minuscules/majuscules/chiffres/symboles), confirmation | valide (sauté en démo) |
| 09 | Récapitulatif | un bloc par étape avec « Modifier » | — |
| 10 | Installation | barre de progression, étapes, journal dépliable | — |
| 10b | Erreur | message clair, « Réessayer » reprend à l'étape échouée sans refaire les précédentes, « Voir le journal » | — |
| 11 | Terminé | « Ouvrir SCIP », raccourci Bureau, prochaines étapes (se connecter, ajouter véhicules, clés des sources) | — |

Mise à jour : si une installation existe, 04 à 08 sont sautés (les données existent) et 10 remplace
les fichiers puis relance les migrations.

Mise à jour automatique (`--update`, lancé par SCIP, [DEPLOYMENT.md](../DEPLOYMENT.md#updates)) :
l'écran de progression s'ouvre directement, sans clic ni raccourci Bureau ; l'installeur attend
jusqu'à 60 s que SCIP se ferme, arrête ce qui reste dans son dossier, puis relance SCIP (sauf
`--no-launch`, quand SCIP s'installe à sa fermeture). `--silent --update` fait la même chose sans
fenêtre (lignes JSON sur la sortie standard). Sans installation existante, `--silent --update`
échoue (`not_installed`) et `--update` ouvre le parcours d'installation normal.

Désinstallation (`--uninstall`) : un écran de confirmation avec la case « Supprimer aussi mes
données » (décochée par défaut), puis progression.

## Contrat écran ↔ moteur (commandes Tauri)

Toutes les commandes sont `async` et renvoient du JSON ; les erreurs sont `{ code, message, detail? }`.

| Commande | Entrée | Sortie |
|---|---|---|
| `get_context` | — | `{ mode: 'install'|'upgrade'|'uninstall', version, existing: { version, dir } | null, locale: 'fr'|'en', payloadBytes, defaultInstallDir }` |
| `run_system_checks` | — | `[{ id, status: 'ok'|'warn'|'fail', label, detail }]` ids : `os`, `disk`, `ram`, `webview2`, `port-api`, `port-gps` |
| `test_database` | `{ host, port, database, user, password, ssl }` | `{ ok, serverVersion, postgis: 'installed'|'available'|'missing', canCreate, message }` |
| `start_install` | `InstallPlan` (voir ci-dessous) | `()` ; la suite arrive par événements |
| `retry_install` | — | reprend à la première étape non terminée |
| `launch_scip` | `{ createDesktopShortcut }` | `()` puis fermeture |
| `start_uninstall` | `{ removeData }` | `()` ; événements |
| `read_log` | — | texte complet du journal |

```ts
interface InstallPlan {
  kind: 'production' | 'demo';
  database: { mode: 'embedded' } | { mode: 'external'; host; port; database; user; password; ssl };
  organisation?: { name; country; currency; timezone; sites: Array<{ name; city; latitude?; longitude? }> };
  sources: { vehicles: 'live' | 'simulation' }; // les clés restent acceptées par --provision, l'écran ne les demande plus
  admin?: { firstName; lastName; email; password };
  desktopShortcut: boolean;
}
```

Événements : `install://step` `{ id, status: 'pending'|'running'|'done'|'failed', label }`,
`install://progress` `{ fraction, detail }`, `install://log` `{ line }`, `install://error`
`{ step, code, message, retryable }`, `install://done`.

Étapes : `extract` (fichiers), `shortcuts`, `register` (désinstallation), `provision` (base, schéma,
organisation, administrateur, sources, démo), `finish`.

## Provisionnement (`scip-desktop.exe --provision`)

L'installeur lance le SCIP installé en mode sans fenêtre et lui envoie le plan sur **l'entrée
standard** (jamais dans un fichier : il contient le mot de passe administrateur et celui de la base).
SCIP réutilise son superviseur : base intégrée (initdb, PostGIS, migrations) ou base existante
(migrations seulement), démarre l'API, applique le plan par l'API (création de l'entreprise et de
l'administrateur, devise et fuseau, sites, clés des sources, données de démo), puis arrête proprement
ses services. Chaque étape écrit une ligne JSON sur la sortie standard :
`{"step":"migrate","status":"running","label":"Mise à jour du schéma"}` ou `{"log":"..."}`, lue par
l'installeur pour l'écran 10. Code de sortie 0 = succès ; sinon la dernière ligne est
`{"error":{"step","code","message","retryable"}}`. Le provisionnement est idempotent : relancé, il
saute ce qui existe déjà.

Base existante : `config.json` reçoit `database: { mode: 'external', url }` (mot de passe compris,
fichier du profil utilisateur) ; le superviseur saute alors initdb et PostgreSQL.
