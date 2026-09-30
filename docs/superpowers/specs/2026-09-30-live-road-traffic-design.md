# Trafic routier en direct sur la Carte live — conception

Date : 30 septembre 2026 · Statut : validée par l'utilisateur (approche A « comme God Eye »)

## 1. Objectif

Sur la Carte live, voir la circulation partout dans le monde, comme dans God's Eye View, et
distinguer d'un coup d'œil **la flotte de l'utilisateur** (balises GPS, positions réelles) du
**reste de la circulation**.

Contrainte d'honnêteté, reprise de God's Eye View (README : « Traffic is simulated along real
roads… individual vehicle positions are not live observations ») : aucune source publique ne
donne la position de chaque voiture. Les véhicules du trafic général sont donc **simulés sur les
vraies routes** ; ce qui est réel, ce sont **les vitesses mesurées** là où une source existe, et
**la flotte**. L'interface le dit.

Démonstration en classe : flotte de démo au Ghana (trafic simulé, vitesses estimées), puis zoom
sur Rennes (bouchons réels, sans clé). Installation réelle : trafic visible partout ; vitesses
réelles dans le monde entier avec la clé TomTom de l'utilisateur.

Hors périmètre : incidents TomTom (accidents, travaux), trafic sur la page Situation (elle garde
son calque TomTom image actuel), transports en commun GTFS-RT, application chauffeur.

## 2. Ce que l'utilisateur voit (Carte live)

| Élément | Zoom | Rendu |
|---|---|---|
| **Trafic simulé** | ≥ 12 | Petits points qui roulent sur les routes, dans le sens de circulation. Gris pâle (couleur `muted` de la charte) sur une route sans mesure ; vert / orange / rouge sur une route mesurée. |
| **Bouchons mesurés** | ≥ 10 | Trait fin semi-transparent vert / orange / rouge sous les points, **uniquement** sur les tronçons mesurés. Route fermée : trait rouge pointillé, aucun point. |
| **Flotte** | tous | Inchangée : marqueurs HTML au-dessus de la carte, donc toujours au-dessus du trafic. |
| **Avions, navires** | tous | Inchangés, au-dessus du trafic (le calque trafic est inséré sous eux). |

- Interrupteur **Trafic** existant : il pilote désormais simulation + bouchons ; activé par
  défaut, choix mémorisé dans le navigateur (`localStorage`, avec try/catch).
- Ligne d'état sous l'interrupteur : « Trafic simulé sur routes réelles · vitesses mesurées :
  Rennes, TomTom » ; « vitesses estimées » s'il n'y a aucune mesure dans la vue ; « trafic
  indisponible hors connexion » si les routes ne chargent pas ; avec TomTom, « N tuiles
  aujourd'hui / budget » (ou « illimité »).
- Légende : « Ma flotte — balises GPS (réel) », « Trafic — simulé », « Bouchons — mesurés ».
- En dessous du zoom 12 : pas de points (lisibilité et performance, comme God Eye au-delà
  d'environ 8 km d'altitude).

## 3. Sources

