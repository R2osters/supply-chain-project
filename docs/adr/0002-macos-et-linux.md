# ADR 0002 — Versions macOS et Linux, construites par la CI

- Statut : accepté
- Date : 2026-10-02
- Amende le point 3 de l'[ADR 0001](0001-logiciel-de-bureau-tout-en-un.md) (« Windows uniquement »).
  Le reste de l'ADR 0001 tient : tout-en-un local, Tauri 2, bureau seulement, IA embarquée.

## Contexte

SCIP n'existait que pour Windows : binaires PostgreSQL et PostGIS d'EDB et d'OSGeo, `node.exe`,
sidecar IA figé par PyInstaller sous Windows, installeur sur mesure qui écrit dans le registre.
Le reste ne dépend pas de Windows : l'API et l'IA tournaient sous Linux avant l'ADR 0001, et la
coque Rust isolait déjà ses appels Windows derrière `cfg(windows)`.

On veut pouvoir installer SCIP sur un Mac et sur un PC Linux, sans machine de build à nous.

## Décision

1. **Deux cibles** : macOS sur Apple Silicon (`.dmg`, macOS 13.5 ou plus récent) et Linux x86_64
   (`.deb`, Ubuntu 22.04 ou plus récent, Debian 12 ou plus récent).
2. **Même code, mêmes services.** La coque, l'API, l'IA et l'interface sont celles de Windows. Le
   code propre à macOS et Linux est sous `cfg(unix)` ; le comportement de Windows ne change pas.
3. **PostgreSQL 18 et PostGIS 3.6.2 pris sur conda-forge**, installés par micromamba (épinglé par
   empreinte) dans `apps/desktop/scripts/stage-postgres-unix.mjs`. conda-forge ne publie PostGIS
   3.6 pour Apple Silicon que contre PostgreSQL 18 ; Windows reste en PostgreSQL 16.15, avec le
   même PostGIS 3.6.2.
4. **Paquets natifs, pas d'installeur sur mesure.** L'installeur SCIP (registre, WebView2,
   raccourcis) reste propre à Windows. Sur Mac on glisse l'application dans Applications, sous
   Linux on installe le paquet. Au premier lancement, l'assistant intégré crée l'entreprise ou
   charge la démonstration.
5. **Construits et testés par GitHub Actions** (`.github/workflows/desktop-unix.yml`) : tests et
   lint de la coque sur les deux systèmes, puis le paquet est installé sur le runner et exercé de
   bout en bout (`apps/desktop/scripts/e2e-unix.mjs`). Le `.deb` est en plus installé et exercé
   dans des images vierges d'Ubuntu 22.04 et 24.04 et de Debian 12 et 13 : une machine de build
   a des bibliothèques et des caches qu'un poste d'utilisateur n'a pas.
6. **Publiés avec la release.** Sur un tag de version, un job attache le `.dmg`, le `.deb` et leur
   fichier `SHA256SUMS` à la release créée par l'éditeur depuis son PC. C'est le seul job du dépôt
   qui a le droit d'écrire, et seulement pour cela.
7. **Mise à jour manuelle.** Le flux de mise à jour ne décrit que l'installeur Windows. Sur macOS
   et Linux, Réglages → Mises à jour dit de télécharger la nouvelle version sur le site.

## Alternatives écartées

- **Compiler PostgreSQL 16 et PostGIS depuis les sources** pour garder la même version partout :
  GEOS, PROJ et leurs dépendances à construire et à maintenir sur deux systèmes, pour un écart
  qui ne touche que la restauration d'une sauvegarde (voir Conséquences).
- **Le PostgreSQL de la distribution**, en dépendance du paquet : la version change d'une
  distribution à l'autre, et rien d'équivalent n'existe sur Mac.
- **AppImage** : un environnement conda porte le chemin où il a été créé ; il ne peut pas tourner
  depuis le point de montage aléatoire d'une AppImage.
- **Mac Intel et Linux ARM** : les mêmes scripts s'y prêtent, mais rien n'est construit tant que
  personne ne le demande.
- **Signature Apple et notarisation** : elles demandent un compte développeur payant.

## Conséquences

- **Sauvegardes.** Une sauvegarde faite sous Windows (PostgreSQL 16) se restaure sur macOS et
  Linux. L'inverse n'est pas possible : `pg_restore` 16 ne lit pas l'archive d'un `pg_dump` 18.
  Le manifeste d'une sauvegarde porte donc la version majeure de PostgreSQL (champ facultatif,
  absent = 16), et SCIP refuse la restauration avant de toucher à quoi que ce soit, avec la
  raison. L'écart disparaîtra quand Windows passera à PostgreSQL 18.
- **Emplacement imposé.** Le PostgreSQL embarqué est construit pour le dossier où le paquet
  l'installe : `/Applications/SCIP.app` sur Mac, `/usr/lib/SCIP` sous Linux. Lancé d'ailleurs
  (depuis l'image disque, depuis Téléchargements), SCIP le dit et s'arrête.
- **Non signé.** Sur Mac, Gatekeeper bloque l'application téléchargée : il faut l'autoriser dans
  Réglages Système → Confidentialité et sécurité, ou retirer l'attribut de quarantaine
  ([DEPLOYMENT.md](../../DEPLOYMENT.md#macos-and-linux)).
- **Processus.** macOS et Linux n'ont pas l'objet Job de Windows
  (`apps/desktop/src-tauri/src/unix_orphans.rs`). Sous Linux, chaque service demande au noyau un
  signal à la mort de SCIP. Sur macOS, qui n'a pas cette demande, SCIP lance un veilleur
  (`scip-desktop --reap`) qui attend sa mort et arrête alors ses services. Sur les deux, SCIP
  arrête à son démarrage ce qu'un SCIP tué aurait laissé : les processus de l'utilisateur lancés
  depuis ses ressources et qui n'ont plus de SCIP vivant au-dessus d'eux. Un service qui en a
  encore un (une sauvegarde en cours sans fenêtre) n'est jamais touché : la fenêtre refuse alors
  de démarrer et le dit.
- **Fichiers privés.** Le dossier de données est fermé aux autres comptes de l'ordinateur (mode
  700), `config.json` et les sauvegardes aussi (600) : rien n'y joue le rôle de la liste de
  contrôle d'accès de `%LOCALAPPDATA%`.
- **Vérifiés par des machines, pas encore par des personnes.** Les deux paquets sont installés
  et testés à chaque build sur les runners de GitHub. Aucun n'a encore été essayé par une
  personne sur un vrai Mac ou un vrai poste Linux : tant que c'est le cas, on le dit.

## Travaux à venir

- **Verrouiller l'environnement conda.** Seuls PostgreSQL et PostGIS sont épinglés ; GEOS, PROJ,
  GDAL et OpenSSL suivent conda-forge. Le build d'un tag repasse tout le test de bout en bout
  avant de joindre les paquets : une dérive casse ce build au lieu de sortir un paquet cassé, ce
  qui suffit pour une version préliminaire. Un fichier de verrouillage par plateforme (liste
  `@EXPLICIT` avec empreintes) rendrait le build reproductible.
- **Licences des composants embarqués.** Le paquet liste chaque composant du PostgreSQL embarqué
  et sa version dans `resources/postgres/PACKAGES.txt` (PostGIS est sous GPL v2, GEOS sous LGPL).
  Il reste à y joindre leurs textes de licence.
