# Prompt — Refonte de l'interface SCIP (pour Claude Design)

> Copier tout ce qui suit dans Claude Design.

---

## Rôle et mission

Tu es directeur·rice artistique et designer produit senior, spécialisé·e dans les interfaces opérationnelles denses (salles de contrôle, logistique, finance temps réel). Ta mission : **repenser le design complet de SCIP**, une plateforme web de supply chain déjà fonctionnelle. Tu livres un design system et les maquettes de tous les écrans listés plus bas. Tu ne changes pas les fonctionnalités : chaque donnée, filtre et action existants doivent rester présents. Tu peux les réorganiser, les hiérarchiser autrement et proposer de meilleurs patterns.

## Le produit

**SCIP — Supply Chain Intelligence Platform.**
Promesse : *suivre la marchandise de la porte du fournisseur jusqu'au quai du client, et décider quoi commander, à qui, quand et par quelle route.*

Deux piliers réunis en un seul produit :

1. **TRACK (suivre)** : camions en GPS temps réel, navires en AIS, livraisons, incidents, anomalies de trajet, flux de situation (catastrophes naturelles, caméras publiques, radio, satellites, trafic).
2. **OPTIMISE (décider)** : prévisions de demande (6 modèles comparés), allocation fournisseurs (optimisation MILP), tournées de véhicules (CVRP), simulations what-if Monte-Carlo, recommandations IA expliquées.

La boucle est fermée : TRACK détecte un retard, OPTIMISE recalcule le risque de rupture et recommande une commande, un humain accepte, un vrai bon de commande est créé.

**Marché** : Afrique de l'Ouest, Ghana en premier (monnaie par défaut : cedi, GHS ; corridor de démo Accra–Kumasi ; fournisseurs de Tema, Volta, Ashanti, Sahel, Abidjan). Bilingue **FR / EN** (zones anglophones et francophones). Connectivité parfois faible, matériel à bas coût (téléphone du chauffeur à 0 €, tracker GT06 à 15–50 €).

**Principe non négociable, l'honnêteté des données** : toute donnée synthétique ou simulée porte une étiquette « démo » visible. Les sources en direct et les sources simulées sont toujours distinguées (live AIS / simulé, streaming / polling, IA en ligne / hors ligne). Le design doit rendre cette distinction lisible au premier coup d'œil, jamais la cacher.

## Utilisateurs

| Rôle | Contexte d'usage | Écrans principaux |
|---|---|---|
| Opérateur de salle de contrôle / dispatcher | Écran ouvert 8 h par jour, grand moniteur, veut repérer une anomalie en 2 secondes | Control, Live map, Situation, Shipments, Incidents |
| Responsable supply chain / planificateur | Analyse, compare, décide | Advice, Forecasting, Allocation, Scenarios |
| Responsable achats | Fournisseurs, bons de commande | Suppliers, Orders, Advice |
| Responsable logistique | Flotte, tournées, livraisons | Routing, Deliveries, Devices, Vessels |
| Responsable d'entrepôt | Stocks, alertes | Inventory |
| Chauffeur | Téléphone, en cabine, soleil, gants, réseau instable | /drive (PWA) |
| Admin | Tout | Tout |

Rôles techniques (RBAC) : SUPER_ADMIN, COMPANY_ADMIN, SUPPLY_CHAIN_MANAGER, LOGISTICS_MANAGER, PROCUREMENT_MANAGER, WAREHOUSE_MANAGER, DRIVER, SUPPLIER, CUSTOMER, VIEWER. Les éléments de navigation sont masqués selon les permissions : le design doit rester cohérent quand un groupe entier disparaît.

## Stack (contraintes d'implémentation)

- Next.js 15 (App Router), React 19, toutes les pages sont des composants client.
- **Tailwind CSS v4** ; les tokens sont dans un bloc `@theme` de `globals.css` (pas de tailwind.config).
- **Aucune librairie UI** (pas de shadcn ni Radix) : composants faits main. Tu peux proposer d'en adopter une si c'est justifié.
- **Aucune librairie d'icônes** aujourd'hui (quelques SVG inline et des flèches texte `→ ↗ ›`). Propose un système d'icônes (Lucide, Phosphor ou autre) et son usage.
- Cartes : **MapLibre GL** avec tuiles raster OpenStreetMap assombries (pas de Mapbox, uniquement des sources gratuites et sans clé).
- Graphiques : **Recharts** (AreaChart, BarChart, ComposedChart).
- Temps réel : Socket.IO (positions de véhicules et de navires ; les marqueurs glissent entre deux positions).
- i18n maison FR/EN ; les dates et nombres passent par Intl (`fr-FR` / `en-GB`). Prévois des libellés français environ 30 % plus longs que l'anglais.

