# SCIP — le concept, et la vérité sur l'IA

> Version française. English version: [CONCEPT.md](CONCEPT.md).

Ce document répond à trois questions, dans l'ordre :

1. **Quelle est l'idée ?**
2. **Où l'IA intervient-elle exactement ?**
3. **Comment cette IA a-t-elle été entraînée ?** — et la réponse honnête est plus nuancée que
   « je l'ai entraînée ». Une section entière y est consacrée, parce que c'est là que la plupart
   des présentations de produits mentent.

---

## 1. L'idée

La plupart des outils Supply Chain répondent à la question **« où est ma marchandise ? »**.
Quelques-uns répondent à **« que devrais-je commander ? »**. Presque aucun ne relie les deux — et
c'est précisément dans ce lien que se trouve la valeur.

Un exemple concret, celui que le système exécute réellement :

```
14h02  Le camion du fournisseur A perd 2 jours sur son trajet.
       → SCIP le détecte : l'ETA recalculée dépasse la promesse, même dans le
         scénario optimiste. L'expédition passe en DELAYED.

14h02  Un événement durable est écrit en base : shipment.delayed

14h02  Le worker le consomme. Il sait quels produits sont à bord.
       → Recalcul du risque de rupture pour ces références : 68 %.

14h03  Le moteur de recommandation produit :
         « Commander 3 000 unités chez le fournisseur C »
       avec le raisonnement, le coût, et les hypothèses.

14h10  Un humain accepte.
       → Un vrai bon de commande brouillon existe. Il est traçable.
         SCIP suit désormais cette nouvelle commande.
```

Ce n'est pas un schéma de présentation. C'est le chemin de code, et il est vérifiable en trois
minutes depuis l'interface (section « Verify it yourself » du README).

### Deux contextes, un produit

| Contexte | Question | Ce qu'il fait |
|---|---|---|
| **SUIVI** | Où est-ce, et sera-ce en retard ? | fournisseurs, commandes, expéditions, GPS, **navires/AIS**, entrepôts, stocks, livraisons, incidents |
| **OPTIMISATION** | Quoi commander, chez qui, quand, par quelle route ? | prévision, politique de stock, scoring fournisseur, allocation, tournées, scénarios, risque, recommandations |

Les deux cahiers des charges d'origine partageaient environ 70 % du modèle de données. Les
construire séparément aurait imposé de le dupliquer et d'écrire une couche de synchronisation
entre deux bases — pour aucun bénéfice, en détruisant précisément la boucle qui fait la valeur.

### Terrestre et maritime

Un conteneur ne voyage pas en camion d'un bout à l'autre. Il fait une route, puis une traversée,
puis une autre route. Le système modélise les deux, différemment, parce qu'ils sont différents :

- **Un camion vous appartient.** Vous y boulonnez un traceur, il émet vers votre API.
- **Un navire ne vous appartient pas.** Vous avez réservé 40 EVP dessus. Vous ne pouvez rien y
  installer. En revanche il émet en permanence sa position par **AIS**, la radio anticollision que
  tout navire de commerce de plus de 300 tonneaux est légalement tenu de diffuser.

D'où deux mécanismes de suivi distincts, et une recherche de navire par **nom, IMO, MMSI ou
indicatif** — parce qu'un chargeur qui tient un connaissement a *un* identifiant et ne sait pas
lequel c'est.

#### Trois sources de position, et pourquoi ce n'est pas « MarineTraffic ou rien »

| Source | Coût | Couverture | Ce qu'on en retire |
|---|---|---|---|
| **MarineTraffic** | payant, au crédit | terrestre **+ satellite** | des données JSON, en base |
| **AISStream** | gratuit | terrestre, ~40–60 NM des côtes | des données brutes, en base |
| **Simulateur** | — | orthodromies, marquées `SIMULATOR` | démonstration |
| *Iframe / lien MarineTraffic* | gratuit | — | **une image, pas des données** |

La distinction qui compte : un iframe vous **montre** le navire, il ne met pas sa position **dans
votre base**. Or l'ETA, la détection d'anomalies et le rattachement à une expédition ont tous
besoin de la position comme donnée. C'est pourquoi l'iframe est une couche de *vérification*, pas
une source.

L'apport réel de MarineTraffic en tant que source est l'**AIS satellitaire** : un récepteur
terrestre porte à 40–60 milles nautiques, et au milieu de l'Atlantique un navire disparaît
purement et simplement. Sur une traversée transocéanique, cet écart est la différence entre une
trace continue et deux morceaux déconnectés — précisément au moment où le chargeur veut savoir que
le navire avance encore.

