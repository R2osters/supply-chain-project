# Suivre un camion en temps réel — ce qu'il faut réellement faire

Ce document répond à une seule question : **un client veut voir ses camions bouger sur une carte.
Que doit-il faire, et combien cela coûte-t-il ?**

Il s'adresse à la personne qui doit décider puis mettre en œuvre, pas à un développeur. Là où
quelque chose ne fonctionne pas, c'est écrit.

---

## 1. Le problème dont personne ne parle

« Suivi de camions en temps réel » sonne comme une fonctionnalité logicielle. Ce n'en est pas une.
Un logiciel ne voit pas un camion. Il faut que **quelque chose de physiquement présent dans le
véhicule** connaisse sa position et la transmette sur un réseau mobile. Tous les produits de suivi
du marché sont un emballage autour de ce seul fait, et tout l'écart de prix vient de la nature de ce
« quelque chose ».

La vraie décision n'est donc pas « quelle plateforme » mais **ce qu'on met dans la cabine**. Il y a
trois réponses, et SCIP les accepte toutes les trois par la même chaîne de validation : une position
venue d'un traceur à 15 € est contrôlée aussi sévèrement qu'une position venue de l'API.

| Voie | Coût matériel | Coût courant | Pour qui | Marche sans chauffeur |
| --- | --- | --- | --- | --- |
| **Téléphone du chauffeur** | **0 €** | ~30 Mo/mois de données | Tout le monde. Sous-traitants, véhicules loués, dès le premier jour. | Non |
| **Traceur GPS filaire** | 15–50 € une fois | Une SIM, ~30 Mo/mois | Flotte en propre, remorques, véhicules non accompagnés | Oui |
| **Télématique déjà en place** | Déjà payée | Déjà payée | Flottes sous Traccar / Webfleet / Samsara | Oui |

La suite détaille ce que chaque voie exige, dans l'ordre.

---

## 2. Voie A — le téléphone du chauffeur (0 €)

**Chaque chauffeur porte déjà un récepteur GPS.** Cette voie l'utilise. Rien à acheter, rien à
installer dans le véhicule, et cela fonctionne dès le premier jour.

### Ce que fait l'exploitation, une fois par chauffeur

1. Ouvrir **Boîtiers** dans SCIP.
2. Choisir **Téléphone du chauffeur**, saisir un nom stable (`kwame-phone-01`), choisir le véhicule,
   appuyer sur **Enregistrer**.
3. Un **lien d'appairage** apparaît. Le copier et l'envoyer au chauffeur — WhatsApp, SMS, peu
   importe. Il n'est affiché **qu'une seule fois**. S'il est perdu, réenregistrer le téléphone pour
   en émettre un nouveau.

### Ce que fait le chauffeur, une fois

1. Toucher le lien. La page s'ouvre avec l'identifiant et le code déjà remplis — rien à taper.
2. Toucher **Ajouter à l'écran d'accueil**. Elle s'ouvre ensuite en plein écran, comme une
   application.

### Ce que fait le chauffeur, à chaque trajet

1. L'ouvrir, appuyer sur **Démarrer**.
2. Brancher le téléphone et laisser l'écran allumé.

C'est toute la procédure.

### Ce que cette voie ne sait honnêtement pas faire

**Elle cesse de transmettre dès que l'écran s'éteint ou que le chauffeur change d'application.** Ce
n'est pas un défaut ni un réglage oublié : un navigateur mobile suspend les minuteries et la
surveillance de position d'une page qui n'est plus visible — immédiatement sur iOS Safari, en une
minute ou deux sur Android Chrome. Aucune page web ne peut contourner cette règle. Seule une
application native avec un service de premier plan le peut, et c'est un autre produit.

Ce que l'écran fait face à cela :

- Il maintient un **verrou d'écran** (*wake lock*), donc l'affichage ne s'éteint pas de lui-même
  tant que la page est ouverte.
- Il le dit à l'écran, en clair, plutôt que d'afficher un voyant vert qui ne veut rien dire.
- **Chaque position relevée est conservée**, donc rien n'est perdu : le tout part quand le chauffeur
  revient sur l'écran.

Deux autres contraintes réelles :

- **Batterie.** Le GPS en continu coûte environ 5 à 10 % par heure. Quatre heures de route sur un
  téléphone non branché n'est pas réaliste. Un chargeur allume-cigare à 3 € règle le problème ;
  prévoyez-en un par camion.
- **Données.** Une position pèse ~150 octets. À raison d'une toutes les 10 secondes, une journée de
  10 heures représente environ **5 Mo** : un forfait de 30 Mo par mois est largement suffisant.