## Design actuel (point de départ)

Style « salle de contrôle / tableau d'instruments », **dark uniquement**.

- **Fond** : grille discrète de 44 px et grain de film en overlay.
- **Coins** : vifs (rayon 2–3 px). Les panneaux ont des « ticks » d'angle : ambre en haut à gauche, hairline claire en bas à droite.
- **En-têtes de section** : microtypographie mono en majuscules, 9–10 px, tracking 0.14–0.2em.
- **Animations** : fade-up `.rise` au chargement, pulsation `.live-dot`, scanline ambre de chargement ; `prefers-reduced-motion` respecté.

Tokens :

| Groupe | Valeurs |
|---|---|
| Surfaces | void `#08090a`, deck `#0c0e10`, panel `#121517`, panel-raised `#171b1e`, hairline `#21272b`, hairline-bright `#2e363b` |
| Texte | ink `#e6e9ea`, ink-dim `#97a1a6`, ink-faint `#5c666b` |
| Signal (primaire) | ambre `#ffb020` (dim `#6b4a12`), hover `#ffc24d`, texte sur ambre `#16110a` |
| États | ok `#3fcf8e` / `#14402f` · warn `#ffa53d` / `#4a3212` · alert `#ff5f56` / `#4a1d1b` · info `#4ea8ff` / `#14314d` |
| Carte océan | `#070c12` |
| Typo | Archivo 400–700 (display et texte) ; JetBrains Mono 400–600 (chiffres, identifiants, libellés) ; chiffres tabulaires |

Composants existants : Panel (titre, meta, actions, loading, ticked), Chip (ok, warn, alert, info, signal, neutral), Kpi, Meter (barre de 4 px), Empty, Loading, ErrorNote, DemoTag, Explain (résumé, raisons, hypothèses repliables), grid-table (en-tête sticky mono, survol ambre), field, btn / btn-primary / btn-danger, live-dot.

**Problèmes connus à résoudre** :

- Composants redéfinis localement dans chaque page (`Tile`, `StatTile`, `Metric`, `MetricLine`, `Row`, `Legend`, `Cell`) : il faut un jeu unique et cohérent.
- Tailles de texte très petites (9 px) : risque de lisibilité et d'accessibilité sur 8 h d'usage.
- Aucune iconographie : la navigation et les états reposent uniquement sur le texte et la couleur.
- Ambre utilisé à la fois comme couleur de marque, d'accent et de sélection, et proche de « warn » `#ffa53d` : risque de confusion entre sélection et avertissement.
- Page Routing sans carte des tournées.
- Pas de mode clair (à évaluer, voir livrables).

## Structure de l'app

### Shell authentifié

- **Sidebar** sticky de 190 px :
  - wordmark « SCIP » mono ambre ;
  - 3 groupes de navigation :
    - **Track** : Control, Live map, Vessels, Situation, Shipments, Deliveries, Devices, Incidents ;
    - **Optimise** : Advice, Forecasting, Allocation, Routing, Scenarios ;
    - **Master data** : Inventory, Orders, Suppliers ;
  - item actif : texte ambre, fond teinté, barre de 2 px à gauche ;
  - pied : statut « IA en ligne / hors ligne » (point live), sélecteur FR/EN, nom de l'utilisateur, rôle, déconnexion.
- **Topbar** sticky translucide avec flou : fil d'Ariane mono en majuscules et lien « Alerts » avec badge du nombre de non-lues.
- **Chargement** : « Establishing session… ».

### Écrans à maquetter (tous)

**Accès**

