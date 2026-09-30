# Démonstration SCIP — script de 10 minutes

Un déroulé minuté, clic par clic, pour présenter SCIP sur le jeu de démo (entreprise ghanéenne,
entrepôt principal Accra Central DC). Les libellés entre « » sont ceux de l'écran en français.

L'histoire racontée : **un camion va être en retard, SCIP le voit avant tout le monde, en tire les
conséquences sur le stock et propose une commande ; l'humain décide.** C'est la « Boucle de
décision » : TRACK détecte → OPTIMISE recalcule → Recommandation → Décision humaine.

## Préparation

### La veille

1. Installer SCIP (installeur `SCIP-Setup.exe`), puis au premier lancement cliquer
   « Explorer avec les données de démo ». Ou reprendre une installation où la démo est déjà
   chargée.
2. Se connecter avec « Admin société » (préremplie, mot de passe commun des comptes de démo
   affiché sur l'écran de connexion) → « Se connecter ».
3. Vérifier en haut à droite la pastille « IA en ligne ». Si elle affiche « IA hors ligne »,
   redémarrer SCIP ; sinon, préparer le plan B (plus bas).
4. Faire **une répétition complète** du déroulé ci-dessous, chronomètre en main.
5. Menu du compte (en haut à droite) → « Réglages » → panneau « Sauvegarde » → « Créer une
   sauvegarde » : la sauvegarde de référence, à restaurer si la démo est abîmée.
6. Si possible, brancher le PC sur le secteur et désactiver la mise en veille.

### 5 minutes avant

1. Menu du compte → « Réglages » → panneau « Démonstration » (en tête de page) →
   **« Préparer la démo »**. Le résumé affiche 11 livraisons reparties de leur origine, les
   retards à venir « SHP-DEMO-0054, SHP-DEMO-0055 », et le SKU-006 remis à deux jours de stock.
2. Attendre 30 secondes, puis ouvrir « Carte live » → filtre « En retard » : il doit compter 2.
   Si ce n'est pas le cas après une minute, cliquer de nouveau « Préparer la démo ».
3. Revenir sur « Control ».

**Ne pas préparer plus de 5 minutes avant** : les trajets courts (Accra → Cape Coast, Accra → Ho)
arrivent environ 13 minutes après la préparation, les deux camions en retard environ
14 minutes après. « Préparer la démo » se relance autant de fois qu'on veut : en cas de doute,
on relance.

## Déroulé (10 minutes)

| Temps | Écran | Message clé |
|---|---|---|
| 0:00 | Control | La boucle de décision |
| 1:00 | Carte live | Deux camions en retard, vus en direct |
| 3:00 | Alertes | SCIP a prévenu les bonnes personnes |
| 4:00 | Stocks | Conséquence : rupture du SKU-006 dans deux jours |
| 5:30 | Conseils | Une commande proposée, expliquée, acceptée |
| 7:00 | Commandes | La commande suit son cycle |
| 8:00 | Situation | Ce qui se passe autour du réseau |
| 9:00 | Réglages | Les données restent à vous : sauvegarde |

### 0:00 — Control (tableau de bord)

- Écran d'arrivée de l'administrateur (onglet « Control »).
- Montrer le panneau **« Boucle de décision »** et ses quatre étapes :
  - 01 « TRACK détecte » : les signaux à examiner ;
  - 02 « OPTIMISE recalcule » : prévision, allocation, tournées ;
  - 03 « Recommandation » : les conseils ouverts ;
  - 04 « Décision humaine · BC créé ».
- À dire : « SCIP suit la flotte et les stocks, détecte ce qui dérape, recalcule, et propose.
  Rien n'est envoyé sans accord humain. »
- Mentionner les raccourcis affichés : J/K pour parcourir, A pour accepter, W pour « Pourquoi ? ».

### 1:00 — Carte live

1. Onglet « Carte live ». Le titre annonce « … véhicule(s) en écart · 2 en retard ».
2. Cliquer le filtre **« En retard »** : il reste deux camions, SHP-DEMO-0054 (Accra → Kumasi)
   et SHP-DEMO-0055 (Tema → Takoradi).
3. Cliquer l'un des deux camions. Le panneau de droite montre :
   - « Expédition à bord » : destination, ETA, « Risque de retard » ;
   - « Météo au véhicule » ;
   - « Caméras publiques les plus proches ».
4. À dire : « L'ETA est recalculée toutes les 30 secondes à partir des positions GPS. Ici la
   promesse client ne peut plus être tenue, même dans l'hypothèse la plus favorable : SCIP a
   basculé l'expédition en retard tout seul. »
5. Zoomer de trois crans à la molette. Les petits points qui roulent sont le **trafic simulé**
   sur les vraies routes ; la ligne d'état le dit (« Trafic simulé sur routes réelles ·
   vitesses estimées »).