Les **liens profonds** vers MarineTraffic et VesselFinder sont eux gratuits, sans clé, et présents
sur chaque navire. Ils restent utiles même avec un flux payant : un second avis, une photo de la
coque, l'historique des escales que ce système ne conserve pas.

---

## 2. Où l'IA intervient — précisément

Voici la carte complète. Chaque ligne indique **honnêtement** de quoi il s'agit.

| Fonction | Nature réelle | Entraîné ? |
|---|---|---|
| **Prévision de la demande** | ML supervisé + statistiques classiques | **Oui** — à chaque requête, sur vos données |
| **Probabilité de retard** | scorecard logistique *ou* gradient boosting | **Conditionnel** — voir §3 |
| **Détection d'anomalies** | règles expertes codifiées | **Non** — jamais entraîné |
| **Moteur ETA** | physique + propagation d'incertitude | **Non** — formule |
| **Stock de sécurité / point de commande** | statistiques (Silver-Pyke-Peterson) | **Non** — formule fermée |
| **Scoring fournisseur** | normalisation min-max pondérée | **Non** — pondérations choisies |
| **Allocation multi-fournisseurs** | **MILP** — programmation linéaire en nombres entiers | **Non** — solveur exact |
| **Optimisation de tournées** | **CVRPTW** — recherche locale guidée | **Non** — solveur heuristique |
| **Simulation de scénarios** | **Monte Carlo** | **Non** — échantillonnage |
| **Moteur de risque** | scoring probabilité × impact | **Non** — pondérations choisies |
| **Moteur de recommandation** | orchestration des sorties ci-dessus | **Non** — logique métier |

### Ce que cela veut dire

Sur onze fonctions dites « IA », **une seule** est de l'apprentissage machine au sens strict et
systématique (la prévision), **une** l'est conditionnellement (le retard), et **neuf** sont de la
recherche opérationnelle, des statistiques ou des règles expertes.

C'est délibéré, et je le défends.

**Pourquoi ne pas tout apprendre ?** Parce que l'apprentissage exige des données étiquetées qu'un
déploiement neuf n'a pas. Un détecteur d'anomalies appris nécessiterait plusieurs centaines
d'incidents annotés à la main : il démarrerait inutile et le resterait des mois. Les règles
codifiées, elles, fonctionnent le premier jour et annoncent le seuil qu'elles ont franchi — donc
un exploitant peut les contester. C'est un meilleur produit, pas un compromis.

**Pourquoi un solveur et pas un modèle pour l'allocation ?** Parce qu'une quantité minimale de
commande est une *disjonction* : « commander au moins 5 000 unités, **ou** rien du tout ». Aucun
score pondéré n'exprime cela. Il faut une variable binaire et une contrainte big-M — c'est
exactement ce à quoi sert un solveur MILP. Un réseau de neurones qui approximerait cette contrainte
la violerait parfois, et une contrainte contractuelle violée « parfois » n'est pas une contrainte.

**Où l'apprentissage est-il réellement le bon outil ?** Quand il existe un historique abondant, un
signal non trivial, et une vérité terrain qui arrive naturellement. La demande cochent les trois
cases : deux ans de ventes quotidiennes, une saisonnalité réelle, et la réalité de demain vous dit
si vous aviez raison. C'est là — et là seulement — que la prévision apprend.

---

## 3. Comment l'IA a-t-elle été entraînée ?

**Réponse courte : aucun modèle pré-entraîné n'est livré avec ce produit.** Je n'ai pas entraîné
de modèle sur un corpus externe puis expédié des poids. Il n'y a aucun fichier de poids dans ce
dépôt.

Ce qui existe se répartit en trois catégories, très différentes.

### 3.1 — Modèles ajustés à la requête, sur *vos* données

C'est le seul véritable apprentissage supervisé du système, et il concerne la **prévision de la
demande**.

**Données d'entraînement.** L'historique de demande quotidienne du produit concerné, lu depuis la
table `demand_history` — c'est-à-dire *vos* ventes, pas les miennes. Aucune donnée externe
n'intervient.

**Cible.** La quantité demandée le jour suivant.

**Ce qui est ajusté.**

