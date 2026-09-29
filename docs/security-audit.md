# Audit de sécurité — SCIP

*Évaluation réalisée le 29/09/2026, sur la branche `claude/desktop-exe-evolution-e612fc`.
Document destiné à accompagner la présentation du projet en cours.*

Cet audit répond à la demande de « tests de sécurité » avant la présentation. Il combine une
revue statique du code, une analyse des dépendances, et des **tests dynamiques réels** exécutés
contre une pile de test jetable (jamais contre le vrai SCIP de l'utilisateur).

> **En une phrase :** l'architecture de sécurité de SCIP est sérieuse et bien pensée (RBAC par
> permissions, isolation multi-tenant explicite, rotation des jetons, anti-SSRF sur toutes les
> sources externes). Le point à corriger *avant une démonstration sur un réseau partagé* est le
> compte de démonstration à mot de passe public combiné à l'écoute sur `0.0.0.0`.

---

## 1. Périmètre et méthode

| Élément | Détail |
|---|---|
| Application | SCIP — appli Windows de bureau (Tauri 2), API NestJS, PostgreSQL/PostGIS embarqué, sidecar IA FastAPI, UI Next.js (export statique dans WebView2), installeur sur mesure |
| Exposition réseau | API `0.0.0.0:3001` (HTTP) + passerelle GT06 `0.0.0.0:5023` (TCP) sur le LAN ; PostgreSQL et IA sur `127.0.0.1` uniquement |
| Méthode | Revue statique (file:line), `npm/pip/cargo audit`, sonde dynamique maison, fuzzing du codec GT06 |
| Pile de test | PostgreSQL temporaire `127.0.0.1:55433`, API sur `127.0.0.1:3101`, données de démo — **isolée du vrai SCIP** |
| Non testé | Le vrai SCIP installé (ports 3001/5023, dossiers `%LOCALAPPDATA%`) — jamais touché, conformément à la consigne |

Scripts livrés (réutilisables) :

- `scripts/security/route-inventory.mjs` — inventaire statique des routes et de leur protection.
- `scripts/security/probe.mjs` — sonde dynamique (12 familles de tests) contre une API en marche.
- `scripts/security/gt06-fuzz.mjs` — fuzzer du codec binaire GT06.

---

## 2. Résultats des tests dynamiques

Sonde exécutée : `node scripts/security/probe.mjs --base http://127.0.0.1:3101/api/v1 --routes <log de démarrage>`

