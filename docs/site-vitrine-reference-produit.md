# Site vitrine SCIP : référence produit

Ce que le site a le droit de dire et de montrer. Chaque fait ci-dessous a été vérifié dans le dépôt
le 2 octobre 2026 (branche `master`, version 0.2.1) ; la source est entre parenthèses. Un fait absent
de cette fiche se vérifie dans le code avant d'être écrit, ou porte l'étiquette « démo ».

## 1. Ce qu'est SCIP

- Un logiciel Windows tout-en-un (Tauri 2) : l'application lance sa propre base PostgreSQL 16 +
  PostGIS, son API et son moteur IA, sur le PC. Aucun serveur, aucun abonnement, aucune clé requise
  (`README.md`, `docs/adr/0001-logiciel-de-bureau-tout-en-un.md`).
- Deux moitiés et une boucle : **Track** suit la marchandise, **Optimise** décide quoi commander,
  chez qui, quand et par quelle route ; une recommandation acceptée devient un vrai bon de commande
  brouillon. Rien n'est exécuté sans accord humain (`README.md`, `docs/DEMO-scenario.md`).
- Projet d'école, personnel et non commercial. Pas de clients, pas de prix, pas de témoignages.
- Ce que SCIP n'est pas : un SaaS, un service cloud, une application Mac ou Linux, une application
  mobile native. Le chauffeur utilise une page web (`/drive`) ouverte sur son téléphone.

## 2. Charte

Source unique : `apps/web/src/app/globals.css` (bloc `@theme`). `docs/PROMPT-CLAUDE-DESIGN.md`
décrit l'ancien style sombre et ambre : périmé. Le checkout principal du dépôt (ancienne `master`
locale) rend encore cet ancien style : ne pas le capturer.

| Rôle | Valeur |
|---|---|
| Fond, surface, surface 2, filet | `#e3e4e6`, `#f1f2f3`, `#ffffff`, `#d6d8db` |
| Encre = seule couleur d'action | `#141516` (texte sur encre `#ffffff`) |
| Texte secondaire, discret, fond de carte | `#5c6166`, `#747a80`, `#dcdee1` |
| Événements, petites surfaces seulement | crit `#c8412f`, warn `#a8740f`, ok `#3f8a5c`, live `#2f8a55`, info `#3b6fb0` |
| Violet = démo ou simulé, aucun autre usage | `#6e56c9` |
| Rayons | 4, 6, 10, 14 px |
| Ombres | `0 1px 2px /.08`, `0 6px 18px /.14`, `0 20px 48px /.24` |
| Polices du logiciel | IBM Plex Sans, IBM Plex Sans Condensed, IBM Plex Mono |

Logo « conteneur localisé » (hexagone + point) : composant `Logo` dans
`apps/web/src/components/ui.tsx`, source `apps/desktop/src-tauri/icons/source.svg`.

Un écran du logiciel reproduit sur le site utilise les polices du logiciel (IBM Plex), même si le
site a sa propre typographie d'affichage.

## 3. Les vrais écrans

Structure (`apps/web/src/app/(app)/layout.tsx`, `apps/web/src/lib/nav.ts`) : pas de rail latéral.
Une barre haute collante : logo hexagone + « SCIP », sélecteur segmenté des trois piliers en
capitales (TRACK · OPTIMISE · RÉSEAU), champ « Rechercher expéditions, véhicules, navires, SKU… »
avec la touche « / », pastille « IA en ligne » / « IA hors ligne », cloche « Alertes », menu du
compte. Dessous, les onglets du pilier actif. Libellés français : `apps/web/src/lib/i18n.tsx`.
En mode démo, la barre porte aussi la pastille violette « ESPACE DÉMO », le choix EN / FR et le
bouton de thème.

Les captures réelles de la version 0.2.1 sont dans `docs/captures/v0.2.1/` (index et état de chaque
écran dans son `README.md`). Un écran montré sur le site est l'une de ces captures.

| Pilier | Onglets, dans l'ordre (libellé exact) |
|---|---|
| Track | Control · Carte live · Situation · Expéditions · Incidents · Livraisons · Navires · Balises |
| Optimise | Conseils · Prévisions · Allocation · Scénarios · Tournées |
| Réseau | Fournisseurs · Commandes · Stocks · Référentiel |
| Menu du compte | Utilisateurs · Réglages · Mon mot de passe |
| À part | Alertes (cloche) · Drive (page du chauffeur, `/drive`) |

En français, l'écran dit « OPTIMISE », jamais « OPTIMIZE ».