| Source | Zone | Clé | Données | Rafraîchissement | Licence |
|---|---|---|---|---|---|
| OpenFreeMap (`https://tiles.openfreemap.org/planet`) | monde | non | tracés des routes (couche `transportation` : `class`, `oneway`, `ramp`, `brunnel`) | tuiles vectorielles, cache MapLibre | © OpenMapTiles, données © OpenStreetMap (ODbL) |
| Rennes Métropole — « Etat du trafic en temps réel » | Rennes | non | 2 859 tronçons : `averagevehiclespeed`, `vitesse_maxi`, `trafficstatus`, tracé | 3 min | ODbL |
| Métromobilité Grenoble — `/api/dyn/trr/json` + `/api/lines/json?types=trr` | Grenoble | non | 253 tronçons publics (`visible_internet = 1`) : `nsv_id` + tracé | niveaux 60 s, tracés 24 h | à confirmer à l'implémentation ; si la licence ne permet pas la réutilisation, Grenoble est retiré |
| TomTom — tuiles vectorielles de flux `traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf` | monde | **oui** (clé de l'utilisateur, Réglages) | couche `Traffic flow` : `traffic_level` (vitesse / vitesse libre, 0–1), `road_type`, `road_closure`, `traffic_road_coverage` | 120 s | conditions TomTom de la clé ; « Traffic © TomTom » |

Niveau commun `level` (vitesse actuelle / vitesse libre, 0–1) :

- TomTom : `traffic_level` tel quel ; `road_closure = true` → fermée.
- Rennes : `min(1, averagevehiclespeed / vitesse_maxi)` si les deux valeurs sont valides ;
  sinon depuis `trafficstatus` : `freeFlow` 0,9 · `heavy` 0,6 · `congested` 0,3 ; `unknown` →
  pas de mesure.
- Grenoble : `nsv_id` 1 → 0,9 · 2 → 0,6 · 3 → 0,3 · 4 → fermée · 0 ou autre → pas de mesure. La
  signification des codes est vérifiée dans la documentation Métromobilité avant de coder ; la
  table est corrigée si elle diffère.

Seuils de couleur (repris de God Eye, `trafficFlowStyle.js`, MIT) : `level ≥ 0,85` vert,
`≥ 0,55` orange, sinon rouge.

## 4. Architecture

### API (`apps/api/src/modules/traffic/`)

- `GET /traffic/flow-tiles/:z/:x/:y.pbf` — proxy des tuiles vectorielles TomTom. Même cache,
  même budget journalier et mêmes règles que le proxy image existant (404 sans clé, 429 budget
  atteint sans tuile en cache, 502 panne ; clé jamais renvoyée ni journalisée). Réponse refusée si
  ce n'est pas un protobuf (`application/vnd.mapbox-vector-tile` / `application/x-protobuf`).
- `GET /traffic/open-flow?bbox=minLon,minLat,maxLon,maxLat` — GeoJSON `FeatureCollection` de
  `LineString` avec `{ level, closed, speedKmh, limitKmh, source: 'rennes' | 'grenoble' }`,
  limité à la boîte (au plus 5 000 entités). Boîte invalide → 400.
- Fournisseurs, chacun dans son fichier, sans table en base :
  - `rennes-flow.provider.ts` : export GeoJSON complet toutes les 3 min (à la demande, pas de
    minuterie quand personne ne regarde), vol unique (single-flight), conservation de la dernière
    version valide jusqu'à 10 min en cas de panne.
  - `grenoble-flow.provider.ts` : tracés 24 h + niveaux 60 s, jointure par identifiant.
- `GET /traffic/status` enrichi : `{ enabled, provider, tilesUsedToday, dailyBudget,
  attribution, note, sources: [{ id, active, updatedAt, attribution }] }`. Les champs existants
  gardent leur sens (la page Situation les lit).
- Budget TomTom réglable : nouveau réglage `tomtomDailyTileBudget` dans Réglages → Sources de
  données (fichier `settings.json`, même priorité réglages > variables d'environnement > défaut
  6 000). `0` = illimité. L'écran avertit : « au-delà du quota gratuit de TomTom, TomTom facture
  ou refuse les tuiles ».
- Permission : `gps:read`, comme la carte. Limitation de débit des tuiles vectorielles : celle du
  proxy image (1 200 / min).

### Web (`apps/web`)

Tout le calcul est côté navigateur, découpé en unités testables sans carte :

| Fichier | Rôle |
|---|---|
| `lib/traffic/flow-level.ts` | `level` → seau (vert / orange / rouge), multiplicateurs de vitesse (`max(0,15, level)`) et de densité (`min(2,5, 1 / max(level, 0,4))`) — adaptés de God Eye (MIT, en-tête de source). |
| `lib/traffic/roads.ts` | Entités `transportation` → routes roulables : classes `motorway, trunk, primary, secondary, tertiary, minor`, `service` seulement au zoom ≥ 15 ; exclut `path, track, rail, ferry, raceway, busway` et les classes inconnues. Vitesse libre par classe : 110, 90, 70, 60, 50, 40, 20 km/h. Poids de densité : 1, 0,8, 0,6, 0,45, 0,3, 0,12, 0,05. |
| `lib/traffic/flow-match.ts` | Associe chaque route OSM aux mesures : échantillon tous les 20 m, mesure la plus proche à moins de 25 m dont le cap diffère de moins de 35° (les deux sens si la mesure couvre les deux) ; niveau majoritaire, sinon « non mesurée ». Index spatial par grille. |
| `lib/traffic/simulation.ts` | Nombre de points par route = longueur × poids × facteur de zoom × densité du bouchon, plafond global de 6 000 points (routes majeures servies d'abord). Avance chaque point le long de sa polyligne à la vitesse réelle (vitesse libre × vitesse du bouchon, ±15 % par point), dans les deux sens sauf sens unique. Route fermée : aucun point. Conserve les points des routes encore visibles quand la vue change. |
| `app/(app)/map/_components/road-traffic-layer.ts` | Calque WebGL personnalisé MapLibre (`CustomLayerInterface`) : un tampon de positions Mercator + couleurs, `gl.POINTS`, taille selon le zoom ; inséré sous le premier calque avions/navires. Ne se redessine que s'il est visible et que l'onglet est actif. |
| `app/(app)/map/_components/use-road-traffic.ts` | Branche le tout sur la carte : source vectorielle OpenFreeMap + calque de lignes invisible pour charger les tuiles (`minzoom 12`), `querySourceFeatures` après chaque déplacement (500 ms de délai), source GeoJSON « mesures ouvertes » (`/traffic/open-flow`, toutes les 60 s), source vectorielle TomTom (`/traffic/flow-tiles`, `maxzoom 12` puis sur-zoom pour économiser le budget) si la clé est active, calques de lignes « bouchons ». |

La Carte live remplace son calque TomTom image par ces calques. La page Situation n'est pas
modifiée.

## 5. Erreurs et cas limites

- Hors connexion ou OpenFreeMap injoignable : aucun point, message dans la ligne d'état ; le
  reste de la carte fonctionne.
- Source de mesures en panne : dernière valeur jusqu'à 10 min, puis la source est marquée
  inactive (`sources[].active = false`) et ses routes redeviennent « estimées ».
- Budget TomTom atteint : tuiles en cache seulement ; sans cache, les routes redeviennent
  « estimées » et la ligne d'état le dit.
- Donnée de niveau non numérique : traitée comme « non mesurée », jamais comme un bouchon.
- Performance : plafond de 6 000 points ; animation arrêtée quand l'interrupteur est coupé,
  sous le zoom 12 ou quand l'onglet est caché.

## 6. Tests

- API (jest) : fournisseurs Rennes et Grenoble à partir de données figées (calcul du `level`,
  statuts, panne → valeur conservée puis inactif, filtrage par boîte, boîte invalide) ; proxy
  vectoriel (404 sans clé, budget, 0 = illimité, refus d'un corps non protobuf, clé absente des
  réponses et des journaux) ; réglage du budget.
- Web (vitest) : `flow-level`, `roads` (classes, exclusions), `flow-match` (distance, cap, deux
  sens), `simulation` (densité, avance le long d'une polyligne, sens unique, route fermée,
  plafond, conservation des points).
- Bout en bout sur l'exécutable installé (mode test) : `/traffic/open-flow` renvoie des tronçons
  de Rennes ; `/traffic/status` liste les sources ; vérification visuelle de la carte au Ghana
  (points gris) et à Rennes (couleurs mesurées). Avec la clé de l'utilisateur, si elle est
  présente dans les réglages : une tuile vectorielle TomTom.

## 7. Documentation et attributions

- `docs/intel/traffic.md` réécrit (sources, niveaux, budget, honnêteté de la simulation).
- Panneau Sources : OpenFreeMap / OpenMapTiles / OpenStreetMap, Rennes Métropole (ODbL),
  Métromobilité, TomTom.
- `docs/INTEL.md` et `docs/ROADMAP-presentation.md` mis à jour.

## 8. Clé TomTom

L'utilisateur colle lui-même sa clé (compte myTomTom existant) dans Réglages → Sources de
données, ou dans `apps/desktop/keys.local.json` pour son installeur personnel (fichier non
versionné ; une clé embarquée est lisible par quiconque a l'installeur). L'assistant ne manipule
pas la clé.