| Modèle | Ce qui est appris | Comment |
|---|---|---|
| `NAIVE` | rien | référence : demain = aujourd'hui |
| `SEASONAL_NAIVE` | rien | demain = même jour la semaine dernière |
| `MOVING_AVERAGE` | la fenêtre *w* | choisie par erreur à un pas sur l'entraînement seul |
| `EXPONENTIAL_SMOOTHING` | le niveau | récursion α, α = 2/(w+1) avec w = 7 |
| `HOLT_WINTERS` | niveau, tendance, saisonnalité | maximum de vraisemblance (statsmodels) |
| `GRADIENT_BOOSTING` | ~200 arbres de décision | `HistGradientBoostingRegressor` sur retards 1,2,3,7,14,28 j + moyennes glissantes + features calendaires |

**Protocole de validation.** Validation glissante à fenêtre expansive (*walk-forward*) : ajuster
sur tout jusqu'à *t*, prédire les *h* jours suivants, avancer, recommencer. Jamais de découpage
aléatoire — cela ferait fuiter le futur dans le passé et flatterait tous les modèles,
catastrophiquement ceux à variables retardées.

**Critère de sélection.** Le **WAPE**, pas le MAPE. Le MAPE divise par le réel : un seul jour à
demande nulle le rend infini, et les jours à demande nulle sont la norme sur toute référence à
rotation lente. En cas d'égalité, le modèle le plus simple gagne.

**Résultat mesuré** sur les données de démonstration (série synthétique avec tendance + rythme
hebdomadaire + saison annuelle) :

```
HOLT_WINTERS          WAPE 24,13    ← sélectionné
GRADIENT_BOOSTING     WAPE 24,72
SEASONAL_NAIVE        WAPE 25,74
MOVING_AVERAGE        WAPE 27,07
EXPONENTIAL_SMOOTHING WAPE 28,11
NAIVE                 WAPE 29,38
```

Notez que le gradient boosting **perd** contre Holt-Winters. C'est le résultat normal sur une
série courte et bruitée, et c'est précisément pourquoi la comparaison existe : elle empêche de
livrer un modèle complexe qui fait moins bien que la moyenne mobile.