Éléments réels, par écran (`docs/DEMO-scenario.md`, pages sous `apps/web/src/app/(app)/`) :

- **Control** : panneau « Boucle de décision » en quatre étapes : 01 « TRACK détecte », 02 « OPTIMISE
  recalcule » (prévision, allocation, tournées), 03 « Recommandation », 04 « Décision humaine · BC
  créé ». Panneau « File d'alertes ». Raccourcis J/K, A, W.
- **Carte live** : titre « … véhicule(s) en écart · 2 en retard », filtres dont « En retard » et
  « Démo », panneau de droite « Expédition à bord » (destination, ETA, « Risque de retard »), « Météo
  au véhicule », « Caméras publiques les plus proches ». Ligne d'état « Trafic simulé sur routes
  réelles · vitesses estimées ». Légende « Simulé ». Un GPS muet donne « Position estimée » avec un
  **cercle d'incertitude en pointillé** et « Estimée ±N km » : ce n'est pas un tracé en pointillé.
- **Conseils** : « Pourquoi cette recommandation ? » (résumé, raisons, hypothèses), boutons
  « accepter et exécuter » et « écarter », « régénérer les recommandations ».
- **Stocks** : recherche « référence ou nom », « Alertes ouvertes », « Projection 10 j »,
  « Demander une recommandation ».
- **Commandes** : origine « Recommandation », menu « passer à… » (En attente, Confirmée).
- **Situation** : « Signaux classés », « Exposition », « Sources ». Un incident se crée à la main
  depuis un signal.
- **Prévisions** : six modèles comparés par validation glissante, tableau de tous les WAPE.
- **Scénarios** : Monte-Carlo, 2 000 itérations par défaut (`services/ai/app/config.py`).
- **Étiquettes de provenance** : « démo », « données démo », « Expédition démo », « Simulé »,
  « Espace démo ».

Il y a six cartes dans le logiciel : Control (corridor), Carte live, Navires, Situation, fiche
d'expédition, Tournées. Toutes restent lisibles hors ligne ; la carte des tournées n'est pas
« en direct ».

## 4. Le jeu de démo

Entreprise « Demo Distribution Ghana », devise GHS (`apps/api/prisma/seed.ts`,
`docs/DEMO-scenario.md`).

| Sujet | Valeur réelle |
|---|---|
| Entrepôts | Accra Central DC (principal, `WH-ACC`) · Kumasi Regional DC (`WH-KUM`) · Takoradi Port Store (`WH-TAK`) |
| Fournisseurs | SUP-A Volta Grain Cooperative (Ho) · SUP-B Sahel Commodities Ltd · SUP-C Tema Port Distributors (Tema) · SUP-D Ashanti Wholesale Group (Kumasi) · SUP-E Abidjan Import Partners |
| Ponctualité mesurée | SUP-C 96,9 % · SUP-A 94,8 % · SUP-D 89,3 % · SUP-B 79,2 % · SUP-E 74,2 % (`README.md`) |
| Expéditions | `SHP-DEMO-0041` à `SHP-DEMO-0055` |
| Retards de la démo | `SHP-DEMO-0054` (Accra → Kumasi) et `SHP-DEMO-0055` (Tema → Takoradi), détectés en direct |
| Pénurie de la démo | SKU-006 (« Bottled water 12×1.5 L ») : environ 620 unités à Accra Central DC pour 310 vendues par jour, soit deux jours de stock, sous le point de commande (1 466) |
| Conseils réellement produits | changer de fournisseur (Abidjan Import Partners, 72 % de ponctualité) · réduire le stock du SKU-008 (158 jours de couverture) |
| Prévision du SKU-006 | 9 102 unités sur 30 jours, « gradient boosting » retenu parmi six modèles |
| Navires | huit navires de démo ; recherche par nom, IMO ou MMSI (exemple : « Ashanti ») |
| Comptes | Admin société, Supply chain, Logistique, Achats, Entrepôt, Chauffeur |

`SHP-0142` n'existe pas dans le logiciel : c'est l'expédition du film « Le Signal ». « 3 000 unités
chez le fournisseur C » vient du schéma du `README.md` : une illustration, pas un écran. En 0.2.1, le
scénario de démo ne produit d'ailleurs aucune recommandation de commande pour le SKU-006 (défaut
relevé dans `docs/captures/v0.2.1/README.md`) : le site ne montre pas cet écran tant qu'il n'existe
pas.

## 5. Chiffres autorisés