### Ce que cette voie fait mieux que le matériel

**Les zones sans couverture.** La route Accra–Kumasi perd le signal cellulaire sur des dizaines de
kilomètres d'affilée. Le GPS s'en moque — il écoute des satellites, pas des antennes — donc le
téléphone continue d'enregistrer et stocke les positions dans sa propre base de données. Au retour
du signal, l'arriéré part en un seul envoi et la trace **n'a aucun trou** précisément là où
l'exploitation aurait le plus voulu voir le camion.

La plupart des traceurs matériels bon marché perdent purement et simplement ces positions.

---

## 3. Voie B — un traceur GPS filaire (15–50 € par véhicule)

Pour un véhicule qui doit transmettre qu'un chauffeur soit à bord ou non — remorque, citerne, camion
à chauffeurs tournants — il faut du matériel.

### Quoi acheter

Le boîtier banalisé est un traceur **GT06 / Concox**. Il est vendu sous une centaine de marques
(GT06N, TR06, JM-VL01, etc.) entre **15 et 50 €**, et tous parlent le même protocole. N'importe
lequel convient. N'achetez pas d'« abonnement de suivi » vendu avec le boîtier : c'est le boîtier
qui est utile.

Il faut aussi une **SIM data** par véhicule. N'importe quel forfait prépayé de 30 Mo/mois suffit.

### Ce que fait l'installateur

1. Insérer la SIM.
2. Câbler : 12/24 V permanent, masse, et le fil de détection de contact. Trois fils derrière le
   tableau de bord — n'importe quel électricien auto le fait en vingt minutes. Un modèle magnétique
   sur batterie ne demande aucun câblage, mais doit être rechargé.
3. Envoyer au traceur **quatre SMS**, car c'est ainsi que ces appareils se configurent :

   ```
   APN#<l'APN de votre opérateur>#
   server#<votre hôte public>#5023#
   timer#30#
   ```

   La ligne `server` exacte est affichée sur l'écran **Boîtiers**, déjà remplie avec votre hôte.

4. Dans SCIP, choisir **Traceur GT06 / Concox**, saisir l'**IMEI** (15 chiffres, imprimés sur le
   boîtier et sur sa boîte), choisir le véhicule, appuyer sur **Enregistrer**.

Le traceur se connecte seul et apparaît **ONLINE** en moins d'une minute.

### Pourquoi il faut un port dédié et pas « une API »

Ces appareils ne parlent pas HTTP. Ils ouvrent un socket TCP brut et envoient des **trames
binaires** — `0x7878`, un octet de longueur, un octet de protocole, une charge utile, un numéro de
série sur deux octets, une somme de contrôle CRC-ITU, `0x0D0A` — et ils attendent que le serveur
accuse réception de chacune avant d'envoyer la suivante. Un appareil sans accusé considère que le
serveur est mort, raccroche et rappelle, ce qui consomme le forfait de la SIM.

SCIP fait donc tourner une **passerelle TCP sur le port 5023** à côté de l'API web. Le choix du 5023
est délibéré : c'est le port utilisé par Traccar pour le GT06, donc un appareil déjà configuré pour
une installation Traccar pointe ici sans être reprogrammé.

**Ce qu'il faut ouvrir au pare-feu : le TCP entrant sur 5023.** C'est la seule modification
d'infrastructure qu'exige cette voie.

### Ce qui est décodé aujourd'hui

Connexion (`0x01`), GPS (`0x12`), état (`0x13`), GPS+LBS (`0x22`), alarme (`0x16`),
GPS+LBS+état (`0x26`) et synchronisation d'horloge (`0x8A`). Le contact, le niveau de batterie,
l'état de charge et les alarmes SOS / coupure d'alimentation remontent tous — un SOS déclenche un
**incident critique et un e-mail**, pas une ligne de journal.

**Le Codec 8 de Teltonika n'est pas décodé.** Le type d'appareil existe dans le système, et
l'enregistrer le référence, mais il ne stockera aucune position. C'est indiqué sur l'écran
d'enregistrement, plutôt que découvert plus tard.

---

## 4. Voie C — une flotte déjà équipée en télématique

Si les véhicules portent déjà du Webfleet, Samsara, Geotab ou un serveur Traccar, les positions
existent — elles sont simplement ailleurs. Il suffit de les poster sur :

```
POST /api/v1/devices/phone/positions
```