1. **/login** : carte en 2 colonnes.
   - **Gauche** : wordmark, version, tagline, description, tracé Accra→Kumasi en pointillé, grille 2×2 de capacités (GPS live, AIS live, Prévisions « 6 modèles », Allocation « MILP, OR-Tools »).
   - **Droite** : bascule FR/EN, champs email et passphrase, bouton Sign in, liste cliquable des 6 comptes de démo par rôle.

**TRACK**

2. **/dashboard « Control »**
   - 6 KPI : expéditions actives, à risque, livrées aujourd'hui, valeur du stock (GHS), exceptions de stock, flotte qui émet x/y.
   - Bandeau « données de démo ».
   - Graphique en aires « flux d'expéditions sur 30 jours » (créées, livrées, en retard).
   - « Performance de livraison sur 90 jours » : % à l'heure, retard moyen, retard p90, erreur d'ETA.
   - Barres de fiabilité fournisseurs.
   - Panneau « Que faire ensuite » : top 4 des recommandations IA (priorité, raisons, delta de coût).
3. **/map « Live map »**
   - Carte flotte plein écran. Marqueurs en chevrons orientés selon le cap : vert (roule, à l'heure), ambre (risque de retard ≥ 50 %), rouge (en retard), gris (à l'arrêt). Entrepôts en losanges bleus.
   - En-tête : point streaming/polling, « N en mouvement · N qui émettent », bascule du calque trafic.
   - Colonne de 320 px : liste de la flotte, ou le détail d'un véhicule (plaque, chauffeur, vitesse, cap, dernière position, expédition liée avec ETA et risque, météo sur place, caméras publiques proches) ; légende.
4. **/maritime « Vessels »**
   - Recherche unique (nom, IMO, MMSI, indicatif) ; résultats « lu comme… », chips flotte propre / AIS public.
   - Carte océan : coques orientées, trajet prévu en pointillé bleu et trajet réel en ambre.
   - Panneau voyage : type, pavillon, nœuds, cap, ports origine→destination, barre de progression, milles restants, horaire prévu vs ETA, bandeau avance/retard, expéditions liées, liens MarineTraffic et VesselFinder.
   - Statut de la source AIS.