**Persistance.** Les modèles ne sont pas persistés entre deux appels. Ils sont réajustés à chaque
requête (3,6 à 5,5 s pour six modèles sur deux ans d'historique). C'est un choix : les données
changent tous les jours, un modèle mis en cache serait périmé, et le coût est acceptable à cette
échelle. Les tables `model_versions` et `model_metrics` existent pour la persistance le jour où le
volume l'exigera.

### 3.2 — Un modèle qui s'entraîne *si* vous lui donnez de quoi apprendre

La **prédiction de retard** a deux modes, et la réponse indique toujours lequel a produit le
chiffre.

**Mode scorecard (démarrage à froid) — NON entraîné.** Un déploiement neuf n'a aucune expédition
étiquetée. Plutôt que de livrer un modèle entraîné sur rien, le moteur évalue un scorecard
logistique dont **les coefficients sont publiés dans chaque réponse** :

```
logit(p) = β₀ + Σ βᵢ·xᵢ        β₀ = logit(0,18) = taux de retard de base du fret routier
```

| Facteur | β | Origine |
|---|---|---|
| non-fiabilité du transporteur | 2,60 | connaissance métier |
| déficit de vitesse observé | 1,80 | connaissance métier |
| congestion | 1,10 | connaissance métier |
| sévérité météo | 0,95 | connaissance métier |
| historique d'incidents du corridor | 0,80 | connaissance métier |
| non-fiabilité fournisseur | 0,70 | connaissance métier |
| distance (par 1 000 km) | 0,55 | connaissance métier |
| arrêts intermédiaires | 0,40 | connaissance métier |
| départ nocturne | 0,35 | connaissance métier |
| départ le week-end | 0,25 | connaissance métier |

**Ces coefficients ne sont pas appris. Je les ai choisis.** Ils encodent du raisonnement de fret
ordinaire — un transporteur en retard une fois sur trois est le signal le plus fort disponible — et
l'intercept est calibré pour qu'une expédition parfaitement banale prédise le taux de base
observé du secteur. C'est un **prior déclaré**, pas un ajustement. La réponse le dit explicitement
dans son bloc `assumptions`.

**Mode appris.** Dès que l'appelant fournit **≥ 30 expéditions étiquetées avec au moins 5 de
chaque classe**, un `HistGradientBoostingClassifier` est ajusté sur ces données et remplace le
scorecard. L'attribution se fait par ablation : remettre chaque variable à sa valeur bénigne et
mesurer le déplacement de la prédiction.

Sous ces seuils, l'entraînement est **refusé** et la raison est renvoyée. Un classifieur ajusté sur
trois expéditions en retard prédit des absurdités avec assurance, ce qui est pire que ne rien
prédire.

### 3.3 — Ce qui n'est pas entraîné du tout, et pourquoi

| Composant | Ce qui est fixé à la main | Pourquoi pas d'apprentissage |
|---|---|---|
| **Règles d'anomalie** | arrêt > 45 min, déviation > 2 km, survitesse sur ≥ 3 points, perte GPS > 30 min | aucune anomalie étiquetée n'existe au jour 1 ; les règles fonctionnent immédiatement et annoncent leur seuil |
| **Multiplicateurs ETA** | embouteillage total = −50 % de vitesse, météo la pire = −35 %, nuit = +5 % | priors déclarés, publiés dans chaque réponse ; remplaçables par un vrai fournisseur météo/trafic |
| **Pondérations scoring fournisseur** | prix 30, fiabilité 25, délai 20, qualité 15, capacité 5, distance 5 | ce sont des **préférences commerciales**, pas des faits à découvrir ; elles sont configurables par requête |
| **Pondérations de risque** | rupture 30, fournisseur 25, transport 20, demande 15, géopolitique 5, météo 5 | idem : c'est l'appétit au risque de l'entreprise |
| **Stock de sécurité** | formule z(SL)·σ_LTD | statistique classique et défendable en revue ; une heuristique maison serait indéfendable |

Un point qui mérite d'être dit clairement : **appeler « IA » l'ensemble de ce système serait
exagéré**. L'étiquette honnête est *recherche opérationnelle + statistiques + apprentissage
supervisé là où il est justifié*. J'ai conservé le mot « AI » dans les noms de service parce que
c'est le vocabulaire du cahier des charges, mais la documentation technique
([AI.md](AI.md)) décrit chaque formule et chaque hypothèse pour que personne ne se méprenne.

### 3.4 — Le scoring fournisseur : validé contre une vérité terrain

Un cas particulier mérite attention, parce qu'il montre comment on *prouve* qu'un calcul
fonctionne.

Le score de fiabilité fournisseur n'est pas saisi : il est **dérivé de l'historique de commandes**.
Le générateur de données de démonstration crée chaque fournisseur à partir d'un profil connu
(fournisseur C : 97 % de ponctualité, délai 3 j ± 0,6), puis génère 301 bons de commande dont les
dates de livraison sont tirées de *sa propre distribution*.

La plateforme relit ensuite cet historique et recalcule le score — par le même chemin de code que
l'API en production. Le résultat :

```
SUP-C  Tema Port Distributors    mesuré 96,9 %   (généré depuis 97 %)
SUP-A  Volta Grain Cooperative   mesuré 94,8 %   (généré depuis 92 %)
SUP-D  Ashanti Wholesale Group   mesuré 89,3 %   (généré depuis 86 %)
SUP-B  Sahel Commodities Ltd     mesuré 79,2 %   (généré depuis 75 %)
SUP-E  Abidjan Import Partners   mesuré 74,2 %   (généré depuis 70 %)
```

Le calcul retrouve la vérité qu'il ne connaissait pas. C'est le genre de vérification qui distingue
un chiffre calculé d'un chiffre inventé — et elle a été obtenue *après* correction d'un bug réel :
la première version fixait la date promise à la *moyenne* de la distribution du fournisseur, ce qui
le rendait en retard une fois sur deux par construction, et tous les fournisseurs mesuraient ~50 %.

### 3.5 — Sur les données de démonstration

Toutes les données livrées sont **synthétiques et étiquetées comme telles** : `isDemoData` sur
chaque ligne, `isSimulated` sur chaque point GPS, `source: SIMULATOR` sur chaque position de
navire. L'interface les badge et les analyses indiquent quelle part d'un chiffre est synthétique.

Elles sont générées par un PRNG à graine fixe (mulberry32, graine 20260813), donc reproductibles :
une démonstration dont les chiffres bougent sans changement de code rend impossible de distinguer
une régression d'un coup de dé.

Elles sont aussi **statistiquement cohérentes**, pas aléatoires : tendance, rythme hebdomadaire,
saison annuelle, promotions occasionnelles. C'est essentiel — un jeu de données aléatoire produit
un système qui *paraît* peuplé et se comporte n'importe comment : la prévision choisit le modèle
naïf faute de signal, le stock de sécurité explose parce que la variance ne veut rien dire, et les
scores fournisseurs sont du bruit.

**Les navires sont fictifs, les ports sont réels.** Les ports portent leurs vrais UN/LOCODE et
leurs vraies coordonnées, parce qu'un Rotterdam mal placé casserait tous les calculs de distance.
Les navires ont des noms et des numéros IMO **inventés** (avec une clé de contrôle valide, mais ne
correspondant à aucune coque existante) : placer un vrai IMO sur un navire synthétique signifierait
que le jour où quelqu'un active une clé AIS, les émissions d'un vrai bateau viendraient se fondre
dans une traversée imaginaire.

---

## 4. Comment entraîner correctement avec de vraies données

Si vous branchez ce système sur une exploitation réelle, voici ce qui s'améliore et comment.

**Prévision** — fonctionne immédiatement. Il lui faut 14 jours d'historique minimum, 3 mois pour
que le seasonal naive ait du sens, et 4 mois (120 points) avant que le gradient boosting soit même
proposé. Aucune action de votre part : il s'ajuste sur ce que la table `demand_history` contient.

**Prédiction de retard** — passe en mode appris dès que vous disposez de 30 expéditions livrées.
En pratique : laissez tourner le suivi deux à trois mois, puis passez l'historique étiqueté dans
`trainingHistory`. Le passage du scorecard au modèle ajusté est visible dans le champ `model.name`
de la réponse.

**Détection d'anomalies** — resterait par règles, mais les *seuils* devraient être calibrés sur vos
corridors : 45 minutes d'arrêt est normal à un poste-frontière et anormal sur une nationale. Ces
seuils sont déjà des paramètres de requête.

**Trafic** — remplacez le stub. La météo est en direct (Open-Meteo alimente la prédiction de retard,
voir `docs/INTEL.md`) ; un fournisseur de trafic derrière l'interface du moteur ETA ferait de même
pour la congestion.

**Distances routières** — `OSRM_URL` remplace l'approximation orthodromie × 1,25 par de vraies
distances routières. C'est la seule approximation du système qui puisse se tromper de plusieurs
dizaines de kilomètres sur un trajet sinueux.

**Positions de navires** — `AISSTREAM_API_KEY` (gratuit) bascule le suivi maritime sur l'AIS
mondial réel. Le simulateur s'arrête automatiquement : mélanger des positions réelles et inventées
pour un même navire produirait une trace que personne ne pourrait démêler.

---

## 5. Ce que je n'ai pas fait, et que je ne prétends pas avoir fait

- Je n'ai **pas** entraîné de grand modèle, ni fine-tuné quoi que ce soit.
- Je n'ai **pas** utilisé de LLM à l'exécution. Aucun appel à une API de génération de texte n'a
  lieu dans ce produit. Les explications sont composées par du code à partir des nombres calculés,
  ce qui garantit qu'elles décrivent le calcul réel plutôt qu'une paraphrase plausible.
- Je n'ai **pas** entraîné sur des données de fret réelles — je n'en avais aucune.
- Les **onze défauts** trouvés pendant la construction (listés dans [PROGRESS.md](PROGRESS.md))
  l'ont été en exécutant le système, pas en le relisant. Trois d'entre eux étaient des erreurs de
  modélisation qui produisaient des chiffres crédibles et faux.

La règle appliquée partout : **aucune recommandation sans justification**. Ce n'est pas une
convention de style, c'est imposé au niveau des types — la dataclasse `Recommendation` n'a pas de
valeur par défaut pour `reasons`, donc une recommandation sans raisons ne peut pas être construite.

---

## 6. Résumé en une page

**L'idée** : relier le suivi et la décision, pour qu'un retard observé devienne automatiquement une
commande recommandée, justifiée, et exécutable en un clic.

**L'IA** : un modèle de prévision réellement entraîné sur vos données à chaque requête ; un modèle
de retard qui s'entraîne quand vous lui donnez de quoi apprendre et refuse sinon ; et neuf
composants qui sont de l'optimisation mathématique, des statistiques classiques ou des règles
expertes — parce que c'est le bon outil pour chacun d'eux.

**L'entraînement** : rien n'est pré-entraîné. Ce qui apprend, apprend sur vos données, à
l'exécution, avec une validation glissante et une sélection de modèle qui peut parfaitement
conclure que le modèle le plus simple gagne — et qui le fait effectivement.

**L'honnêteté** : chaque hypothèse est publiée dans la réponse qu'elle affecte. Chaque stub est
étiqueté. Chaque ligne synthétique est marquée. Un chiffre que le système ne peut pas mesurer, il
le dit, au lieu d'afficher zéro.