| # | Test | Résultat | Preuve |
|---|---|---|---|
| 1 | GET non authentifié sur **88 routes protégées** → 401/403 | **PASS** | Les 88 routes rejettent (aucune fuite) |
| 2 | Jetons JWT falsifiés (`alg:none`, mauvaise signature, expiré, altéré) → 401 | **PASS** | Les 4 rejetés en 401 |
| 3 | Préflight CORS depuis `https://evil.example` | **PASS** | Aucun `Access-Control-Allow-Origin` renvoyé |
| 4 | Force brute login (12 essais) → blocage | **PASS** | `401×8` puis **429** (throttler) ; verrouillage de compte en plus |
| 5 | `/files` : lien non signé, signature falsifiée, `../` traversal | **PASS** | Tout rejeté (403/404) |
| 6 | Chaînes d'injection dans `?search=` → pas de 500, pas de fuite SQL | **FAIL** | L'octet nul `%00` provoque un **500** (voir F-04). Aucune fuite d'erreur SQL (message générique) |
| 7 | Corps JSON surdimensionné (2 Mo) → rejet | **PASS partiel** | Rejeté (limite ~100 Ko d'Express), mais **code 500** au lieu de 413 (voir F-04) |
| 8 | En-têtes de sécurité (helmet) présents | **PASS** | `x-content-type-options`, `x-frame-options`, `x-dns-prefetch-control`, HSTS présents |
| 9 | `POST /auth/register` après configuration (mode desktop) → 403 | **PASS** | Renvoie 403 (pas de second tenant créé) |
| 10 | `POST /setup/demo` après configuration → refusé | **PASS** | Renvoie 409 (pas de ré-amorçage destructeur) |
| 11 | Handshake socket.io `/tracking` sans jeton → rejeté | **PASS** | Handshake → 404/refus |
| 12 | Utilisateur faible privilège (chauffeur) sur 5 routes admin → 403 | **PASS** | `PUT /settings/feeds`, `PATCH /companies/me`, `POST /warehouses`, `POST /auth/invite`, `GET /analytics/overview` → tous 403 |

**Bilan sonde : 10 PASS, 1 FAIL, 1 PASS partiel.** Le login démo (`admin@demo-scip.com` /
`DemoPassw0rd!2026`) réussit et délivre un jeton **COMPANY_ADMIN** — c'est la constatation
centrale (F-01).

### Fuzzing du codec GT06

`node scripts/security/gt06-fuzz.mjs 300000` → **600 028 appels** de parsing (`readFrame`,
`decodeLogin`, `decodeLocation`, `decodeStatus`) sur des trames aléatoires et adverses.

- **PASS** : aucun plantage inattendu, aucun blocage (appel le plus lent : **1,18 ms**), aucune
  sur-allocation. Toute entrée renvoie une valeur, renvoie `null` (trame incomplète), ou lève
  `Gt06ProtocolError`. La passerelle borne déjà le tampon à 8 Ko et ferme toute socket sans login
  sous 30 s. Le codec est robuste face à des octets hostiles.

### Suite e2e existante (`npm run test:e2e`)

**N'a pas pu s'exécuter** — et ce n'est pas un problème de sécurité. `ts-jest` compile tout
`apps/api/src`, or le module `hazards` est **en cours de modification par un autre agent** : le
type `SourceId` (`hazard.types.ts:53`) a reçu `gdacs`/`eonet` mais `SOURCE_META`
(`hazards.service.ts:42`) ne les liste pas encore → erreur `TS2739`. La suite elle-même est bien
conçue (elle couvre l'isolation tenant et la matrice RBAC) ; elle passera une fois l'édition
`hazards` terminée. Les tests dynamiques ci-dessus couvrent le même terrain (RBAC, isolation) sur
l'API réellement en marche.

---

## 3. Dépendances vulnérables

Distinction importante : **l'arbre de développement** (racine) inclut la chaîne de build web
(serveur Next, sharp, postcss) qui **n'est pas embarquée** dans l'installeur — SCIP sert un export
statique via `express.static`, pas `next start`. La charge utile réellement livrée est bien plus
propre.

### 3.1 Node — arbre de dev vs livré

`npm audit --omit=dev` (racine, workspaces) : **13 vulnérabilités (2 critiques, 10 hautes, 1 moyenne).**

| Paquet | Gravité | Atteignable à l'exécution ? | Note |
|---|---|---|---|
| `next` | Critique (RCE `next start` Windows, image AVIF) | **Non** | SCIP livre un **export statique** ; aucun serveur Next ne tourne. Risque build-time uniquement. |
| `maplibre-gl` (5.24.0) | Critique (contournement sanitizer XSS) | Oui, côté client (WebView2 + PWA) | Livré dans `resources/web`. Exploitation nécessite du HTML non fiable passé à un popup maplibre — **le code construit les marqueurs en DOM, pas en `innerHTML`** (F-07). À mettre à jour. |
| `sharp`, `postcss` | Haute | **Non** | Outils de build de l'export web, non embarqués. |
| `multer`, `qs`, `js-yaml` | Haute/moyenne | **Non (déjà corrigé au livré)** | L'arbre de dev voit `<2.3.0` etc., mais le **payload installeur** embarque `multer 2.4.0`, `qs 6.16.0`, `js-yaml 5.3.0` — versions **corrigées**. |
| `nodemailer` (6.10.1) | Haute | Oui, mais **mail désactivé par défaut** sur desktop (`SMTP_HOST` non défini) | À monter en v7+ si l'envoi de mail est activé. |
| `prisma` / `@prisma/config` → `deepmerge-ts` | Haute | Marginale | CLI Prisma, exécutée seulement au démarrage pour `migrate deploy`, pas exposée à un attaquant. |

**Audit du payload réellement livré** (`resources/api/node_modules`) : **4 hautes seulement** —
`nodemailer` (mail off par défaut) et la chaîne `prisma → @prisma/config → deepmerge-ts` (CLI).
C'est la mesure qui compte pour un poste installé.

### 3.2 Python — sidecar IA (`pip-audit`)

**20 vulnérabilités dans 3 paquets.** Le sidecar écoute sur `127.0.0.1` uniquement, derrière un
jeton partagé — il n'est pas exposé au LAN.

| Paquet | Vulns | Atteignable | Note |
|---|---|---|---|
| `starlette` 0.41.3 | 8 (dont SSRF `StaticFiles` UNC Windows, DoS Range, Host non validé) | Via FastAPI | À monter (`fastapi`/`starlette`) ; portée limitée par l'écoute localhost + jeton. |
| `protobuf` 5.26.1 | 2 (DoS récursion) | Transitif (ortools/grpc) | DoS de parsing ; entrées non hostiles ici. |
| `pytest` 8.3.4 | 1 | **Dev uniquement** | Non embarqué. |

### 3.3 Rust — `cargo audit` (desktop + installeur)

**0 vulnérabilité.** 2 avertissements sans impact exploitable : `proc-macro-error 1.0.4`
(non maintenu) et `glib 0.18.5` (unsound `VariantStrIter`) — transitifs via Tauri, non atteignables
par une entrée utilisateur.

---

## 4. Constatations classées

Gravité : **Critique** > **Élevée** > **Moyenne** > **Faible** > **Info**.

### F-01 — Élevée — Comptes de démo à mot de passe public + API sur le LAN

- **Composant** : jeu de données démo + liaison réseau de l'API.
- **Fichiers** : `apps/api/prisma/seed.ts:33` (`DEMO_PASSWORD = 'DemoPassw0rd!2026'`),
  `apps/web/src/app/login/page.tsx:21` (constante + pré-remplissage `useEffect` ligne 55-61),
  `API.md:11`, `apps/desktop/src-tauri/src/provision/mod.rs:31` ; écoute `apps/api/src/main.ts:122`
  (`app.listen(port, '0.0.0.0')`).
- **Impact** : une build de démonstration crée 7 comptes (dont `admin@demo-scip.com`,
  **COMPANY_ADMIN**) avec un mot de passe documenté publiquement, et l'API écoute sur toutes les
  interfaces. **Quiconque sur le même Wi-Fi (une salle de classe) peut se connecter en
  administrateur de l'entreprise de démo.** Confirmé dynamiquement : le login renvoie un jeton
  COMPANY_ADMIN (HTTP 200). Un intrus peut inviter des utilisateurs, modifier l'entreprise, les
  entrepôts, etc.
- **Facteurs atténuants** : ne concerne **que les installations de démo** (données synthétiques,
  badgées `isDemoData`). Une installation **Production** utilise un mot de passe choisi par
  l'admin (donc F-01 ne s'y applique pas), et les clés d'API ne sont jamais renvoyées par l'API
  (seul un indice « ••••1234 » l'est). L'inscription/le ré-amorçage sont fermés après configuration
  (vérifié : 403/409).
- **Reproduction** : sur le LAN, `POST http://<PC>:3001/api/v1/auth/login` avec
  `{"email":"admin@demo-scip.com","password":"DemoPassw0rd!2026"}` → jeton admin.
- **Correctifs recommandés** :
  1. Pour une démo en public, **lier l'API à `127.0.0.1`** quand le simulateur/démo est actif, ou
     n'ouvrir `0.0.0.0` que si l'utilisateur active explicitement l'accès téléphones/traceurs.
  2. Au premier login d'un compte démo, **forcer le changement de mot de passe**, ou régénérer un
     mot de passe démo aléatoire affiché une seule fois à l'installation.
  3. Afficher un bandeau « mode démonstration — accessible sur le réseau local » dans l'UI.

### F-02 — Moyenne — Exposition LAN par conception (API 3001 + GT06 5023 sur `0.0.0.0`)

- **Composant** : API HTTP et passerelle GT06.
- **Fichiers** : `apps/api/src/main.ts:122`, `apps/api/src/modules/devices/device-gateway.service.ts:95`
  (`server.listen(port, '0.0.0.0')`), `DEPLOYMENT.md` (tableau réseau).
- **Impact** : l'API et la passerelle GPS sont accessibles à tout le sous-réseau. C'est **voulu**
  (téléphones chauffeurs et traceurs GT06 sur le LAN), mais cela élargit la surface : force brute
  du login, usurpation GT06 (F-03), et cible F-01 sur une build démo. En HTTP clair, les jetons et
  identifiants transitent en clair sur le LAN.
- **Facteurs atténuants** : throttling actif, verrouillage de compte, PostgreSQL et IA restent sur
  `127.0.0.1`. Le pare-feu Windows demande l'autorisation au premier lancement.
- **Correctif recommandé** : rendre l'exposition LAN **opt-in** (réglage « autoriser les
  téléphones/traceurs »), et documenter/planifier le HTTPS local (déjà cité comme limite connue
  dans `DEPLOYMENT.md`). Par défaut, `127.0.0.1` pour un poste mono-utilisateur.

### F-03 — Moyenne — Passerelle GT06 non authentifiée (usurpation de position)

- **Composant** : passerelle TCP GT06.
- **Fichiers** : `apps/api/src/modules/devices/device-gateway.service.ts`,
  `apps/api/src/modules/devices/gt06-codec.ts:194` (`decodeLogin` : l'IMEI est la seule
  « identité »).
- **Impact** : le protocole GT06 n'a **aucune authentification** — un appareil s'annonce par son
  IMEI en clair. Quiconque connaît (ou devine) un IMEI enrôlé peut, depuis le LAN, injecter de
  fausses positions pour ce véhicule. C'est une **limite inhérente au protocole** (les traceurs à
  15-50 € ne savent pas mieux faire), partagée par Traccar et tous les serveurs GT06.