5. **/situation « Situation room »** (vue de type « God's Eye »)
   - Carte plein écran avec, en overlay, une recherche de lieu et des pastilles de calques : Dangers, Caméras, Radio, Satellites, Trafic.
   - Dangers affichés : cyclones (cône et trajectoire), séismes, feux, météo sévère.
   - Colonne de 340 px, selon la sélection :
     - visionneuse caméra (image live, intervalle de rafraîchissement, note de confidentialité) ;
     - lecteur radio ;
     - détail d'un danger (sévérité, météo, actualités locales GDELT) ;
     - par défaut, un **panneau d'exposition** : entrepôts, expéditions et fournisseurs à moins de X km d'un danger.
   - Panneau satellites (constellation, nombre de visibles, qualité du fix) et panneau sources (statut par flux, attribution, budget de tuiles).
6. **/shipments** : tableau filtrable (recherche, statut, « ouvertes seulement », pagination).
   - Colonnes : Tracking, Statut (+ chip anomalie), Route, Transporteur, Véhicule, Progression, Promis, ETA, Risque de retard, tag démo.
7. **/shipments/[id]**
   - En-tête : numéro de suivi (mono ambre), statut, origine→destination, km. Actions : recalculer l'ETA, prédire le retard, scanner les anomalies.
   - Bandeau de 5 cellules : départ, promis, estimé, risque, distance parcourue.
   - Carte du trajet (prévu vs réel) et journal d'événements en timeline verticale.
   - Panneau « moteur d'ETA » : heure en grand, fenêtre à 80 %, jauge de confiance, bandeau de retard, raisons et hypothèses.
   - Liste d'anomalies (type, sévérité, score).
8. **/deliveries**
   - 4 tuiles : Planifiées, Terminées, Restantes, Échouées.
   - Tableau de la tournée du jour avec jauge d'avancement. Colonnes : expédition, statut, client, destination, ETA, tentatives, note.
   - Mention de la preuve de livraison.
9. **/devices**
   - Statut de la passerelle matérielle (port TCP, paquets).
   - « Enrôler un appareil » : 4 cartes de type (téléphone du chauffeur, GT06, Teltonika, manuel), puis un formulaire. Affiche ensuite un secret d'appairage à usage unique, les étapes d'installation et « copier le lien chauffeur ».
   - Tableau : type, identifiant, véhicule, statut, vu il y a, acceptés, rejetés, batterie, action de désactivation.
10. **/incidents**
    - 4 tuiles : nombre sur 90 jours, encore ouverts, coût estimé, répartition par sévérité.
    - Cartes filtrables : sévérité, type, statut, titre, description, coût, date, lien vers l'expédition, signalé par / assigné à, résolu le.

**OPTIMISE**

11. **/recommendations « Advice »**
    - Bouton « régénérer les conseils ». 4 stats : ouvertes, décidées, % suivies, exécutées. Filtre de statut.
    - Chaque carte affiche : priorité, type (commander maintenant, attendre, changer de fournisseur, fractionner, accélérer…), titre, delta de coût, expiration, bloc « Expliquer » (résumé, raisons, hypothèses) et mini-tableau de répartition proposée.
    - Actions : note, « accepter et exécuter », rejeter. Après exécution, bandeau de succès avec lien vers le bon de commande.
    - **C'est l'écran clé de la confiance envers l'IA.**
12. **/forecasting**
    - Produit, horizon (groupe de boutons), bouton « prévoir ».
    - Courbe de prévision avec bande d'intervalle à 80 %, chip du modèle retenu, bloc Expliquer.
    - Comparaison des 6 modèles (WAPE, MAE, RMSE) et panneau de qualité des données.
13. **/allocation**
    - Formulaire « question » : produit, quantité, délai en jours, part max par fournisseur, budget.
    - Plan : statut OPTIMAL / FEASIBLE / INFEASIBLE, « résolu en N ms », tableau par fournisseur (quantité, jauge de part, prix, délai, fiabilité, coût), bandeau de demande non couverte, bloc Expliquer.
    - Résultats 2×2 : objectif, délai attendu, risque de rupture, concentration.
    - Décomposition des coûts en jauges et liste des contraintes appliquées.
14. **/routing** (tournées)
    - Dépôt ; cases à cocher pour les arrêts et les véhicules.
    - 5 tuiles : statut, tournées, distance, durée, coût.
    - Plan par véhicule en séquence d'arrêts (min, km, h, unités, carburant, coût).
    - Panneaux raisonnement et contraintes.
    - **Ajouter une carte des tournées**, absente aujourd'hui.
15. **/scenarios « What-if »**
    - Leviers : produit, horizon, 7 curseurs (demande, délai, retard fournisseur, carburant, coût de transport, stock initial, prix unitaire), « lancer 2 000 itérations », réinitialiser.
    - 3 cartes Meilleur / Base / Pire : coût total, plage P05–P95, % vs base, jauge de risque de rupture, taux de service, stock moyen, commandes passées.
    - Panneau de lecture.

**MASTER DATA**

16. **/inventory**
    - 6 tuiles : valeur, unités, SKU, en rupture, sous le point de commande, en surstock.
    - Tableau stock par produit et entrepôt (libre, réservé, entrant, point de commande, jauge de couverture, valeur), avec recherche et pagination.
    - Liste des alertes ouvertes avec action « réévaluer ».
17. **/purchase-orders « Orders »**
    - Tableau : commande (marqueur « ia » si créée par une recommandation), statut, fournisseur et sa fiabilité, progression de réception, lignes, valeur, dates prévue et réelle.
    - Sélecteur de transition de statut par ligne (DRAFT → PENDING → CONFIRMED → PROCESSING → SHIPPED → IN_TRANSIT → DELIVERED, ou CANCELLED).
18. **/suppliers**
    - Classement : rang, fournisseur, pays, jauge de fiabilité, à l'heure, qualité, taux de service, délai ± écart-type, commandes, chip « mesuré / a priori ».
    - Action « tout recalculer ».

**Autres**

19. **/notifications « Alerts »**
    - Chip de non-lues, filtre « non-lues seulement », « tout marquer lu ».
    - Chaque élément : point non-lu, type coloré par sévérité, temps relatif, titre, corps, échec d'envoi email, lien « ouvrir → ».
20. **/drive, la PWA chauffeur (mobile, hors shell)**
    - **Écran d'appairage** : identifiant et secret, pré-remplissables par URL ; gros bouton « Démarrer le suivi ».
    - **Écran de suivi** :
      - statut Suivi / Arrêté (pulsation) ;
      - vitesse en très grand ;
      - coordonnées et précision ;
      - gros bouton start/stop ;
      - bandeaux hors-ligne et erreur ;
      - 4 stats : positions prises, en attente d'envoi, envoyées, dernier envoi ;
      - alertes écran allumé et batterie ;
      - lien « désappairer ».
    - Contraintes : **usage en plein soleil, une main, gants, réseau instable**. Cibles tactiles ≥ 56 px et contraste maximal.

## Ce que j'attends de toi

**Direction**
- Propose **2 directions visuelles** distinctes avant de décliner. Par exemple : (A) une évolution raffinée du « tableau d'instruments » actuel ; (B) une direction plus audacieuse de ton choix.
- Pour chacune : palette, typographie, densité, traitement des cartes et des graphiques, un écran clé (Control) en maquette.
- Recommande l'une des deux et justifie ton choix.

**Design system (direction retenue)**
- Tokens : couleurs (surfaces, texte, primaire, 4 états + variantes dim), typographie (échelle complète, taille minimale lisible ≥ 11 px pour du texte courant), espacements, rayons, ombres ou élévations, animations.
- Sépare clairement : couleur de **marque / sélection** ≠ couleur **d'avertissement**.
- Palette **catégorielle pour les graphiques** (6+ séries) et palettes séquentielle et divergente, lisibles pour les daltoniens.
- Composants unifiés : Panel, KPI / StatTile (une seule variante paramétrable), Chip / Badge, Meter / Gauge, Table (tri, sticky, sélection, ligne étendue, densité compacte/confortable), Field, Select, Slider, Checkbox, Button (primary, secondary, ghost, danger), Tabs / Segmented, Explain, Timeline, Empty, Loading (skeleton), Error, Toast, Modal / Drawer, Tag démo, indicateur live / simulé, marqueurs de carte, légendes.
- Système d'icônes choisi et règles d'usage (navigation, statuts, types d'entités).
- États pour chaque composant : défaut, survol, focus visible, actif, désactivé, chargement, vide, erreur.

**Écrans**
- Les 20 écrans ci-dessus dans la direction retenue, au format desktop 1440 px.
- En plus, une version tablette ou petit laptop (1024 px) pour Control et Live map, et une version mobile (390 px) pour /drive.

**Patterns transverses**
- Comportement de la sidebar : repliable, avec icônes seules.
- Palette de commandes (⌘K) pour sauter à une expédition, un véhicule, un navire ou un SKU.
- Hiérarchie des alertes : critique vs avertissement vs info.
- Affichage cohérent de « démo » et de « live / simulé / hors ligne ».

**Accessibilité et i18n**
- Contraste WCAG AA minimum, focus visible, états jamais portés par la couleur seule (icône et texte en plus).
- Maquette au moins 2 écrans en français pour valider les longueurs de texte.

**Mode clair (optionnel)**
- Évalue s'il est pertinent, par exemple pour les rôles bureau (achats, planification). Si oui, montre Control en clair.

## Contraintes à respecter

- Conserver **toutes** les données, colonnes, filtres et actions listés.
- Densité d'information élevée : c'est un outil de travail, pas une landing page. Pas de héros décoratifs, pas de cartes creuses, pas de gradients gratuits.
- Chiffres, identifiants, plaques, IMO et numéros de suivi en police mono à chiffres tabulaires.
- Les cartes (maps) sont centrales dans 5 écrans : le fond de carte, les marqueurs et les calques doivent appartenir au même langage visuel que l'UI.
- Réalisable avec Tailwind v4 + tokens CSS + MapLibre + Recharts, sans dépendance lourde.
- Pas de marque tierce imitée : SCIP garde son identité propre.

## Format de sortie

1. Deux directions avec leur justification, puis la recommandation.
2. Le design system (tokens au format `@theme` Tailwind v4 prêt à coller, plus la bibliothèque de composants).
3. Les maquettes des écrans.
4. Une courte liste de changements priorisés (quick wins vs refonte) pour guider l'implémentation.
