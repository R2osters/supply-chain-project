# Captures de SCIP 0.2.1

Prises le 2 octobre 2026 sur une installation de test de `SCIP-Setup-0.2.1.exe` en mode
Démonstration (compte « Admin société », interface en français, thème clair). Rien n'est retouché.

- Logiciel : 1440×900 à l'échelle 2 (fichiers de 2880×1800), la taille de la fenêtre par défaut.
- Installeur : 960×640 à l'échelle 2 (1920×1280), la taille réelle de sa fenêtre. Ces écrans viennent
  de l'aperçu navigateur de `apps/installer/ui/` : le bandeau « aperçu » est masqué et les numéros de
  version de l'aperçu sont remplacés par ceux de la release (0.2.1, mise à jour depuis 0.2.0). Le
  dossier affiché (`C:\Users\ama.mensah\…`) est celui d'un utilisateur fictif.
- Toutes les données sont celles du jeu de démo ; l'application les marque elle-même « DÉMO ».

## Le scénario de démonstration

Captures prises après Réglages → « Préparer la démo » (`docs/DEMO-scenario.md`).

| Fichier | Écran | Ce qu'on y voit |
|---|---|---|
| `control.png` | Track · Control | « 2 décisions en attente », six indicateurs, « Boucle de décision » en quatre étapes |
| `carte-live.png` | Track · Carte live | « 2 véhicule(s) en écart · 2 en retard », onze camions, panneau « Flotte », légende |
| `carte-live-camion-en-retard.png` | Track · Carte live | filtre « En retard », camion GT-1274-26 sélectionné : « Expédition à bord » SHP-DEMO-0054, « EN RETARD », destination Kumasi, météo au véhicule |
| `expeditions.png` | Track · Expéditions | « 2 expéditions en retard » |
| `expedition-shp-demo-0054.png` | Fiche d'expédition | SHP-DEMO-0054 : carte du trajet et chronologie |
| `stocks-sku-006.png` | Réseau · Stocks | SKU-006 : 610 unités à WH-ACC sous le point de commande (1 466), « Projection 10 j » |
| `stocks.png` | Réseau · Stocks | « Sous le point de commande : 1 · en rupture : 0 » |
| `conseils.png` | Optimise · Conseils | « 2 conseils ouverts » : changer de fournisseur (Abidjan Import Partners, 72 % de ponctualité), réduire le stock du SKU-008 |
| `conseils-pourquoi.png` | Optimise · Conseils | « Pourquoi cette recommandation ? » déplié : raisons, « 1 hypothèse », « accepter et exécuter », « écarter » |
| `commandes.png` | Réseau · Commandes | « 1 commande en retard sur 3 ouvertes » |

SCIP 0.2.1 ne produit pas de recommandation de commande pour le SKU-006 dans ce scénario (voir
« Écarts constatés ») : aucune capture ne montre « Commander … chez le fournisseur C ».

## Optimise, avec un résultat

| Fichier | Écran | Ce qu'on y voit |
|---|---|---|
| `previsions.png` | Prévisions | SKU-006 à 30 jours : « 9 102 unités attendues », six modèles comparés (WAPE, MAE, RMSE), « gradient boosting » retenu |
| `allocation.png` | Allocation | 20 000 unités du SKU-006 sous 7 jours, part maximale 0,5 : « 2 fournisseur(s), coût total GHS 354 020 » |
| `scenarios.png` | Scénarios | Monte-Carlo sur le SKU-006 : « Risque de rupture de 42 % dans le pire cas » |
| `tournees.png` | Tournées | dépôt WH-ACC, tous les arrêts : « 1 tournée(s), 5 arrêts, 3 non desservi(s) » |

## Les autres écrans

| Fichier | Écran | État |
|---|---|---|
| `connexion.png` | Connexion | comptes de démonstration listés |
| `situation.png` | Track · Situation | « 9 sites exposés à des dangers actifs » (dangers réels du jour) |
| `incidents.png` | Track · Incidents | « 2 incidents ouverts, 2 sans responsable » |
| `livraisons.png` | Track · Livraisons | « Rien de prévu » |
| `navires.png` | Track · Navires | « Les 8 navires sont dans les temps » |
| `balises.png` | Track · Balises | « Aucune balise active pour le moment » |
| `fournisseurs.png` | Réseau · Fournisseurs | « Tous les fournisseurs mesurés tiennent le seuil de fiabilité » |
| `referentiel.png` | Réseau · Référentiel | « Produits, sites, flotte et partenaires » |
| `alertes.png` | Alertes | « 2 alertes non lues » |
| `utilisateurs.png` | Utilisateurs | liste des comptes |
| `reglages.png` | Réglages | « Sources de données » (les panneaux Sauvegarde et Mises à jour n'existent que dans la fenêtre de l'application) |

## L'installeur

`installeur-01-bienvenue.png`, `-03-systeme`, `-04-type`, `-05-base-de-donnees`, `-06-organisation`,
`-08-administrateur`, `-09-recapitulatif`, `-10-installation`, `-11-termine`, puis
`installeur-mise-a-jour.png` et `installeur-desinstallation.png`.

## Écarts constatés dans le logiciel

Relevés pendant les captures ; à corriger dans le logiciel, pas à masquer sur le site.

1. Le scénario de démo ne donne pas de recommandation de commande pour le SKU-006 : « Préparer la
   démo » ne met le produit en pénurie qu'à WH-ACC, alors que le moteur additionne le stock des
   trois entrepôts (`apps/api/src/modules/ai/ai.service.ts`, `demo-rehearsal.service.ts`).
2. Allocation : « Part max par fournisseur » attend une fraction (0,5) ; saisir 50 renvoie
   « maxSupplierSharePercent doit valoir au plus 1 ».
3. Carte live : le type de véhicule s'affiche en anglais (« truck small »).
4. Allocation : les nombres des explications gardent le format anglais (« 20,000 unités »).
5. Installeur, écran Type : le jeu de démo est nommé « Accra Foods Distribution », alors que
   l'entreprise créée s'appelle « Demo Distribution Ghana ».
6. Conseils : le sous-titre d'une recommandation répète son titre.

## Refaire les captures

Installation de test (`SCIP_SETUP_TEST=1`, `SCIP_SETUP_TEST_ROOT=<dossier absolu>`,
`--silent --plan <plan démo>`), SCIP lancé avec `SCIP_DATA_DIR=<dossier>\data`, puis un navigateur
piloté sur `http://127.0.0.1:3001`. Les jetons de session tournent à chaque usage : chaque script se
connecte lui-même. Les retards de la démo durent une dizaine de minutes après « Préparer la démo ».