- **Facteurs atténuants** : seuls les IMEI **enrôlés** sont acceptés (les inconnus sont fermés,
  `registerConnection` → false) ; validation de plausibilité des positions (vitesse implicite,
  « null island », horodatage futur) ; **codec prouvé robuste** au fuzzing (§2). L'impact est une
  fausse position, pas une exécution de code ni une fuite de données.
- **Correctif recommandé** : accepter que ce soit un risque résiduel du matériel bas coût ; le
  documenter ; si possible, restreindre le port 5023 aux IP attendues (pare-feu) et privilégier le
  chemin téléphone (secret d'appairage haché, lui authentifié — voir §5).

### F-04 — Faible — Erreurs non mappées → HTTP 500 (octet nul, corps trop grand)

- **Composant** : filtre d'exceptions global.
- **Fichier** : `apps/api/src/common/filters/all-exceptions.filter.ts:104-113` (ne traite que
  `PrismaClientKnownRequestError` et `PrismaClientValidationError`).
- **Impact** : deux entrées provoquent un **500** au lieu d'un code approprié :
  1. un octet nul `%00` dans un paramètre `?search=` → PostgreSQL rejette (`22021`), Prisma lève un
     `PrismaClientUnknownRequestError` non mappé → 500 (constaté dynamiquement) ;
  2. un corps JSON > ~100 Ko → `PayloadTooLargeError` (body-parser) non mappé → 500 au lieu de 413.
  **Aucune fuite** : le message renvoyé reste générique (« An unexpected error occurred »). C'est
  un défaut de robustesse/mapping, authentifié pour le cas (1), et sans crash du process.
- **Effet de bord fonctionnel à signaler** (hors périmètre correctif) : la limite de corps par
  défaut (~100 Ko) est inférieure aux photos de preuve de livraison encodées en base64 (le service
  de stockage tolère 10 Mo, `storage.service.ts:85`). L'upload de preuve risque d'échouer en 500.
  Un futur correctif devra **relever la limite pour ces routes sans supprimer la protection DoS**.
- **Correctif recommandé** : dans le filtre, mapper `PayloadTooLargeError` → 413 et
  `PrismaClientUnknownRequestError` → 400/503 ; fixer une limite `bodyParser` explicite et adaptée
  aux routes d'upload.

### F-05 — Faible — Jetons JWT : algorithme non épinglé (défense en profondeur)

- **Composant** : vérification JWT (API et gateway temps réel).
- **Fichiers** : `apps/api/src/modules/auth/jwt.strategy.ts:16-20`,
  `apps/api/src/modules/gps/tracking.gateway.ts:59` (`jwt.verify` sans option `algorithms`).
- **Impact** : l'algorithme accepté n'est pas explicitement épinglé à `HS256`. **Non exploitable
  ici** : le secret est symétrique (pas de clé publique), donc pas de confusion RS256→HS256 ;
  `alg:none` est déjà rejeté (vérifié dynamiquement, 401). C'est un durcissement recommandé.
- **Correctif recommandé** : passer `algorithms: ['HS256']` à `passport-jwt` et à
  `JwtService.verify`.

### F-06 — Faible — Jeton de rafraîchissement en `localStorage`

- **Composant** : client web / PWA.
- **Fichier** : `apps/web/src/lib/api.ts:35` (refresh en `localStorage`), l'access token reste en
  mémoire seulement.
- **Impact** : un refresh token en `localStorage` est lisible par toute XSS. Choix **documenté et
  assumé** (`api.ts:8-12`) : c'est un jeton **révocable** (rotation + détection de rejeu côté
  serveur), contrairement à un access token. Aucun sink XSS trouvé (§ F-07), CSP stricte sur le
  desktop (`script-src 'self'`).
