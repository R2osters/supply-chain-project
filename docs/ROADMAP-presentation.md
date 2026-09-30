# Ce qu'il manque pour présenter un projet complet

État au 29 septembre 2026, après le passage en logiciel Windows, l'installeur sur mesure, les
sources sans clé et l'audit de sécurité ([security-audit.md](security-audit.md)).

## Ce qui est déjà solide

| Domaine | Contenu |
|---|---|
| Installation | `SCIP-Setup.exe` sur mesure (un fichier, sans droits admin), mise à jour qui conserve les données, désinstallation propre, base intégrée ou PostgreSQL existant, organisation / sites / administrateur créés à l'installation |
| Suivi (TRACK) | Carte live des camions (GPS balises GT06, téléphone chauffeur, simulation), positions estimées quand le GPS se tait, navires (AIS : mer Baltique sans clé, monde avec clé), avions (OpenSky / adsb.lol), trafic routier en direct partout (véhicules simulés sur les vraies routes comme God's Eye View, vitesses mesurées à Rennes et Grenoble sans clé, dans le monde entier avec une clé TomTom, flotte toujours au-dessus), situation (séismes, cyclones, inondations, sécheresses, volcans, feux, météo, caméras publiques, radio, satellites), incidents, livraisons avec preuve (signature, photos) |
| Optimisation (OPTIMISE) | Prévisions de demande, recommandations de commande expliquées, allocation fournisseurs (MILP), tournées (VRP), scénarios, risque de retard |
| Réseau | Fournisseurs (score de performance), commandes d'achat, stocks, référentiel complet (produits, entrepôts, véhicules, chauffeurs, clients, transporteurs) |
| Sécurité | Rôles et permissions, isolation des données, Argon2id, verrouillage de compte, jetons rafraîchis avec détection de rejeu, API limitée à ce PC par défaut, audit dynamique rejouable (`scripts/security/`) |
| Qualité | 471 tests API, 130 tests web, 119 tests Rust (application) + 61 (installeur) + 17 (écrans de l'installeur), CI qui produit l'installeur |

## Manques, par priorité

### P0 — à faire avant de présenter

| # | Manque | Pourquoi c'est bloquant | Effort |
|---|---|---|---|
| 1 | ~~**Gestion des utilisateurs**~~ **Fait** | Écran Utilisateurs : liste, création avec mot de passe temporaire (montré une fois), rôle, lien chauffeur, désactivation, réinitialisation par l'administrateur. Changement obligatoire du mot de passe temporaire à la connexion, imposé par l'API (HTTP et socket de suivi). Chaque rôle arrive sur une page qu'il a le droit d'ouvrir (chauffeur → livraisons). | — |
| 2 | ~~**Mot de passe oublié sans e-mail**~~ **Fait** | « Mot de passe oublié ? » sur l'écran de connexion : dans l'application de ce PC, un administrateur reçoit un mot de passe temporaire (jeton local connu du seul shell, API en `127.0.0.1`) ; ailleurs, l'administrateur réinitialise depuis Utilisateurs. | — |
| 3 | ~~**Cartes hors connexion**~~ **Fait** | Fond de carte monde Natural Earth embarqué (côtes, frontières, fleuves, lacs, villes, 4 Mo) sous les tuiles OpenStreetMap : sans internet, les six cartes restent lisibles. Pas de détail rue par rue hors ligne. | — |
| 4 | ~~**Scénario de démonstration**~~ **Fait** | Réglages → « Préparer la démo » remet le monde de démo en scène à l'instant présent (camions repartis, 2 retards détectés en direct, rupture SKU-006, recommandations effacées), autant de fois que voulu ; script minuté de 10 minutes dans `docs/DEMO-scenario.md`. | — |
| 5 | ~~**Sauvegarde et restauration en un clic**~~ **Fait** | Réglages → Sauvegarde : un fichier `.scip-backup` (base + preuves de livraison, sans secrets) dans `Documents\SCIP\Sauvegardes` ; restauration avec sauvegarde de sécurité automatique et retour arrière si elle échoue ; aussi `scip-desktop.exe --backup` / `--restore`. | — |

### P1 — pour un projet « complet »

| # | Manque | Effort |
|---|---|---|
| 6 | Exports CSV / Excel des listes (expéditions, stocks, commandes, fournisseurs) et PDF du bon de commande et du bon de livraison | 1 j |
| 7 | Notifications Windows natives (retard, incident, rupture) | 0,5 j |
| 8 | Journal d'audit consultable (les actions sont déjà enregistrées, aucun écran ne les montre) | 0,5 j |
| 9 | Import CSV (produits, fournisseurs, stocks) pour démarrer vite avec de vraies données | 1 j |
| 10 | Double authentification (application TOTP + codes de secours), comme dans le prototype | 1 j |
| 11 | Nouvel écran de connexion du prototype | 0,5 j |
| 12 | Mises à jour automatiques (Tauri updater + versions publiées) | 1 j |
| 13 | HTTPS sur le réseau local pour que le téléphone du chauffeur donne sa position GPS | 1 j |
| 14 | Routage routier réel (OSRM) au lieu de la distance à vol d'oiseau × 1,25 | 0,5 j |

### P2 — finition et soutenance

| # | Manque |
|---|---|
| 15 | Mises à jour de dépendances signalées par l'audit : `maplibre-gl` (v6, faille non atteignable ici), `nodemailer`, `starlette`/`protobuf` côté IA |
| 16 | Certificat de signature de code (sinon avertissement SmartScreen) |
| 17 | Tests de bout en bout sur l'exécutable (parcours installation → connexion → expédition) |
| 18 | Manuel utilisateur, captures, courte vidéo de démonstration |
| 19 | Réduire l'installeur (324 Mo, surtout le moteur IA) |
| 20 | Relecture du texte de licence de l'installeur |

## Sources de données : ce qui marche sans clé

| Couche | Sans clé | Avec une clé (gratuite, compte à créer soi-même) |
|---|---|---|
| Navires | Mer Baltique en direct (Digitraffic, Finlande) | Monde entier : AISStream |
| Avions | Monde (OpenSky anonyme, 400 requêtes/jour, puis adsb.lol) | Quota ×10 : identifiants OpenSky |
| Catastrophes | Séismes (USGS), cyclones (NOAA, GDACS), inondations, sécheresses, volcans (GDACS), feux (NASA EONET, GDACS) | Détections satellite des feux au jour près : NASA FIRMS |
| Trafic routier | Non disponible | TomTom |
| Météo, caméras, radio, satellites, géocodage | Oui | — |

Les clés se saisissent dans **Réglages → Sources de données**, ou s'intègrent à sa propre version de
l'installeur via `apps/desktop/keys.local.json` (voir `keys.example.json`). Une clé intégrée à un
installeur est lisible par quiconque a ce fichier : réserver ces versions à son propre usage.
