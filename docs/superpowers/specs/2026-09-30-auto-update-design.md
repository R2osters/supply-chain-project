# Mise à jour automatique depuis GitHub — conception

Date : 30 septembre 2026 · Statut : validée par l'utilisateur (« auto + un clic », publication par
un script sur son PC, signature obligatoire).

## 1. Objectif

SCIP installé vérifie seul s'il existe une nouvelle version sur GitHub
(`R2osters/supply-chain-project`, dépôt public), la télécharge et la vérifie en arrière-plan, puis
l'installe en un clic, ou à la prochaine fermeture de SCIP. Jamais d'installation surprise
pendant l'utilisation.

## 2. Contrat de publication

### Clés

- `npm run release:keygen` (une fois) crée une paire Ed25519 :
  - clé privée PKCS#8 PEM dans `%USERPROFILE%\.scip\update-signing-key.pem`, jamais dans le dépôt ;
    le script refuse d'écraser une clé existante ;
  - clé publique dans `apps/desktop/src-tauri/update-key.pub` : base64 standard des 32 octets
    bruts, une ligne, commitée et compilée dans SCIP (`include_str!`).
- Perdre la clé privée empêche toute mise à jour automatique des SCIP déjà installés : la
  sauvegarder, par exemple dans un gestionnaire de mots de passe.

### Signature

- Message signé : les octets UTF-8 de
  `scip-update-v1\n{version}\n{sha256}\n{size}`
  - `version` : `MAJEUR.MINEUR.CORRECTIF` (ex. `0.3.0`) ;
  - `sha256` : empreinte SHA-256 de l'installeur, hexadécimal minuscule ;
  - `size` : taille en octets, décimal.
- Signature : Ed25519 (RFC 8032) du message, base64 standard.
- La version fait partie du message : un installeur signé ne peut pas être présenté sous un autre
  numéro de version.

### `latest.json`

Publié comme pièce jointe de chaque release, à côté de l'installeur :

```json
{
  "version": "0.3.0",
  "pubDate": "2026-10-01T10:00:00Z",
  "notes": "Texte des nouveautés (Markdown simple).",
  "url": "https://github.com/R2osters/supply-chain-project/releases/download/v0.3.0/SCIP-Setup-0.3.0.exe",
  "size": 341891258,
  "sha256": "…64 caractères hexadécimaux…",
  "signature": "…base64…"
}
```

### Script `npm run release -- 0.3.0 [--notes "…" | --notes-file F] [--dry-run]`

1. Vérifie : arbre git propre, version plus grande que la version actuelle, clé privée présente,
   `gh` connecté (sauf `--dry-run`).
2. Met à jour la version dans `apps/desktop/src-tauri/Cargo.toml` et
   `apps/installer/src-tauri/Cargo.toml` (et `Cargo.lock`), commite `release: v0.3.0`, crée le tag.
3. Construit l'installeur (`apps/installer/scripts/build-setup.mjs`).
4. Signe l'installeur, écrit `latest.json` dans `apps/installer/dist/`.
5. Sauf `--dry-run` : `gh release create v0.3.0 SCIP-Setup-0.3.0.exe latest.json --notes …`,
   puis `git push` de la branche et du tag.

### CI

`.github/workflows/desktop.yml` : le job installeur construit le vrai `SCIP-Setup-*.exe`
(`stage-all.mjs` puis `build-setup.mjs`) au lieu de l'ancien NSIS, et l'envoie comme artefact. La
CI ne publie pas de release et ne détient aucune clé.

## 3. Dans SCIP (shell Rust, `apps/desktop/src-tauri/src/update/`)

| Unité | Rôle |
|---|---|
| `version.rs` | Analyse et comparaison `MAJEUR.MINEUR.CORRECTIF` (un suffixe `-…` compte comme antérieur). |
| `manifest.rs` | `latest.json` : lecture, validation (URL dans le préfixe autorisé, taille > 0, sha256 à 64 caractères hexadécimaux). |
| `verify.rs` | Message signé, vérification Ed25519 (`ed25519-dalek`), SHA-256 en flux (`sha2`) sur le fichier téléchargé. |
| `updater.rs` | Machine à états, vérification périodique, téléchargement, lancement de l'installeur. |

- **Flux** : `https://github.com/R2osters/supply-chain-project/releases/latest/download/latest.json`.
  Préfixe de téléchargement autorisé :
  `https://github.com/R2osters/supply-chain-project/releases/download/` (les redirections vers le
  stockage de GitHub sont suivies).
  Surcharges pour les tests : `SCIP_UPDATE_FEED` (URL du flux ; le préfixe autorisé devient son
  origine) et `SCIP_UPDATE_PUBLIC_KEY` (clé publique base64).