- **Correctif recommandé (optionnel)** : à terme, refresh token en cookie `HttpOnly; SameSite`
  pour la PWA servie aux téléphones. Faible priorité vu la révocabilité et l'absence de sink XSS.

### F-07 — Info (bien traité) — Rendu des données externes sans sink XSS

- **Constat positif.** Les noms de stations, caméras, navires, indicatifs d'avions (données
  externes/non fiables) sont rendus **par DOM/SVG, jamais par `innerHTML`** :
  `apps/web/src/app/(app)/map/_components/vehicle-marker.ts:53`,
  `.../maritime/_components/vessel-marker.ts:47`,
  `.../dashboard/_components/corridor-map.tsx:156`. Les liens externes (MarineTraffic, VesselFinder)
  sont construits avec `encodeURIComponent` et ouverts dans le navigateur système. L'UI installeur
  échappe systématiquement (`esc()` dans `apps/installer/ui/installer.js:28`, journal live via
  `textContent`). Seul `maplibre-gl` (F-07/§3.1) présente une CVE de sanitizer, non atteinte par le
  code actuel mais à corriger par mise à jour.

### F-08 — Info (bien traité) — Installeur : intégrité et chemins

- **Constat positif.** L'extraction du payload interdit le **zip-slip** :
  `apps/installer/src-tauri/src/payload.rs:224` (`safe_relative_path` refuse `..`, chemins absolus,
  ADS `:`) et refuse les liens symboliques (ligne 189) — testé unitairement. La désinstallation
  auto-supprime son dossier via une commande `cmd` dont le chemin est **correctement entre
  guillemets** (`uninstall.rs:251`, `removal_command_line`) et garde-fous « est-ce bien un dossier
  SCIP » (`is_program_dir`/`is_data_dir`). Registre en **HKCU** (pas de droits admin), valeurs
  conformes.