| Chiffre | Source |
|---|---|
| 798 tests automatisés (API, web, application, installeur) | `docs/ROADMAP-presentation.md`, compté le 29 septembre 2026 |
| 6 cartes, lisibles hors ligne ; fond de carte embarqué de 4 Mo (Natural Earth) | idem |
| 1 fichier d'installation, 0 clé requise | idem |
| 6 modèles de prévision comparés | `README.md` |
| 10 moteurs IA derrière 10 points d'accès | `README.md` (le site en cite six : les fonctions d'Optimise) |
| 2 000 itérations Monte-Carlo par défaut | `services/ai/app/config.py` |
| Port TCP 5023 pour les balises GT06 / Concox | `README.md` |
| ETA recalculée toutes les 30 secondes | `docs/DEMO-scenario.md` |
| Dangers relevés toutes les 5 minutes | idem |
| Version 0.2.1, installeur `SCIP-Setup-0.2.1.exe`, 342 Mo (342 425 532 octets) | release GitHub `v0.2.1` |
| Film « Le Signal » : 170 s, 120 BPM, 85 mesures, 18 scènes, 1920×1080, 30 i/s | spec du film |

## 6. Sources de données

| Couche | Sans clé | Avec une clé |
|---|---|---|
| Navires | mer Baltique (Digitraffic) | monde (AISStream) |
| Avions | monde (OpenSky anonyme, puis adsb.lol) | quota ×10 (identifiants OpenSky) |
| Trafic routier | véhicules simulés sur les vraies routes ; vitesses mesurées à Rennes et Grenoble | monde (TomTom) |
| Dangers | séismes (USGS), cyclones (NOAA, GDACS), inondations, sécheresses, volcans, feux (GDACS, NASA EONET) | feux au jour près (NASA FIRMS) |
| Météo, caméras publiques, radio, satellites | oui | — |

Les véhicules du trafic sont toujours simulés. Les camions de la démo sont simulés et marqués.

## 7. Installation

- Prérequis vérifiés par l'installeur : Windows 10 (1809) ou plus récent, 2 Go de disque, 4 Go de
  mémoire, WebView2 (`docs/installer.md`).
- Écrans réels de l'installeur : 01 Bienvenue · 02 Licence · 03 Système · 04 Type (Production ou
  Démonstration) · 05 Base de données (Intégrée ou Existante) · 06 Organisation · 08 Administrateur ·
  09 Récapitulatif · 10 Installation · 11 Terminé. Interface : `apps/installer/ui/`.
- Sans droits administrateur ; installation dans le profil de l'utilisateur.
- Mises à jour : c'est SCIP, pas l'installeur, qui cherche les versions sur GitHub, télécharge,
  vérifie la taille, l'empreinte SHA-256 et la signature Ed25519, sauvegarde les données, puis
  installe en un clic ou à la fermeture.
- Désinstallation : un écran de confirmation avec la case « Supprimer aussi mes données », décochée
  par défaut.
- Sauvegarde : un fichier `.scip-backup` dans `Documents\SCIP\Sauvegardes`.
- L'installeur n'a pas de certificat de signature de code : Windows SmartScreen affiche un
  avertissement au premier lancement (`docs/ROADMAP-presentation.md`, point 16).
- Lien de téléchargement stable : `https://github.com/R2osters/supply-chain-project/releases/latest`.

## 8. Limites à ne pas masquer

- Téléphone du chauffeur : la page `/drive` enregistre les livraisons, les signatures et les photos
  hors connexion et synchronise ensuite. Elle cesse de transmettre la position dès que l'écran
  s'éteint (`TRACKING.fr.md`), et la position GPS exige HTTPS sur le réseau local, pas encore livré
  (`docs/ROADMAP-presentation.md`, point 13).
- Un retard ne crée pas d'incident : il passe l'expédition « en retard », envoie une alerte et
  déclenche le recalcul d'Optimise. Les incidents se déclarent à la main.
- Isolation des données : chaque entreprise ne voit que les siennes, par un filtre explicite dans
  l'API (`docs/security-audit.md`). Ce n'est pas un cloisonnement fait par la base.
- Distance routière : vol d'oiseau × 1,25 tant qu'aucun serveur OSRM n'est branché.
- Pas d'export CSV ou PDF, pas de double authentification, pas de notifications Windows natives
  (`docs/ROADMAP-presentation.md`, P1).
- Champs qui n'existent pas dans le référentiel : criticité d'un produit, priorité d'un client,
  contrat d'un transporteur, litiges d'un fournisseur (`apps/api/prisma/schema.prisma`).