avec l'identifiant et le code d'un boîtier `MANUAL`, jusqu'à 500 positions par requête. La même
validation s'applique. C'est un point d'entrée documenté, pas une intégration avec un éditeur
particulier : **aucun connecteur fournisseur n'est écrit**, et aucun n'est annoncé.

---

## 5. Ce qui arrive à une position une fois reçue

Toute position, quelle que soit sa voie, passe par les mêmes contrôles. Aucun n'est cosmétique :
chacun existe à cause de la panne qu'il attrape, et chacune de ces pannes met un camion au mauvais
endroit sur la carte de l'exploitant.

| Contrôle | Pourquoi |
| --- | --- |
| Latitude / longitude dans les bornes | Une trame corrompue se décode en n'importe quoi |
| **Pas (0, 0)** | Un traceur sans fix satellite renvoie l'*île nulle*. Elle est à quelques centaines de km du Ghana — sur la carte elle paraît *presque* plausible, et c'est ce qui la rend dangereuse |
| Horodatage pas dans le futur | Un traceur à l'horloge fausse : rejeté plutôt que cru |
| Vitesse implicite sous 250 km/h | Deux positions qui exigeraient un avion entre elles |
| Déplacement d'au moins 8 m | La gigue GPS d'un camion à l'arrêt est du bruit, pas du mouvement |

Les rejets sont **comptés par boîtier** et affichés sur l'écran Boîtiers. Un traceur dont le compteur
de rejets monte est un traceur qui a un problème, et cela se voit **avant** que quelqu'un remarque
que la carte est fausse.

Les positions acceptées sont écrites dans `gps_positions` avec une colonne géographique PostGIS,
poussées vers la carte en direct par WebSocket cloisonné à votre entreprise, et utilisées pour
recalculer l'ETA de l'expédition et son contrôle de déviation d'itinéraire.

**Les positions issues d'un boîtier portent `isSimulated = false`.** Les données de démonstration
produites par le simulateur intégré portent `true` et sont marquées dans l'interface. Les deux ne
sont jamais mélangées ni présentées comme équivalentes.

### Les boîtiers passent OFFLINE tout seuls

Un traceur qui perd l'alimentation ne dit pas au revoir — le socket meurt sans fermeture propre. Un
balayage tourne chaque minute et marque OFFLINE tout boîtier ayant manqué **cinq** de ses propres
intervalles d'émission. Sans lui, l'écran afficherait un camion ONLINE indéfiniment, ce qui est pire
que de ne rien afficher : un point vert se lit comme « je saurais s'il s'était arrêté ».

---

## 6. Recommandation

- **Commencez par les téléphones.** Coût nul, opérationnel le jour même, et cela vous dit si le
  suivi change réellement votre façon d'exploiter **avant** de dépenser quoi que ce soit.
- **Achetez du matériel pour les véhicules où la voie téléphone échoue** : remorques, véhicules non
  accompagnés, chauffeurs tournants, ou tout trajet assez long pour que l'écran allumé ne soit pas
  réaliste.
- **Prévoyez 3 € de chargeur allume-cigare par téléphone.** C'est l'élément le moins cher de cette
  page et la première raison pour laquelle le suivi par téléphone déçoit.

---

## 7. Vérification — comment nous savons que cela fonctionne

Les deux voies ont été testées contre le système en marche, pas lues.

**Voie matérielle.** Un script ouvre un vrai socket TCP vers le port 5023 et parle le protocole GT06
au niveau du fil : connexion, accusé de réception, état, puis trames GPS le long de la route
Accra–Kumasi. Résultat : **6 positions envoyées, 6 acceptées, 0 rejetée**, coordonnées exactes à
quatre décimales, stockées avec `isSimulated = false`.

Un essai antérieur du même script avait donné **5 rejets sur 6**. La cause était dans le test, pas
dans le serveur : il estampillait six positions à 700 ms d'intervalle sur 250 km, soit 70 000 km/h,
et le contrôle de plausibilité les a refusées. C'est le contrôle qui fait son travail.

**Voie téléphone.** Un script poste des lots sur le point d'entrée réel, en retenant délibérément une
portion centrale pour imiter une zone sans couverture, puis en l'envoyant en retard. Résultat :
**7 positions, toutes acceptées, aucun trou dans la trace stockée**. Une requête avec un mauvais code
d'appairage a été refusée.

**Le codec** compte 26 tests unitaires, dont les deux cas d'hémisphère. Le CRC est ancré sur une
**vraie trame de connexion matérielle**, et non sur un vecteur inventé pour faire passer le test.

---

*English version: [TRACKING.md](TRACKING.md)*