6. À dire : « Les positions de nos camions sont réelles (ici simulées pour la démo, marquées
   DEMO). Le trafic autour est simulé, et SCIP ne le cache pas. Là où une ville publie ses
   mesures, comme Rennes ou Grenoble, les vitesses sont réelles. »
7. Facultatif : activer « Avions ». Les avions en vol sont réels, sans clé.

### 3:00 — Alertes

1. Cliquer la cloche en haut (« Alertes »), ou le panneau « File d'alertes » de Control.
2. Montrer la notification « L’expédition SHP-DEMO-0054 est en retard » → « ouvrir → ».
3. La chronologie de la fiche d'expédition montre le départ, puis la détection du retard avec
   l'ETA projetée face à la promesse.
4. À dire : « Les responsables logistique, supply chain et la direction sont prévenus. Personne
   n'a eu à regarder la carte au bon moment. »

### 4:00 — Stocks

1. Onglet « Stocks ». Taper **SKU-006** dans la recherche (« référence ou nom »), ou le cliquer
   dans « Alertes ouvertes ».
2. Cliquer la ligne : la « Projection 10 j » à droite montre la rupture (eau en bouteille
   12×1,5 L : 620 unités à Accra Central DC, environ 310 vendues par jour, rien en commande).
3. Cliquer **« Demander une recommandation »** (bouton du haut). Toast : « Recommandations
   actualisées — relisez-les avant toute commande » → « Voir les conseils ».
4. À dire : « Un camion en retard, c'est du stock qui n'arrive pas. SCIP relie les deux. »

### 5:30 — Conseils

1. Sur « Conseils », ouvrir la recommandation de commande du SKU-006.
2. Appuyer sur **W** (« Pourquoi ? ») : l'explication donne le résumé, les raisons et les
   hypothèses. Montrer qu'aucune recommandation n'est une boîte noire.
3. Appuyer sur **A**, ou cliquer « accepter et exécuter ». SCIP crée un bon de commande
   **brouillon** chez le fournisseur retenu. Toast : « Bon de commande brouillon … créé
   auprès de … Vérifiez-le et confirmez-le. » → « Ouvrir les commandes ».
4. Si la liste est vide : cliquer « régénérer les recommandations » et attendre « Analyse
   terminée ».

### 7:00 — Commandes

1. Onglet « Commandes » : la nouvelle commande porte l'origine « Recommandation ».
2. Dans sa dernière colonne, menu « passer à… » → « En attente », puis de nouveau « passer à… »
   → « Confirmée ». Toast : « … passée à « Confirmée » ».
3. À dire : « La commande confirmée compte comme stock entrant : SCIP ne proposera pas une
   deuxième fois la même commande. »

### 8:00 — Situation

1. Onglet « Situation » : les dangers autour du réseau, relevés toutes les 5 minutes (séismes,
   incendies, cyclones, inondations, actualités), classés selon ce qu'ils touchent.
2. Montrer « Signaux classés » et « Exposition », puis ouvrir « Sources » : chaque flux et son
   état.
3. À dire : « Sélectionnez un signal pour créer un incident. Ces sources sont gratuites, et
   presque toutes fonctionnent sans clé. »

### 9:00 — Réglages et conclusion

1. Menu du compte → « Réglages » → panneau **« Sauvegarde »** (voir la section Sauvegarde).
2. Conclure : « Détecter, recalculer, proposer, décider : la boucle complète en dix minutes,
   installée sur ce PC, sans serveur ni abonnement. »