- **Risque résiduel** : l'installeur est **non signé** (`DEPLOYMENT.md` §Signing,
  `tauri.conf.json` : pas de `certificateThumbprint`) → SmartScreen « Windows a protégé votre PC ».
  Le payload est collé en fin d'exe avec un pied de 32 octets **sans signature cryptographique** :
  l'intégrité (longueur/offset) est vérifiée, mais pas l'authenticité. Recommandé avant diffusion
  large : certificat de signature de code (OV/EV).

### F-09 — Info — Secrets locaux en clair (par conception, ACL utilisateur)

- **Fichiers** : `apps/desktop/src-tauri/src/secrets.rs` (`config.json` : secrets JWT, mot de passe
  Postgres, et URL de base externe **avec mot de passe** en mode external),
  `apps/api/src/modules/settings/feed-settings.service.ts:123` (`settings.json`, écrit en `0o600`).
- **Constat** : les secrets sont générés localement (48 octets, `getrandom`), jamais transmis
  ailleurs, et le fichier vit dans `%LOCALAPPDATA%` (ACL restreinte à l'utilisateur). Le
  provisionnement passe le plan (mots de passe compris) **sur stdin, jamais dans un fichier**, et
  **rédige** les secrets dans les logs (`provision/output.rs`, `redact` + `redact_url_passwords`).
  Le `Debug` de `DatabaseConfig::External` masque l'URL. C'est un compromis normal pour une appli
  de bureau sans coffre-fort ; les permissions de fichier sont le contrôle. **Rien à corriger**,
  documenté ici comme risque résiduel inhérent.

### F-10 — Info (bien traité) — Jeton IA et valeurs par défaut de dev

- Le sidecar IA exige un **jeton bearer partagé**, comparé en temps constant
  (`services/ai/app/main.py:97`, `hmac.compare_digest`), sur toutes les routes métier. Les valeurs
  par défaut `dev_only_*` (`services/ai/app/config.py:19`, `apps/api/src/config/configuration.ts:226`)
  ne servent qu'en développement : en desktop, le superviseur injecte un jeton aléatoire de 48
  octets (`services.rs:334`). En **production**, l'API refuse de démarrer si les secrets JWT sont
  faibles (`configuration.ts:161-171`). Bon.

---

## 5. Ce qui est bien fait

- **RBAC par permissions** (`packages/shared/src/rbac.ts`) : les gardes ne testent jamais un rôle
  en dur ; **156 routes sur 173 sont protégées par permission**, 13 publiques (toutes justifiées :
  auth, health, setup, `/files` signé, ingestion téléphone authentifiée par secret), 4 « tout
  utilisateur authentifié » qui agissent uniquement sur l'utilisateur courant (`me`,
  `change-password`, `logout-all`, `resend-verification`) — jugées correctes.