- **Quand** : 2 minutes après que SCIP est prêt, puis toutes les 6 heures ; « Rechercher
  maintenant » à la demande. Pas de vérification si aucune clé publique n'est compilée (build de
  développement).
- **États** : `idle` → `checking` → `downloading { received, total }` →
  `ready { version, notes, pubDate }` ou `upToDate` ou `error { message }` (hors ligne : `idle`
  avec l'heure du dernier échec, sans message alarmant).
- **Téléchargement** : `<données>/updates/SCIP-Setup-{version}.exe.part`, renommé après
  vérification de la taille, du SHA-256 et de la signature ; au moindre écart, le fichier est
  supprimé et l'état passe à `error`. Au démarrage, un installeur déjà téléchargé et encore plus
  récent est revérifié puis proposé ; les installeurs anciens sont supprimés.
- **Jamais de retour en arrière** : seule une version strictement plus récente est proposée.
- **Installer maintenant** (administrateur) : sauvegarde automatique
  `SCIP-sauvegarde-…-avant-mise-a-jour.scip-backup` (backup/), revérification du fichier, lancement
  de `SCIP-Setup-{version}.exe --update`, puis SCIP se ferme (l'installeur arrête ce qui reste du
  dossier de SCIP).
- **À la fermeture de SCIP** avec une mise à jour prête : même chose avec `--update --no-launch`.
- **Ligne de commande** : `scip-desktop.exe --update [--check]` : vérifie, télécharge, vérifie,
  sauvegarde (SCIP fermé : sa propre base comme `--backup`), puis lance
  `SCIP-Setup.exe --silent --update` détaché et rend la main : la commande tourne depuis le dossier
  que l'installeur remplace, elle ne peut pas l'attendre. Les lignes JSON de l'installeur vont dans
  `updates/install-{version}.log` (la dernière dit comment il s'est terminé). Lignes JSON.

## 4. Installeur

- `--update` (fenêtre) : si une installation existe, l'écran de progression s'ouvre directement en
  mode mise à jour, sans clic ; à la fin, SCIP est relancé (sauf `--no-launch`) sans toucher au
  raccourci du Bureau ; en cas d'erreur, l'écran « Réessayer » habituel.
- `--silent --update` : même mise à jour sans fenêtre et sans fichier de plan (tests, ligne de
  commande).
- Sans installation existante, `--update` se comporte comme un lancement normal.

## 5. Interface

- Réglages → « Mises à jour » (fenêtre SCIP) : version actuelle, dernière vérification,
  « Rechercher maintenant », état du téléchargement, nouveautés de la version prête,
  « Installer maintenant » (rôle `company:update`) avec la mention de la sauvegarde automatique et
  de l'interruption d'une à deux minutes.
- Un toast unique par version prête, dans la fenêtre SCIP : « SCIP 0.3.0 est prêt » avec
  « Installer » (administrateur) ou « Voir » (autres rôles, vers Réglages).
- Hors de la fenêtre SCIP (téléphone), rien.

## 6. Sécurité

- HTTPS, dépôt fixe, préfixe d'URL fixe ; taille, SHA-256 et signature Ed25519 liée à la version.
- L'installeur est lancé par SCIP et non par un navigateur : pas de marque « téléchargé depuis
  internet », donc pas d'avertissement SmartScreen, et c'est la signature Ed25519 qui tient lieu
  de contrôle d'authenticité.
- Les surcharges de test passent par des variables d'environnement : quiconque les contrôle
  contrôle déjà le PC.

## 7. Tests

- Rust : versions, manifeste (URL hors préfixe refusée), message et signature (clé de test,
  signature modifiée, version modifiée, fichier modifié), machine à états.
- Script de publication (`node --test`) : format de clé, signature vérifiable par le même contrat,
  `latest.json`, refus sans clé, `--dry-run` sans appel à `gh` ni push.
- Installeur : analyse de `--update` / `--no-launch`, plan de mise à jour sans fichier.
- Web (vitest) : libellés d'état du panneau.
- Bout en bout local, en mode test : SCIP 0.2.0 installé ; un serveur local sert un
  `latest.json` et un installeur 0.2.1 signé avec une clé de test ; `scip-desktop.exe --update` →
  0.2.1 installée, données conservées, sauvegarde « avant-mise-a-jour » présente ; un installeur
  altéré est refusé. Aucune publication sur GitHub sans accord explicite de l'utilisateur.
