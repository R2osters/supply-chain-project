# SCIP — Choix techniques et etapes de construction

Ce document retrace, etape par etape, ce qui a ete construit et pourquoi.
Chaque etape correspond a un ou plusieurs commits du depot (voir `git log`).

## Vue d'ensemble

SCIP (Supply Chain Intelligence Platform) suit la marchandise du quai fournisseur
au quai client (contexte TRACK) et decide quoi commander, aupres de qui, quand et
par quelle route (contexte OPTIMIZE). Les deux contextes sont relies par une boucle
fermee : un retard observe declenche un recalcul de risque de rupture, qui produit
une recommandation de commande, qu'un humain accepte, et qui redevient un objet
suivi par TRACK.

## Etape 1 — Fondations (commit 8b72712)

- **Monorepo** avec API NestJS : schema de donnees, authentification, donnees de
  reference (fournisseurs, SKU, entrepots), achats, inventaire, calcul d'ETA.
- **Multi-tenant** des le depart : isolation par organisation dans chaque requete,
  plutot que rajoutee apres coup.
- Choix de **PostgreSQL** comme unique source de verite ; pas de microservices
  premature, deux contextes bornes dans un seul produit.

## Etape 2 — TRACK : le suivi physique (commit 5ef63e0)

- Expeditions, ingestion GPS, requetes spatiales **PostGIS**, canal **WebSocket**
  temps reel.
- Choix PostGIS plutot qu'un service externe de geolocalisation : les requetes
  "quels camions dans ce rayon" restent dans la base, testables et gratuites.

## Etape 3 — OPTIMIZE : le service IA (commits 145d19f, e4b7124, a7083fb)

- Service **FastAPI Python separe** de l'API NestJS : l'ecosysteme scientifique
  (pandas, scikit-learn, OR-Tools) est en Python, le domaine metier en TypeScript.
- Construit dans l'ordre : qualite des donnees d'abord, puis prevision de demande,
  politique de stock, allocation **MILP**, et enfin prediction de retard, detection
  d'anomalies, **VRP** (tournees), scenarios et moteur de recommandations.
- Chaque recommandation expose ses **raisons et hypotheses** — l'IA propose,
  l'humain decide. Aucune commande n'est passee automatiquement.

## Etape 4 — Fermeture de la boucle (commit a5661e3)

- Evenements de domaine durables entre TRACK et OPTIMIZE : un retard previsible
  recalcule le risque de rupture des SKU embarques et genere un brouillon de
  commande reel, trace et suivi.
- Demo entierement **seedee** : le scenario complet se rejoue en local en
  quelques minutes.

## Etape 5 — Frontend (commit 5ecd2e8)

- **Next.js**, 19 routes, interface sombre type "salle de controle", carte
  temps reel, surfaces IA explicables (le pourquoi de chaque recommandation
  est visible).

## Etape 6 — Industrialisation (commits 6571a5f, 24e501c, 0889c40)

- Dockerfiles, documentation complete, suite **e2e** — qui a revele deux vrais
  defauts (expeditions demarrant deja en retard, filtres de requete renvoyant 400).
  Les tests ont ete traites comme un outil de decouverte, pas une formalite.

## Etape 7 — Maritime et interface en francais (commits 3ce8dba, c53ef2a, 94045ba)

- Suivi de **navires** : positions AIS via WebSocket, **MarineTraffic** comme
  troisieme source de position, liens profonds gratuits vers les fiches navires.
- Interface passee en francais avec **i18n FR/EN a detection automatique**.
- Un document de concept honnete decrit ce que l'IA fait reellement — et ce
  qu'elle ne fait pas.

## Etape 8 — Un vrai camion sur la carte (commits c80cc7e, b6104bf)

- Trois portes d'entree pour la position d'un camion : la **PWA chauffeur**
  (hors-ligne d'abord, synchronisation IndexedDB), les traceurs GPS
  **GT06/Concox** (TCP brut decode par l'API), et la telematique tierce.
- Documentation de ce que le suivi ne fait deliberement pas, pour eviter la
  sur-promesse.

## Etape 9 — Internationalisation des pages (non committe avant ce depot)

- Extension de l'i18n aux pages expeditions, incidents, commandes d'achat,
  inventaire, fournisseurs, livraisons et notifications.

## Etat d'avancement

- API, service IA, frontend, tracking (maritime + routier), i18n : fonctionnels.
- 170 tests passants, couverture e2e du suivi camion par les trois portes d'entree.
- Reste a faire : deploiement production, donnees reelles (les flux actuels sont
  simules ou en demo), durcissement securite avant mise en ligne.