- **Isolation multi-tenant explicite** (`common/tenancy/tenant-scope.ts`) : filtre visible au
  point d'appel, `requireCompanyId` lève si oublié, un id d'un autre tenant renvoie 404 (pas 403,
  pour ne pas confirmer l'existence). Filtrage supplémentaire par rôle « partie prenante »
  (chauffeur/fournisseur/client).
- **Authentification** : Argon2id (baseline OWASP 19 Mio/t=2/p=1), hash leurre en temps constant
  contre l'énumération, verrouillage de compte progressif, jetons de rafraîchissement **opaques,
  hachés, avec rotation et détection de rejeu** (révocation de la famille entière).
- **Anti-SSRF sur toutes les sources externes** : caméras (liste blanche d'hôtes + re-vérification
  au moment du fetch, refus des redirections, `frame-guard.ts`), radio (regex d'hôte miroir + blocage
  des IP privées sur les URL de flux, `radio-browser.ts:95`), géocodage/trafic/avions/maritime
  (hôtes **fixes**, paramètres numériques ou encodés). Le client ne contrôle jamais l'hôte contacté.
- **SQL** : aucune concaténation. Le seul `$executeRawUnsafe` (`prisma/prisma.service.ts:42`) est
  gardé par `NODE_ENV=test` et ne prend pas d'entrée utilisateur. Tri paginé via liste blanche de
  colonnes (`safeOrderBy`).
- **Filtre d'exceptions** qui neutralise les erreurs Prisma (pas de noms de tables/SQL renvoyés).
- **Codec GT06 robuste** (600 k trames fuzzées sans incident) et passerelle qui borne le tampon et
  ferme les sockets sans login.
- **Installeur** : anti-zip-slip testé, désinstallation sûre, HKCU sans droits admin, redaction des
  secrets au provisionnement.

---

## 6. Risques résiduels inhérents à la conception

Ces points ne sont pas des bugs mais des conséquences de l'architecture « tout-en-un sur le poste » :

1. **Exposition LAN** (F-01/F-02) : servir les téléphones et traceurs impose une écoute réseau ; en
   HTTP clair sur le LAN, le trafic est interceptable. HTTPS local prévu (`DEPLOYMENT.md`).
2. **Protocole GT06 sans authentification** (F-03) : limite du matériel bas coût, pas du code.
3. **Installeur non signé** (F-08) : SmartScreen ; pas d'authenticité cryptographique du payload.
4. **Secrets locaux en clair** (F-09) : pas de coffre-fort sur un poste de bureau ; l'ACL
   utilisateur de `%LOCALAPPDATA%` est le contrôle.

---

## 7. Récapitulatif priorisé (pour correction)

| ID | Gravité | Constat | Correctif |
|---|---|---|---|
| F-01 | **Élevée** | Comptes démo à mot de passe public + API sur `0.0.0.0` → prise de contrôle admin sur le LAN | Lier `127.0.0.1` par défaut / forcer un mot de passe démo unique / bandeau démo |
| F-02 | Moyenne | Exposition LAN (3001 + 5023) par défaut | Rendre l'accès LAN opt-in ; HTTPS local |
| F-03 | Moyenne | Passerelle GT06 non authentifiée → usurpation de position | Accepter/documenter ; restreindre le port par pare-feu |
| F-04 | Faible | `%00` et corps trop grand → 500 (pas de fuite) ; limite de corps casse les uploads de preuve | Mapper `PayloadTooLargeError`→413 et l'erreur Prisma inconnue→400/503 ; limite de corps adaptée |
| F-05 | Faible | JWT sans épinglage d'algorithme | `algorithms: ['HS256']` à la vérification |
| F-06 | Faible | Refresh token en `localStorage` | Cookie `HttpOnly` pour la PWA (optionnel) |
| Dép. | Moyenne | `maplibre-gl` 5.24.0 (CVE sanitizer XSS) livré côté client | Mettre à jour maplibre-gl |
| Dép. | Faible | `nodemailer`/`starlette`/`protobuf` (exécution limitée) | Monter les versions ; mail off par défaut, IA en localhost |
| F-08 | Info | Installeur non signé | Certificat de signature de code avant diffusion |

## 8. Suivi des correctifs (29 septembre 2026)

| ID | Statut | Ce qui a été fait | Vérification |
|---|---|---|---|
| F-01 | **Corrigé** | API et passerelle GT06 liées à `127.0.0.1` par défaut. L'accès au réseau local s'active dans Réglages → Réseau local (effectif au redémarrage) ; tant que les comptes démo gardent le mot de passe public, l'activation exige une confirmation explicite (sinon 409). L'API temporaire de l'installeur n'est jamais exposée. | `netstat` : écoute sur `127.0.0.1:3101` et `127.0.0.1:15023` ; `PUT /settings/network {lanAccess:true}` en démo → 409 ; tests unitaires API et Rust |
| F-02 | **Corrigé (opt-in)** | Voir F-01 : plus d'exposition par défaut. HTTPS local reste à faire quand le réseau est activé. | idem |
| F-03 | Accepté | Limite du protocole GT06 ; la passerelle n'écoute plus le réseau tant que l'accès local n'est pas activé. | — |
| F-04 | **Corrigé** | Corps limité à 2 Mo (70 Mo sur `/deliveries` pour les photos) ; corps trop grand → 413, JSON invalide et entrée refusée par PostgreSQL → 400. | `probe.mjs` : octet nul → pas de 500 ; 2 Mo → 413 ; tests du filtre |
| F-05 | **Corrigé** | Vérification des jetons limitée à `HS256` (HTTP et socket de suivi). | JWT falsifiés → 401 (probe) |
| F-06 | Accepté | Choix documenté (jeton d'accès en mémoire, jeton de rafraîchissement révocable). | — |
| Dép. maplibre-gl | Reporté | Correctif uniquement en v6 (rupture d'API sur 8 composants de carte). Faille non atteignable : SCIP ne passe jamais de HTML à MapLibre. Migration notée dans `ROADMAP-presentation.md`. | revue du code : aucun `Popup`/`setHTML` |
| Dép. nodemailer | **Corrigé** | 6.10.1 → 10.0.12. | suite API verte |
| Dép. starlette/protobuf | Reporté | Service IA en `127.0.0.1` avec jeton ; montée de version à faire avec le reste des dépendances IA. | — |
| F-08 | Accepté pour la présentation | Certificat de signature de code avant toute diffusion publique. | — |

Nouvelle passe de `scripts/security/probe.mjs` après correctifs : **12 contrôles réussis, 0 échec**
(88 routes protégées, JWT falsifiés, CORS, force brute, `/files`, injections, corps trop grand,
en-têtes, inscription fermée, démo refusée, socket sans jeton, chauffeur sur routes admin).

*Fin de l'audit.*