## Questions probables

**Les positions des camions sont-elles réelles ?**
Dans la démo, elles sont simulées et marquées DEMO partout. En production, elles viennent des
balises GPS GT06 ou de l'application chauffeur (« Drive » sur téléphone) ; les deux sont
stockées différemment et jamais confondues.

**Le trafic routier est-il réel ?**
Les véhicules du trafic sont simulés sur les vraies routes (aucune source publique ne donne la
position de chaque voiture). Les vitesses sont réelles là où une source existe : Rennes et
Grenoble sans clé, le monde entier avec une clé TomTom.

**Que fait l'IA exactement ?**
Prévision de la demande, risque de retard, recommandations de commande et de stock. Chaque
recommandation s'explique (« Pourquoi ? ») et rien n'est exécuté sans accord.

**Et sans internet ?**
Le suivi, les stocks, les commandes et l'IA tournent sur le PC. La carte bascule sur un fond
hors ligne (Natural Earth). Seuls les flux externes s'arrêtent : trafic, avions, navires,
dangers.

**Plusieurs entreprises, plusieurs utilisateurs ?**
Chaque compte a un rôle (administrateur, supply chain, logistique, achats, entrepôt,
chauffeur…) et ne voit que ce que son rôle permet. Les données de chaque entreprise sont
isolées.

**Où sont mes données ? Et si le PC tombe en panne ?**
Sur ce PC, dans la base intégrée. Une sauvegarde en un clic produit un seul fichier à copier
sur une clé USB, et se restaure sur un autre PC.

**Combien ça coûte à faire tourner ?**
Rien pour les sources ouvertes. TomTom est facultatif : la clé est celle de l'utilisateur, avec
un budget journalier réglable pour rester dans son quota gratuit.

## Plan B

**Pas d'internet.** Tout le déroulé fonctionne, sauf :
- la carte affiche le fond hors ligne et la ligne d'état dit « Trafic routier indisponible hors
  connexion » ;
- les avions, les navires et la page Situation sont vides.

Le dire franchement (« les flux externes ont besoin du réseau, le cœur de SCIP non »), puis
enchaîner.

**Moteur IA arrêté** (pastille « IA hors ligne », « régénérer » répond que le service IA ne
répond pas) :
1. Sur Control, l'étape 02 affiche « IA hors ligne · règles locales ».
2. Montrer la boucle avec l'historique :
   - « Conseils », pastilles « Acceptés » / « Exécutés » : les recommandations déjà décidées et
     ce qu'elles ont créé ;
   - « Commandes », indicateur « Issues d'une recommandation » et colonne « Origine ».
3. Relancer SCIP après la démo.

**Les retards n'apparaissent pas.** Réglages → « Préparer la démo », attendre 30 secondes, et
continuer sur Stocks en attendant.

**La démo a été abîmée (données supprimées, mauvaise manipulation).** Après la présentation,
restaurer la sauvegarde de référence faite la veille. Ne pas le faire pendant : voir Sauvegarde.

## Sauvegarde

À montrer en fin de démo (minute 9), pas avant :

1. Menu du compte → « Réglages » → panneau « Sauvegarde » → **« Créer une sauvegarde »**.
   Toast : « Sauvegarde créée (… Mo) » après quelques secondes. La liste montre la date,
   l'entreprise et « … expéditions · … commandes · … comptes ».
2. **« Ouvrir le dossier »** : l'Explorateur Windows s'ouvre sur `Documents\SCIP\Sauvegardes`
   avec le fichier `SCIP-sauvegarde-AAAA-MM-JJ-HHMMSS.scip-backup`.
3. À dire : « Un seul fichier : toute la base et les preuves de livraison. Il ne contient ni
   secret de ce PC ni clé API ; les mots de passe n'y sont que chiffrés. Copiez-le sur une clé
   USB, restaurez-le sur un autre PC. »

**Ne pas restaurer pendant la démo** : « Restaurer… » remplace toutes les données puis
redémarre les services (environ une minute), et il faut se reconnecter.
