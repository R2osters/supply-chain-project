# Vidéo de présentation SCIP — « LE SIGNAL » (spec de design)

Date : 29 septembre 2026. Statut : validé section par section avec l'auteur du projet, en attente
de relecture de ce document.

## 1. Objet

Une vidéo de **motion design** de 170 secondes qui présente SCIP en classe, en ouverture de la
soutenance. Elle est projetée, en français, devant les camarades et l'enseignant. Elle doit
expliquer ce que fait le logiciel (la boucle SUIVRE → OPTIMISER, les fonctions fortes, le fait
que c'est un logiciel Windows qui marche sans clé d'API), et être la plus créative possible.

### Décisions prises

| Sujet | Décision |
|---|---|
| Style | Motion design ; toute l'interface est **recréée** en vecteurs animés, aucune capture d'écran |
| Durée, format | 170 s, 1920×1080, 30 fps, MP4 H.264 + AAC |
| Concept | « LE SIGNAL » : le film est un morceau de musique, un retard est une fausse note |
| Identité | Charte SCIP v1.0 « poussée » (gris neutres, encre, IBM Plex, couleur = événement) |
| Voix | Voix off neuronale `fr-FR-RemyMultilingualNeural` via edge-tts ; « SCIP » se dit « Skip » |
| Musique | Composée par code (synthèse procédurale), aucune musique sous licence |
| Technique | Remotion (React → MP4) ; composants React Bits adaptés au rendu image par image |
| Emplacement | `media/promo-video/`, hors des workspaces npm du logiciel |
| Fin | Logo animé + « SCIP — Supply Chain Intelligence Platform » + slogan, aucun nom de personne |

### Origine du concept

Quatre concepts ont été écrits indépendamment (le protagoniste, le plan-séquence, la typographie,
le signal). Chacun a été vérifié contre le code et la documentation, puis noté par trois juges
(créativité, clarté, faisabilité et charte). L'auteur a choisi « Le Signal ». Cette spec reprend ce
concept et y applique toutes les corrections du fact-check et les critiques des juges (§ 9).

## 2. Principe créatif

La chaîne logistique est une partition, le film est un séquenceur.

- **Une grille unique.** 120 BPM, 4/4 : 1 temps = 15 images, 1 mesure = 60 images = 2 s,
  85 mesures = 170 s. Toutes les coupes tombent sur un multiple de 15 images, et les changements
  de section sur un multiple de 60. **Une seule exception, volontaire** : le temps en retard de
  7 images au début (S01).
- **Un arc harmonique.** Le film est en ré mineur. Le motif du retard est une seconde mineure
  (ré contre mi♭). Il revient à chaque retard. La grappe se résout en accord propre (ré-fa-la)
  quand la recommandation tombe. Le clic de l'humain ouvre une mesure de **ré majeur** (tierce
  picarde), et la résolution définitive en ré majeur arrive sous le logo.
- **Couplets et refrains.** Les scènes claires sont des couplets, les scènes sombres sont les
  refrains, le pont et la coda.
- **La tête de lecture.** Un trait d'encre vertical de 2 px, avec un timecode en Plex Mono.
  Ce qu'il traverse se déclenche (échelle 1 → 1,25 → 1 sur 8 images) et fait un son. Son balayage
  d'un temps est aussi la seule transition entre thèmes.
- **Jumeau visuel, jumeau sonore.** Chaque couleur de signal de la charte est un son de
  percussion (§ 5.3). Une couleur n'apparaît **que** sur un événement à l'écran, et toujours avec
  son son. Une salle au son faible reçoit donc l'information par l'image, et une couleur ne peut
  pas devenir décorative.
- **Honnêteté.** Chaque identifiant fictif (SHP-0142, SKU-006, PO-2026-0418…) porte la pastille
  violette **DÉMO**, comme dans le logiciel. Les chiffres d'illustration portent **EXEMPLE**.

Slogan : **« Entendre le retard. Jouer la réponse. »**

## 3. Système visuel

### 3.1 Cadre et lisibilité

- 1920×1080, marges de sécurité de 96 px.
- **Taille minimale du texte : 24 px** (projecteur). Les libellés prévus à 20 px dans le concept
  d'origine passent à 24 px.
- Si le test sur projecteur délave les gris clairs, les filets des scènes claires passent de
  `#d6d8db` à `#c9ccd0`. C'est la seule entorse permise à la charte.
- Photosensibilité : 3 flashs par seconde au maximum, pas de flash plein écran de plus de
  2 images, flash blanc limité à 40 % d'opacité.

### 3.2 Couleurs (charte v1.0)

| Rôle | Clair | Sombre |
|---|---|---|
| Fond | `#e3e4e6` | `#121314` |
| Surface | `#f1f2f3` | `#1b1c1e` |
| Surface 2 | `#ffffff` | `#242528` |
| Filet | `#d6d8db` | `#2c2e31` |
| Encre (texte, action unique) | `#141516` | `#ececec` (action `#f2f2f2`) |
| Atténué | `#5c6166` | `#9a9ea3` |
| Faible | `#747a80` | `#80858a` |
| Carte (terre) | `#dcdee1` | `#1a1b1d` |
| crit | `#c8412f` | `#e0685a` |
| warn | `#a8740f` | `#d4a24a` |
| ok | `#3f8a5c` | `#6fb58a` |
| live | `#2f8a55` | `#5fc98b` |
| info | `#3b6fb0` | `#7aa7dc` |
| démo (violet) | `#6e56c9`, fond `rgb(110 86 201 / .1)` | `#a993ec` |

Règles :

- 90 % de chaque image est en neutres.
- L'encre est la seule couleur d'action : tête de lecture, bouton, logo, typographie géante.
- Les couleurs de signal n'apparaissent que sur de petites surfaces et seulement sur un
  événement : points, pastilles, pics, zones de jauge, barrés, crêtes de VU-mètre, ondes.
- Le texte « FAUSSE NOTE. » et le « 68 % » sont en crit. Aucun aplat de couleur.
- Le violet ne sert qu'aux données de démo.

### 3.3 Typographie

Les polices sont locales (paquets `@fontsource`, licence SIL OFL 1.1), et le rendu est bloqué
tant qu'elles ne sont pas chargées.

| Usage | Police | Taille |
|---|---|---|
| Affichage géant, capitales, approche -0,02 em | IBM Plex Sans Condensed SemiBold | 150-420 px |
| Identifiants, chiffres, timecodes, libellés (+0,08 em en capitales) | IBM Plex Mono Medium, chiffres tabulaires | 24-40 px (jusqu'à 120 px pour l'horloge) |
| Phrases, slogan | IBM Plex Sans Regular/Medium | 36-44 px |

Les nombres suivent le format français : « 3 000 », « 24,13 », « 68 % » (espaces insécables).

### 3.4 Formes

- Rayons : 4 px (cellules, pastilles), 6 px (puces, boutons), 10 px (cartes), 14 px (carte
  héros, gros bouton).
- Ombres : `0 1px 2px rgb(0 0 0/.08)`, `0 6px 18px rgb(0 0 0/.14)`, `0 20px 48px rgb(0 0 0/.24)`,
  plus marquées en sombre.
- Logo « conteneur localisé » (viewBox 24×24) : tracé
  `M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Zm8 4.2L5.6 8.9v5.4l6.4 3.6 6.4-3.6V8.9Z` (evenodd), anneau
  en (12, 10.2) de rayon 2,4, point de rayon 1,1. Le glyphe conteneur des notes est ce même
  hexagone, sans le point.

### 3.5 Mouvement

- Entrées en ease-out `cubic-bezier(0.22, 1, 0.36, 1)`, 6-18 images. Sorties en coupe franche ou
  en `cubic-bezier(0.64, 0, 0.78, 0)`.
- **Une seule courbe in-out** dans tout le film : le glissement de la fenêtre ETA en S05
  (`cubic-bezier(0.65, 0, 0.35, 1)`).
- La portée et les rubans défilent en linéaire, sans jamais ralentir (logique de bande).
- Le bras du séquenceur avance **par crans**, un cran de 22,5° par temps en 6 images. La seule
  rotation continue est celle du drop (S08).
- Transitions : (1) balayage de la tête de lecture sur un temps pour changer de thème ; (2) coupe
  franche sur un premier temps dans un même thème ; (3) poussée ou recul de caméra (échelle,
  18-20 images, ease-out, jamais de flou) ; (4) morphose d'un élément qui survit à la coupe.
- Les mots déclenchés par la voix sont quantifiés à la double croche la plus proche
  (7,5 images, arrondi), et apparaissent 2 images avant leur horodatage.

### 3.6 Composants récurrents

| Composant | Rôle |
|---|---|
| `Pin`, `Logo`, `ContainerGlyph` | Tracés exacts du logo ; le point du logo est le métronome du début et de la fin |
| `Playhead` | Trait de 2 px + timecode Plex Mono |
| `Hud` | En haut à gauche : « ♩ = 120 · MESURE 017/085 » (+1 par mesure). En bas : bande des sections INTRO · COUPLET 1 · PRÉ-REFRAIN · REFRAIN · DROP · COUPLET 2 · CONSOLE · COUPLET 3 · PONT · COUPLET 4 · HORS LIGNE · REPRISE · CODA. En haut à droite : 7 pastilles de 16 px qui s'allument **uniquement** quand leur couleur se déclenche à l'écran |
| `Chip`, `DemoPill`, `ExamplePill`, `Card`, `Button` | Éléments d'interface recréés à la charte |
| `Staff`, `LoopSequencer`, `Gauge`, `Oscilloscope`, `Console`, `VuLane`, `Keys`, `WorldMap`, `IsoStack` | Pièces des scènes, détaillées en § 4 |

### 3.7 React Bits

Les composants sont récupérés en variante **TS-CSS** sur le registre officiel
(`https://reactbits.dev/r/<Nom>-TS-CSS.json`), copiés dans `src/rb/`, puis réécrits pour être
**des fonctions pures de l'image** :

- aucune horloge murale : pas de `requestAnimationFrame`, `setInterval`, `Date`,
  `performance.now()`, ni de timeline GSAP ou d'animation `motion` qui tourne seule ;
- le temps vient de `useCurrentFrame()` : `uTime = frame / fps` pour les shaders, `interpolate` et
  `spring` de Remotion pour le reste ;
- l'aléatoire vient d'un PRNG à graine (`src/lib/prng.ts`), qui dépend de l'image et de l'indice ;
- aucune physique qui s'accumule d'une image à l'autre : on la remplace par une formule
  fermée, ou on la re-simule depuis l'image 0 ;
- WebGL (ogl) : `preserveDrawingBuffer: true`, rendu synchrone dans l'effet déclenché par
  `frame`, `delayRender` jusqu'à la compilation du programme ;
- chaque fichier garde un en-tête avec l'origine (nom, URL) et la licence (MIT + Commons Clause).

| Scène | Composant | Rôle |
|---|---|---|
| S03, S04, S17 | SplitText | Mots géants synchronisés sur la voix |
| S05 | SplitFlapText | Horloge « 14:02 » à palettes |
| S05 | DecryptedText | Statut EN ROUTE → EN RETARD |
| S06 | CountUp | « 68 % » |
| S07, S17 | HoldButton | « ACCEPTER ET EXÉCUTER » qui se remplit pendant un temps avant le clic |
| S08 | RotatingText | OBSERVER → … → EXÉCUTER |
| S10 | Radar (ogl) | Balayage du récepteur AIS, en encre, faible opacité |
| S12 | Counter | Chiffres WAPE qui roulent |
| S14 | Threads (ogl) | Les « cordes » résumé, raisons, hypothèses, pincées |
| S14 | TextType | Panneau de code |
| S15 | StatusMark | Étapes de l'installation |
| Scènes sombres | Noise | Grain de 2-3 %, graine par image |

## 4. Scénario détaillé

Les temps sont en secondes et en mesures (M). « VO écran » est le texte de référence. « VO
parlée » est le texte envoyé à la synthèse, avec les substitutions de prononciation (§ 5.4).
Chaque clip de voix est ancré au début de sa scène, avec un décalage exprimé en doubles croches.

### S01 · Contretemps — 0-6 s (M1-3), sombre, HOOK

- **Image.** Fond `#121314`. Au centre, un point de 14 px `#f2f2f2` (le point du logo). HUD
  « ♩ = 120 · MESURE 001/085 ».
  - Mesure 1 : le point pulse sur 4 clics, et les chiffres « 1 2 3 4 » (Plex Mono 40 px)
    défilent dessous.
  - Mesure 2 : le point glisse à x = 220 et déroule une bande de 2 px vers la droite, avec au-dessus
    « SHP-0142 · EN ROUTE · ETA 14 AOÛT 18:00 » + DÉMO. Une grille de temps défile (1 px `#2c2e31`
    tous les 120 px, 8 px/image). Quatre pics live `#5fc98b` de 80 px tombent pile sur les temps.
  - Mesure 3 : le repère de grille s'allume sans pic. **7 images plus tard** (image 127,
    4,233 s), un pic crit `#e0685a` de 170 px arrive, dentelé, avec 3 sous-crêtes. L'image tremble
    (translateX 10, -8, 5, -2, 0 sur 5 images). « +2 J » en Plex Condensed 380 px crit arrive dans
    le tiers droit.
  - À 4,7 s, la légende « Un retard, ça s'entend. » (Plex Mono 28 px).
- **Son.** Clics (2 kHz accentué sur 1, puis 1,5 kHz, 20 ms). Battement : kick doux + blip 880 Hz
  sur chaque temps. Silence sur le temps attendu. À 4,233 s, l'accord du retard (scies ré3 + mi♭3 +
  ré4, 600 ms, légère réduction de résolution) et un petit impact. Ensuite, seule la résonance
  reste, sans musique.
- **VO.** Aucune.
- **Contrainte.** Le retard de 7 images est identique à l'image et au son. Il n'est jamais
  quantifié.

### S02 · La partition — 6-16 s (M4-8), sombre

- **Image.** La bande rouge devient la ligne ROUTE d'une portée à 5 lignes (y = 380, 460, 540,
  620, 700 ; 2 px `#2c2e31`). Libellés en Plex Mono 24 px : FOURNISSEURS · ROUTE · MER ·
  ENTREPÔTS · STOCK.
  - En guise de clé : l'hexagone du logo (96 px, trait `#f2f2f2`).
  - Tête de lecture fixe à x = 640, avec un timecode dont les secondes défilent de « 14:01:50 » à
    « 14:01:59 ».
  - Notes = glyphes conteneurs de 36 px avec un identifiant Mono (PO-0412, SHP-0142, NAV-03,
    WH-01, SKU-006). Une puce DÉMO sur l'en-tête de la portée couvre tous ces identifiants.
  - La note rouge de S01 reste sur ROUTE, hampe tordue.
  - Mot fantôme « PARTITION » en Plex Condensed 420 px `#1b1c1e`.
- **Mouvement.** Les lignes se tracent depuis le centre, une par temps. La portée défile en
  linéaire. Chaque note qui passe la tête de lecture grossit (1 → 1,25 → 1). Les mots
  « fournisseurs », « camions », « navires », « entrepôts » allument leur ligne pendant un temps.
  Sur « en mesure », toutes les notes glissent en colonne sur la tête de lecture et forment un
  accord (FLIP, 12 images).
- **Son.** Le pad ré mineur entre. Chaque note est un pincement Karplus-Strong dans la
  pentatonique de ré mineur, plus grave pour STOCK et plus aigu pour FOURNISSEURS. Kick doux sur
  1 et 3. Sur « en mesure », un accord Dm propre : la première consonance du film.
- **VO.** « Une chaîne logistique, c'est une partition. Fournisseurs, camions, navires,
  entrepôts : chacun doit jouer en mesure. »

### S03 · Deux questions — 16-24 s (M9-12), clair, COUPLET 1

- **Image.** Balayage vers le clair. Écran coupé par un filet en x = 960.
  - Gauche : « OÙ EST / MA / MARCHANDISE ? », Plex Condensed 170 px, avec un pictogramme de
    repère et la légende « SUIVRE ».
  - Droite : « QUE / COMMANDER ? », avec un pictogramme d'histogramme et la légende « DÉCIDER ».
- **Mouvement.** Mots en SplitText, déclenchés par la voix. Sur la dernière mesure, les deux blocs
  accélèrent l'un vers l'autre et s'écrasent (scaleX 1 → 0,2, ease-in), jusqu'à la collision au
  premier temps de 24,0 s.
- **Son.** Basse en croches sur ré2, kick en 4/4 doux, pas de charleston. Question-réponse : la
  question de gauche a la phrase ré-fa-la, panoramique -0,4 ; celle de droite répond une quarte au
  dessus, sol-si♭-ré, panoramique +0,4. Cymbale inversée vers 24,0 s.
- **VO.** « La plupart des logiciels répondent à une seule question. Où est ma marchandise ? Ou
  bien : que commander ? »

### S04 · SCIP relie — 24-36 s (M13-18), clair

- **Image.** Les deux questions se percutent et deviennent le logo (280 px, trait 3 px), « SCIP »
  en Plex Condensed 400 px et « SUPPLY CHAIN INTELLIGENCE PLATFORM » en Mono 24 px (+0,2 em). Le
  logo s'envole ensuite vers le HUD, où il reste en 40 px jusqu'à la fin.
  - Une route d'encre de 3 px à y = 620 relie une barrière de fournisseur (x = 200) à un quai
    (x = 1720), avec les libellés « PORTE DU FOURNISSEUR » et « QUAI DU CLIENT ». Une puce
    « SUIVRE » est posée sur la route, et un conteneur de 48 px y avance par sauts.
  - Bande du haut : quatre tampons en Plex Condensed 150 px, « QUOI » · « CHEZ QUI » · « QUAND » ·
    « PAR QUELLE ROUTE », sous une puce « OPTIMISER ».
- **Mouvement.** Impact et flash blanc (40 %, 2 images). L'hexagone se trace, puis l'anneau, puis
  le point. Les lettres de SCIP montent. Le conteneur fait 8 sauts, un par temps. Les puces et les
  tampons tombent sur leur mot, et chaque tampon précédent s'atténue.
- **Son.** Impact (sinus 90 → 28 Hz) et ré à l'octave à l'unisson : les deux phrases s'accordent.
  L'arpège entre (carré en doubles croches ré-fa-la-do, filtre qui s'ouvre de 600 Hz). Un sauté =
  un tic de bois. Quatre toms descendants pour les quatre tampons. Charlestons fermés à partir de
  l'image 210.
- **VO.** « SCIP relie les deux : suivre la marchandise, de la porte du fournisseur au quai du
  client, et décider quoi commander, chez qui, quand, par quelle route. »

### S05 · Fausse note — 36-48 s (M19-24), clair qui s'assombrit, PRÉ-REFRAIN

- **Image.** L'oscilloscope de l'ETA.
  - Axe du temps à y = 700, graduations « 12 AOÛT … 18 AOÛT ».
  - PROMESSE : trait d'encre vertical de 2 px en x = 1180, avec la puce « PROMESSE · 14 AOÛT
    18:00 ».
  - Fenêtre ETA : bande de 110 px en info à 14 %, bords info de 2 px, bord gauche « OPTIMISTE »,
    bord droit « PESSIMISTE », repère central « ETA ».
  - Carte : « SHP-0142 · FOURNISSEUR A → ENTREPÔT » + DÉMO + statut « EN ROUTE ».
  - Horloge « 14:02 » en SplitFlapText (Mono 120 px).
  - Tampon final « FAUSSE NOTE. » en Plex Condensed 240 px crit.
- **Mouvement.** Sur « perd deux jours », la bande glisse de deux jours en 36 images, avec
  **la seule courbe in-out du film**.
  - Quand le bord **droit** passe la promesse, teinte warn.
  - Quand le bord **gauche** la passe (placé sur « optimiste ») : teinte crit, la promesse vibre
    (3 px à 12 Hz pendant 10 images), et le statut passe à « EN RETARD » en DecryptedText.
  - Le tampon tombe. Le fond glisse vers `#121314`, puis tout s'arrête sur les images 345-360.
- **Son.** Riser de 4 mesures. Un sinus tenu sur ré4 suit la bande et monte d'un demi-ton vers
  mi♭4 : c'est le motif du retard. Passage warn = rimshot en triton ; passage crit = l'accord du
  retard de S01. Roulement de caisse claire. Silence total de 47,5 à 48 s.
- **VO.** « Quatorze heures deux. Le camion du fournisseur A perd deux jours. Son heure d'arrivée
  recalculée dépasse la promesse, même dans le scénario optimiste. Fausse note. »
- **Fait illustré.** Une expédition passe EN RETARD seulement si même la borne optimiste de sa
  fenêtre d'arrivée dépasse la promesse (`eta-engine.ts`, `assessLateness`).

### S06 · Refrain : la boucle (1) — 48-58 s (M25-29), sombre, REFRAIN

- **Image.** Le séquenceur circulaire de 16 pas, centré en (960, 540), de rayon 360. Cellules de
  28×12 px, bras de 2 px, logo de 120 px au moyeu. Quatre cartes-stations (300×110) :
  « SUIVRE · OBSERVE » à 12 h, « OPTIMISER · RISQUE » à 3 h, « RECOMMANDATION » à 6 h, « HUMAIN ·
  DÉCIDE » à 9 h.
  - La station SUIVRE montre « SHP-0142 · EN RETARD » avec un point crit.
  - Une pilule `shipment.delayed` suit l'arc jusqu'à un cylindre de base de données
    « domain_events · durable », qui clignote (« écrit »).
  - Poussée sur OPTIMISER : la carte s'ouvre sur une jauge-accordeur (arc de 180°, 560 px,
    graduée de 0 à 100, zones neutre, warn et crit). En-tête « ANALYSE DE RISQUE · RELANCÉE ».
  - Trois aiguilles de SKU (SKU-006, SKU-011, SKU-014, avec DÉMO) se recalculent l'une après
    l'autre. La dernière se pose sur **« 68 % »** (CountUp, Plex Condensed 220 px crit), avec
    « RISQUE DE RUPTURE » et une pastille **EXEMPLE**.
- **Mouvement.** Les cellules apparaissent dans le sens horaire, une image d'écart. Le bras
  avance par crans. L'aiguille est un ressort (amortissement 12, raideur 90) qui dépasse jusque
  vers 74 avant de se poser, sur « soixante-huit » quantifié au temps. Recul vers l'anneau entier
  sur les images 285-300.
- **Son.** Refrain complet : kick 4/4, clap sur 2 et 4, charlestons en doubles croches, basse en
  sidechain, pad, arpège ouvert. La station SUIVRE qui s'allume = accord crit. L'écriture en base =
  deux blips carrés (1,2 puis 1,8 kHz). Jauge sonifiée : un sinus à 220 Hz + risque × 6 Hz suit
  l'aiguille (le dépassement s'entend), rimshot warn au-dessus de 60, accord crit sur « 68 % ».
- **VO.** « Le retard est écrit en base : rien ne se perd. L'optimisation relance l'analyse :
  soixante-huit pour cent de risque de rupture. »
- **Faits illustrés.** L'événement de domaine est durable. Le worker relance l'analyse de risque
  et les recommandations de l'entreprise. **68 % est un exemple** (CONCEPT.fr.md § 1) : l'image ne
  montre aucun lien causal direct du genre « produits à bord → 68 % ».

### S07 · Refrain : la boucle (2) — 58-70 s (M30-35), sombre

- **Image.** Le bras passe à 6 h, puis poussée sur RECOMMANDATION. La carte s'agrandit à
  900×440 (rayon 14, ombre lg).
  - En-tête : pilule « ORDER_NOW ».
  - Ligne héros : « 3 000 UNITÉS » en Plex Condensed 170 px, puis « FOURNISSEUR C » + DÉMO +
    EXEMPLE.
  - Trois lignes RAISONS · COÛT · HYPOTHÈSES, dont les valeurs sont des **barres squelettes**
    (aucun chiffre inventé).
  - Au-dessus de la carte, trois notes crit tremblent en grappe, puis se résolvent en accord
    vertical ok.
  - Bras à 9 h : grand bouton HoldButton « ACCEPTER ET EXÉCUTER » (560×120, `#f2f2f2`, texte
    `#111213`) et un curseur.
  - Après le clic, une carte-document « PO-2026-0418 · BROUILLON » + DÉMO sort du bouton et suit
    l'anneau jusqu'à 12 h, où la station affiche désormais « SUIVRE · SUIVI » avec un point live
    qui bat.
- **Mouvement.** Sur « C », la grappe s'ordonne en accord (FLIP, 12 images) et passe de crit à ok.
  Les lignes de la carte arrivent une par temps. Le curseur glisse, le bouton se remplit sur un
  temps, et **le clic tombe pile à 64,0 s (image 1920)** : enfoncement 0,96, onde de choc (rayon
  0 → 700 px), coup de zoom 1 → 1,03 → 1.
- **Son.** Grappe ré-mi♭-mi tenue sous la voix, qui glisse en ré-fa-la (portamento de 120 ms),
  puis cloche ok. Trois pincements pour les lignes. **Le clic de 64,0 s est le kick d'encre**, le
  coup le plus fort du film, avec descente de sub, clap, et le pad qui s'ouvre en ré majeur
  pendant une mesure. Le
  document fait un whoosh de papier ; le point live, des ticks de charleston.
- **VO.** « Recommandation : trois mille unités chez le fournisseur C, raisons à l'appui. Un humain
  accepte, et un vrai bon de commande naît, en brouillon. » La fin de « accepte » est calée sur
  64,0 s.
- **Faits illustrés.** Accepter une recommandation ORDER_NOW crée un vrai bon de commande **en
  brouillon**. **Pas de marqueur « ai »** : le lien n'est pas écrit sur la commande (défaut connu
  de `executeOrder`).

### S08 · Drop — 70-74 s (M36-37), sombre, sans voix

- **Image.** Mots plein cadre en Plex Condensed 220 px (RotatingText), un par temps :
  - « OBSERVER » avec un point crit (le retard observé) ;
  - « RECALCULER » avec un point warn (le risque) ;
  - « RECOMMANDER » avec un point ok ;
  - « ACCEPTER » avec un carré d'encre ;
  - « EXÉCUTER » avec un point live.
  Derrière, l'anneau à 30 % tourne en continu (un tour par mesure) et ses cellules s'allument de
  la couleur du mot.
- **Son.** Drop instrumental : filtre de l'arpège grand ouvert, batterie pleine, sauts d'octave à
  la basse. Chaque mot déclenche son son de couleur. Whoosh vers le couplet 2.
- **Transition.** Balayage vers le clair sur les images 105-120.

### S09 · Les instruments : la route — 74-84 s (M38-42), clair, COUPLET 2

- **Image.** Un couloir stylisé (terre `#dcdee1`, route d'encre de 3 px) avec le libellé « ACCRA →
  KUMASI ». Un camion-conteneur y roule.
  - Carte-instrument : « BALISE GPS GT06 · DÈS 15 € », avec une petite puce « RÉSEAU LOCAL
    ACTIVÉ » (Mono 24 px).
  - Chaque position arrive par un fil pointillé et se pose en point live de 8 px.
  - Colonne « CONTRÔLES » : coordonnées valides · pas de (0, 0) · pas dans le futur · vitesse
    < 250 km/h.
  - Une position part vers un îlot « (0, 0) » et reçoit le barré crit « REJETÉ ».
  - Dernière mesure : le camion entre dans une zone hachurée « ZONE SANS RÉSEAU ». Les positions
    s'arrêtent, et un anneau d'encre creux continue sur une ligne pointillée « SIGNAL MUET →
    POSITION ESTIMÉE ».
- **Son.** Groove allégé : kick, rim sur 2 et 4, basse. Chaque position = un tick de charleston
  (le flux GPS devient un rythme). Rejet = coup sourd + accord crit à 30 %. En zone morte, les
  ticks deviennent fantômes (-12 dB, filtrés) : le GPS se tait, le rythme continue.
- **VO.** « Voyons les instruments. Les camions : une balise GPS dès quinze euros. Positions
  vérifiées, et sans signal, SCIP estime où ils sont. » (débit 0 %)
- **Faits illustrés.** GT06/Concox à 15-50 € (TRACKING.fr.md § 3) ; contrôles réels dans
  `devices.service.ts` ; position estimée par `dead-reckoning.ts`. **Le téléphone du chauffeur
  n'est pas montré** : sa position GPS demande HTTPS sur le réseau local, pas encore disponible
  dans la version Windows.

### S10 · La mer et l'air — 84-94 s (M43-47), clair

- **Image.** Recul vers un fond de carte monde (projection Equal Earth, terre `#dcdee1`).
  - Baltique : 12 chevrons de navires sur des couloirs (Helsinki-Tallinn, Stockholm-Turku,
    Gdańsk-Karlskrona), chacun émettant des ondes AIS. Radar (ogl) en encre à faible opacité.
  - Puce « NAVIRES · AIS · MER BALTIQUE · DIGITRAFFIC · SANS CLÉ », et plus bas, plus pâle :
    « MONDE ENTIER (CÔTES) : AISSTREAM · CLÉ GRATUITE ».
  - Puis un **cadre de vue** (rectangle d'encre avec des coins, comme une fenêtre de carte) se
    déplace sur le monde : les avions (chevrons de 8 px, courtes traînées) apparaissent **à
    l'intérieur du cadre**. Puce « AVIONS · OPENSKY / ADSB.LOL · SANS CLÉ ».
- **Son.** Navires = pings sonar (1,2 kHz, 400 ms, 3 échos) sur les noires. Avions = courts
  pépiements (1 → 2 kHz, 80 ms) en rafales, panoramiqués selon la longitude. Kick et basse
  continuent, le pad s'éclaircit.
- **VO.** « Les navires, par leur signal AIS : la Baltique en direct, sans clé. Et les avions,
  partout où vous regardez. »
- **Faits illustrés.** Baltique sans clé = couche de carte en direct ; monde avec une clé
  AISStream gratuite, côtes seulement. Les avions sont chargés pour la vue affichée, d'où le cadre.

### S11 · La table de mixage — 94-104 s (M48-52), sombre, CONSOLE

- **Image.** Une console plein cadre : 10 tranches + MASTER (150×760 px chacune, `#1b1c1e`,
  rayon 10). Chaque tranche a une icône, un VU-mètre de 16 segments, un curseur, un bouton « M »,
  un champ « CLÉ : — » et un nom/source.
  - Tranches : NAVIRES/DIGITRAFFIC, AVIONS/OPENSKY, SÉISMES/USGS, CYCLONES/NOAA·GDACS,
    INONDATIONS/GDACS, FEUX/EONET·GDACS, MÉTÉO/OPEN-METEO, CAMÉRAS/PUBLIQUES, RADIO/RADIO BROWSER,
    SATELLITES/CELESTRAK. NAVIRES et AVIONS sont déjà montées.
  - Chaque source nommée par la voix se dé-mute sur son mot : le curseur monte à 70 %, et le VU
    suit l'enveloppe de la musique, avec les 2 segments du haut à la couleur de l'événement.
  - Sur « aucune », les champs « CLÉ : — » clignotent en cascade.
  - Tampon « 0 CLÉ D'API » (Plex Condensed 300 px) sur le premier temps qui suit le mot « clé ».
- **Son.** Un rythme construit en direct, une couche par tranche : séismes = boom sub, cyclones =
  souffle, inondations = tom grave, feux = crépitements, météo = shaker, caméras = déclencheur,
  radio = accord filtré AM, satellites = bips en triolets. Sur « aucune », tout se coupe pendant
  un temps, puis coup de toute la formation + crash avec le tampon.
- **VO.** « Et autour : séismes, cyclones, inondations, feux, météo, caméras, radio, satellites.
  Aucune clé d'API. » (débit 0 %)
- **Fait illustré.** Tous ces flux sont sans clé (docs/INTEL.md, ROADMAP-presentation.md). La
  seule couche à clé, le trafic routier TomTom, n'est pas montrée.

### S12 · Prévoir : la bataille des modèles — 104-114 s (M53-57), clair, COUPLET 3

- **Image.**
  - En haut : une série de demande (ligne d'encre avec ondulations hebdomadaires et houle
    annuelle), et la validation glissante dessinée dessus (zone « ENTRAÎNEMENT » qui grandit,
    fenêtre « TEST » qui avance).
  - En bas : six VU-mètres horizontaux NAIVE, SEASONAL_NAIVE, MOVING_AVERAGE,
    EXPONENTIAL_SMOOTHING, HOLT_WINTERS, GRADIENT_BOOSTING, avec leur WAPE (Counter).
  - Puce « OPTIMISER · PRÉVISION · VALIDATION GLISSANTE » + DÉMO. Mot fantôme « WAPE ».
  - Classement final, issu de CONCEPT.fr.md : HOLT_WINTERS 24,13 (✓ « SÉLECTIONNÉ »),
    GRADIENT_BOOSTING 24,72, SEASONAL_NAIVE 25,74, MOVING_AVERAGE 27,07,
    EXPONENTIAL_SMOOTHING 28,11, NAIVE 29,38.
- **Mouvement.** Quatre pas de validation, un par mesure. Sur « le plus précis gagne », les
  lignes se reclassent (FLIP, 18 images) et le gagnant clignote ok. Sur « pas le plus compliqué »,
  GRADIENT_BOOSTING s'atténue.
- **Son.** Arpège à six voix : chaque modèle est une note de ré mineur, plus forte s'il est plus
  précis. Glissando descendant au reclassement. La note du gagnant est tenue.
- **VO.** « Pour prévoir la demande, six modèles s'affrontent sur l'historique. Le plus précis
  gagne, pas le plus compliqué. »

### S13 · Répartir : le clavier des fournisseurs — 114-124 s (M58-62), clair

- **Image.**
  - Cinq touches hautes (180×520 px), une par fournisseur SUP-A … SUP-E.
  - Consigne : « 20 000 UNITÉS · 7 JOURS · PART MAX 50 % » + DÉMO.
  - Puce « MILP · OR-TOOLS CBC » avec un chronomètre qui se pose sur « < 10 ms ».
  - La touche SUP-B porte « MOINS CHER · 12 J · 75 % À L'HEURE ».
  - Le solveur joue un accord : les touches choisies s'enfoncent et se remplissent d'encre, et des
    barres de quantité (sans chiffres) montent sous un plafond pointillé « PLAFOND 50 % ».
  - SUP-B reçoit un barré crit et « ÉCARTÉ ».
- **Son.** Accord de piano FM arpégé sur les touches choisies. Ticks rapides pour le chronomètre.
  La touche écartée est une note morte (coup sourd sans hauteur).
- **VO.** « Pour répartir une commande, un solveur exact tranche en quelques millisecondes, quitte
  à écarter le moins cher : trop lent, pas assez fiable. »
- **Faits illustrés.** README, « Verify it yourself » : 20 000 unités, 7 jours, plafond de 50 %,
  résolution en quelques millisecondes, le moins cher souvent écarté. Seed : SUP-B, indice de
  prix 0,8, 12 jours, 75 % à l'heure. L'échéance est une pénalité de coût dans le solveur, pas une
  limite stricte, d'où « trop lent, pas assez fiable » plutôt que « hors délai ».

### S14 · Pont : chaque chiffre s'explique — 124-136 s (M63-68), sombre, PONT (demi-tempo)

- **Image.**
  - Première moitié : la carte de S07 revient en petit à gauche et éclate en trois cordes
    horizontales (Threads) nommées « résumé », « raisons », « hypothèses », chacune pincée sur son
    mot. À droite, un panneau de code stylisé (TextType, Plex Mono 30 px) :
    `@dataclass` / `class Recommendation:` / `    reasons: list[str]   # obligatoire` /
    `def test_…(): assert rec.reasons   # vérifié`.
  - Seconde moitié : écran coupé. À gauche « RÉEL », une piste droite avec un point live. À
    droite « DÉMO », la même piste en violet `#a993ec`, avec « isSimulated = true » et la pastille
    DÉMO. Au milieu, le libellé vertical « JAMAIS DÉGUISÉES ».
- **Son.** Demi-tempo : kick sur 1, caisse claire sur 3, pas de charleston. Trois pincements de
  cloche (le son ok) pour les cordes, clics de frappe pour le code. Le pad « démo » (vibrato 5 Hz
  ±15 cents) joue **seulement** pendant que le violet est à l'écran ; la piste violette ondule à
  5 Hz, c'est le jumeau visuel du vibrato.
- **VO.** « Chaque calcul s'explique : pas de recommandation sans raisons, le code l'exige et les
  tests le vérifient. Et les données de démo jouent en violet : jamais déguisées en vraies. »
- **Faits illustrés.** `reasons` est un champ obligatoire, et les tests vérifient qu'il n'est
  jamais vide. On ne dit pas « impossible » : une liste vide passerait. Données de démo marquées
  en violet et jamais présentées comme réelles ; on ne dit pas « jamais mélangées ».

### S15 · Un seul fichier — 136-148 s (M69-74), clair, COUPLET 4

- **Image.**
  - Une icône de fichier (220×280, trait 3 px) « SCIP-Setup.exe », badge « 1 FICHIER ».
  - Elle éclate en une pile isométrique de 4 dalles aux angles du logo : « INTERFACE », « API »,
    « POSTGRESQL 16 + POSTGIS », « MOTEUR IA ». Les étapes s'allument en StatusMark.
  - Puces : « WINDOWS », « SANS DROITS ADMINISTRATEUR », « BASE INTÉGRÉE (RECOMMANDÉ) ».
  - Dernier tiers : un PC dans un cercle pointillé « 127.0.0.1 · PAR DÉFAUT ». Dehors, des ondes
    Wi-Fi atténuées et un interrupteur « RÉSEAU LOCAL : DÉSACTIVÉ », avec la légende
    « optionnel · Réglages ».
- **Son.** Retour du 4/4. Les dalles montent en arpège ré-fa-la-ré. Pops sur les puces, clic sec
  pour l'interrupteur, et un cadenas fermé (charleston fermé réverbéré).
- **VO.** « Et tout ça ? Un logiciel Windows, un seul fichier, installé sans droits
  administrateur. Base de données intégrée, et par défaut, l'API n'écoute que ce PC. »
- **Faits illustrés.** docs/installer.md (un seul fichier, installation par utilisateur) ;
  PostgreSQL 16 + PostGIS embarqués ; `services.rs` (127.0.0.1 sauf si le réseau local est
  activé).

### S16 · Hors ligne — 148-154 s (M75-77), clair

- **Image.** Le fond de carte monde avec ses détails embarqués : côtes et frontières, fleuves et
  lacs, points de villes.
  - Par-dessus, une grille de tuiles carrées pâles « en ligne ».
  - En haut à droite, un pictogramme Wi-Fi barré crit « HORS LIGNE ».
  - Les tuiles tombent en vague diagonale ; la carte dessous ne bouge pas.
  - Légende « FOND DE CARTE EMBARQUÉ · NATURAL EARTH ».
- **Son.** Chaque couche rythmique disparaît pendant que les tuiles tombent (chaque tuile, un
  micro-clic descendant). Restent le pad et la basse : la carte continue de jouer. Riser vers la
  reprise.
- **VO.** « Même sans internet, la carte du monde reste lisible. »
- **Fait illustré.** Seule la carte reste lisible hors ligne. Les couches en direct (navires,
  avions, catastrophes) ne sont pas montrées dans cette scène.

### S17 · Reprise — 154-164 s (M78-82), sombre, REPRISE

- **Image.** L'anneau revient plein cadre, en double tempo. De nouvelles expéditions de démo
  (SHP-0217, SHP-0309, SHP-0388, point DÉMO) passent de station en station, chacune s'allumant à
  son arrivée (un vrai événement par couleur). Lignes cinétiques en Plex Condensed 200 px :
  « LE SUIVI ENTEND. » → « L'OPTIMISATION PROPOSE. » → « VOUS DÉCIDEZ. ». Sur « vous décidez », le
  bouton HoldButton arrive au centre et reçoit le clic **pile à 162,0 s (image 4860)**, avec la
  chorégraphie de S07.
- **Son.** Refrain final : toute la formation, arpège une octave plus haut, crash. Les sons de
  couleur tombent avec les arrivées aux stations. Clic à 162,0 s = kick d'encre + sub. Sur le
  dernier temps, tout se retire sauf le pad.
- **VO.** « Le suivi entend la fausse note. L'optimisation propose la réponse. Et c'est vous qui
  décidez. »

### S18 · Coda — 164-170 s (M83-85), sombre, CODA

- **Image.** Il ne reste que le point, comme en S01. Le logo se construit autour : l'hexagone se
  trace (3 px `#f2f2f2`, 240 px), puis l'anneau, puis le point. Quatre ondes partent du point :
  crit, warn, ok, puis `#f2f2f2`, pour montrer que chaque signal se résout en encre. Dessous :
  - « SCIP » en Plex Condensed SemiBold 160 px ;
  - « SUPPLY CHAIN INTELLIGENCE PLATFORM » en Mono 24 px (+0,2 em) ;
  - le slogan en Plex Sans 44 px : « Entendre le retard. Jouer la réponse. »
  HUD : « MESURE 085/085 · FIN ».
- **Son.** La résolution : gonflement de ré majeur add9 (pad + cloche). Le mi♭ du motif descend
  enfin sur ré, le fa monte à fa♯. Kick d'encre doux sur l'apparition du point. Un dernier clic de
  métronome sur le dernier premier temps (rappel de S01), puis 2 s de réverbération jusqu'au
  silence.
- **VO.** « SCIP. Entendre le retard, jouer la réponse. »

## 5. Audio

### 5.1 Musique

- **Synthèse procédurale en Python** (numpy/scipy), 48 kHz, stéréo, flottant, PRNG à graine.
- **Structure** : celle du § 4, exprimée en mesures dans `timeline.json`.
- **Instruments** :

| Instrument | Synthèse |
|---|---|
| kick | sinus 150 → 48 Hz en 180 ms + clic |
| clap | 3 bursts de bruit décalés, passe-bande 1,2 kHz |
| charlestons | bruit blanc passe-haut 7 kHz ; 25 ms fermés, 120 ms ouverts |
| caisse claire, rim, toms | bruit + sinus accordés |
| basse | scie + sub sinus, passe-bas 380 Hz, sidechain sur le kick |
| pad | 3 scies désaccordées ±8 cents, passe-bas 1,4 kHz, attaque 0,8 s, relâche 1,5 s |
| arpège | carré en doubles croches, balayage de filtre 600 Hz → 4 kHz |
| pincements | Karplus-Strong |
| piano | FM à 2 opérateurs, rapport 1:1 |
| riser | bruit en passe-bande 300 Hz → 8 kHz + scie qui monte d'une octave |
| impact | sinus 90 → 28 Hz sur 900 ms + bruit |

- **Effets** : réverbération FDN, saturation douce, largeur stéréo **uniquement** sur le pad et
  l'arpège. Kick, basse et voix restent au centre.

### 5.2 Motif harmonique

- La seconde mineure ré/mi♭ marque le retard (S01, S05, S06).
- La grappe ré-mi♭-mi se résout en ré-fa-la sur le mot « C » (la recommandation tombe).
- Le clic de 64,0 s ouvre le pad en ré majeur (ré-fa♯-la) pendant une mesure, puis le refrain
  reprend en ré mineur. Le clic de 162,0 s fait de même.
- Résolution finale en ré majeur add9 en S18.
- Progressions : intro sur ré mineur seul ; couplets et refrains en Dm | B♭ | F | C ;
  pré-refrain en Gm | B♭ | C | A ; pont en B♭ | Gm | Dm | A ; hors ligne en Dm | B♭ ; coda en
  D add9.

### 5.3 Kit couleur (1 couleur = 1 son, jamais réutilisé ailleurs)

| Couleur | Son |
|---|---|
| crit | Accord du retard : scies ré3 + mi♭3 + ré4, 180-600 ms, légère réduction de résolution |
| warn | Rimshot en triton (ré + sol♯), 90 ms |
| ok | Cloche : partiels 1 / 2,76 / 5,40, décroissance 1,2 s, tierce majeure |
| live | Tick de charleston fermé, 4 kHz, 10 ms |
| info | Pincement sinus 880 Hz, 150 ms ; pour les navires, sonar 1,2 kHz à 3 échos |
| démo (violet) | Blip désaccordé avec vibrato (chorus) |
| encre | Kick + descente de sub, **réservé aux décisions humaines** (clics, apparition du point du logo) |

**Bruitages UI** (synthétisés, calés sur la double croche sauf le retard de S01) : pop
(700 → 1100 Hz, 40 ms, un par double croche au maximum), whoosh du balayage, frappe Mono, ticks de
compteur (16 par seconde au maximum), retournement de carte, souffle du curseur, clic sec,
interrupteur, cadenas, papier, chute de tuiles, pépiements d'avion, coup sourd de rejet.

### 5.4 Voix off

- edge-tts ≥ 7.2, voix `fr-FR-RemyMultilingualNeural`, débit de base -4 %, événements
  `WordBoundary` demandés explicitement (unité de 100 ns, convertie en images).
- **Un clip par scène**, ancré au début de la scène avec un décalage en doubles croches.
- **Prononciation** : dans le texte parlé, « SCIP » devient « Skip ». « AIS » est épelé
  (« A. I. S. »). « API » est laissé tel quel. Les deux sont confirmés à l'écoute à la porte A.
  Une table fait correspondre les mots parlés aux mots affichés, pour que les timings pilotent
  les bons mots à l'écran.
- **Ajustement** : si un clip déborde de sa scène, on accélère le débit de 8 % au plus, sinon on
  **coupe des mots**. La grille ne bouge jamais. Le débit est réglé par scène dans
  `timeline.json`.
- **Cues pilotés par les mots** : les événements liés à un mot (tampons, dé-mutes, aiguille) se
  placent sur le mot, quantifiés à la double croche ou au temps. Seuls les deux clics (64,0 s et
  162,0 s) sont des heures fixes, et c'est la voix qui s'y cale.
- **Synchro critique** : la fin de « accepte » (S07) tombe sur 64,0 s. Mesuré : 5,99 s après le
  début du clip, donc un clip ancré à 58,0 s sans décalage tombe juste.
- **Durées mesurées** (Rémy, 29/09/2026), durée du clip / durée de la scène :

| S02 | S03 | S04 | S05 | S06 | S07 | S09* | S10 | S11* | S12 | S13 | S14 | S15 | S16 | S17 | S18 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 8,1/10 | 6,6/8 | 8,7/12 | 10,8/12 | 8,1/10 | 8,6/12 | ≈8,8/10 | 8,7/10 | ≈8,8/10 | 6,7/10 | 7,7/10 | 9,7/12 | 10,6/12 | 3,6/6 | 6,4/10 | 3,7/6 |

  *S09 et S11 : 9,1 s à -4 % ; estimation à débit 0 %, à re-mesurer par `vo.py`.
  S05 (marge 1,25 s) démarre sans décalage.
- Les MP3 de voix sont commités pour que le rendu reste reproductible sans réseau.

### 5.5 Mixage et master

- **Ducking** de la musique à -9 dB, piloté par les timings des mots (attaque 60 ms, relâche
  300 ms).
- **Master** : -16 LUFS intégré (±0,5), crête vraie ≤ -1 dBTP (limiteur), mesuré avec pyloudnorm.
- **Compatibilité mono** : la somme L+R ne perd pas plus de 3 dB sur les éléments clés.
- **Sortie** : un seul `public/audio/master.wav`, 48 kHz, lu par un `<Audio>` Remotion. Les MP3
  sont décodés par le ffmpeg fourni avec Remotion (`npx remotion ffmpeg`).

## 6. Architecture

```
media/promo-video/
  package.json            remotion 4.0.x, @remotion/cli, react, d3-geo, ogl,
                          @fontsource/ibm-plex-sans(-condensed, -mono), vitest
  requirements.txt        edge-tts, numpy, scipy, pyloudnorm, pytest (versions figées)
  remotion.config.ts · tsconfig.json · README.md
  timeline/timeline.json  SOURCE UNIQUE : bpm, fps, totalBars, scènes [{id, titre, mesureDébut,
                          nbMesures, thème, section, vo: {écran, parlé, décalageDoublesCroches}}],
                          cues [{scène, mesure, temps, doubleCroche, type, couleur}]
  scripts/
    vo.py                 edge-tts par scène → public/audio/vo/Sxx.mp3 + generated/vo-timings.json
    music/                dsp.py · instruments.py · kit.py · sfx.py · score.py · mix.py
                          → public/audio/stems/*.wav + public/audio/master.wav
    geo.mjs               Natural Earth v5.1.2 (source épinglée, même source que le logiciel),
                          cache .geo-cache/ → generated/geo.json (chemins SVG projetés)
    lint-timeline.mjs     grille, débordements de voix, chevauchements, cues hors scène
    check-determinism.mjs rend des images échantillons deux fois, dans un ordre différent, et
                          compare les hash
  src/
    index.ts · Root.tsx · Video.tsx   1 <Sequence> par scène, 1 <Audio> master
    lib/      beat.ts (useBeat) · words.ts (useWord) · prng.ts · easing.ts · timeline.ts
    theme/    tokens.ts · fonts.ts
    components/  Pin · Logo · ContainerGlyph · Playhead · Hud · Chip · DemoPill · ExamplePill ·
                 Card · Button · Staff · LoopSequencer · Gauge · Oscilloscope · Console ·
                 VuLane · Keys · WorldMap · IsoStack
    rb/       composants React Bits adaptés (§ 3.7)
    scenes/   S01Contretemps.tsx … S18Coda.tsx
  generated/  vo-timings.json · geo.json          (commités)
  public/audio/vo/*.mp3                           (commités)
  public/audio/stems/, public/audio/master.wav, out/, .geo-cache/, node_modules/, .venv/
                                                  (non commités)
```

### 6.1 Flux de données

```
timeline.json ─┬─► vo.py ──► vo-timings.json ─┬─► mix.py (ducking)
               │                              └─► src/lib/words.ts (texte cinétique)
               ├─► score.py ─► stems ─► mix.py (+ voix) ─► master.wav ─┐
               └─► src/ (séquences, cues) ─────────────────────────────┴─► out/scip-le-signal.mp4
```

`timeline.json` est en JSON parce que Python et TypeScript le lisent tous les deux sans build.
La synchro entre l'image et le son vient de ce fichier commun, jamais d'un réglage fait à la main.

### 6.2 Commandes (README)

- `npm run vo` : voix + timings (réseau nécessaire, sinon le cache est réutilisé).
- `npm run music` : stems + master.
- `npm run geo` : fond de carte.
- `npm run lint` : lint de la timeline + typecheck.
- `npm test` : vitest + pytest.
- `npm run studio` : aperçu Remotion.
- `npm run stills` : planche d'images clés.
- `npm run render:draft` : 720p.
- `npm run render` : 1080p final.
- `npm run check` : déterminisme + loudness + mono.

### 6.3 Gestion des erreurs

- Pas de réseau pour `vo.py` : les MP3 en cache sont réutilisés ; échec explicite s'il en manque.
- Police non chargée : `delayRender` expire et le rendu échoue, au lieu de sortir une typo
  décalée.
- Voix trop longue pour sa scène, ou cue hors de la grille : `lint-timeline` échoue avant le
  rendu.
- Audio trop long ou trop court par rapport à la timeline : `mix.py` échoue (durée exacte attendue
  = 85 mesures).

## 7. Validation

### 7.1 Tests automatiques

- **vitest** sur `src/lib/` : conversion mesure/temps/double croche ↔ image, mot ↔ image
  (quantification), PRNG déterministe, format des nombres en français.
- **pytest** sur l'audio : durée exacte (170 s × 48 000 échantillons), aucun échantillon au-delà
  de la crête autorisée, loudness de -16 LUFS ±0,5, perte mono ≤ 3 dB, et motif du retard présent
  à 4,233 s (pic d'énergie à la bonne image).
- **Déterminisme** : au moins 12 images réparties sur le film (dont 127, 1920 et 4860), rendues
  deux fois dans un ordre différent ; hash identiques.
- **Lint timeline** : toutes les coupes sur un multiple de 15 images (sauf le retard de S01),
  toutes les voix contenues dans leur scène, les clics de 64,0 s et 162,0 s à l'image exacte.

### 7.2 Portes de validation avec l'auteur

| Porte | Livré | Critère |
|---|---|---|
| A · Son | Prototype audio M1-35 (S01 → S07) avec la voix | La musique sonne « produite », le contretemps s'entend, le mix est lisible |
| B · Images clés | Planche de 6 images : S01 pic en retard, S05 FAUSSE NOTE, S06 jauge 68 %, S07 clic, S11 console, S18 logo | Charte, lisibilité, test projecteur si possible |
| C · Brouillon | Film complet en 720p | Rythme, synchro voix, texte et son, enchaînements |
| D · Final | MP4 1080p + rapport de contrôle (§ 7.1 et § 8) | Tout au vert |

## 8. Checklist des faits (à cocher avant la porte D)

| Affirmation à l'écran ou dans la voix | Source |
|---|---|
| Du portail du fournisseur au quai du client ; quoi, chez qui, quand, par quelle route | README.md, CONCEPT.fr.md |
| La plupart des outils répondent à une seule des deux questions | CONCEPT.fr.md (positionnement de l'auteur) |
| EN RETARD seulement si même la borne optimiste dépasse la promesse | `eta-engine.ts` `assessLateness` |
| Le retard est un événement de domaine durable (`shipment.delayed`) | `shipments.service.ts`, `domain-events.service.ts` |
| L'optimisation relance l'analyse de risque ; **68 % = EXEMPLE** | `domain-event.worker.ts`, CONCEPT.fr.md § 1 |
| ORDER_NOW, 3 000 unités chez le fournisseur C = **EXEMPLE** | CONCEPT.fr.md § 1, README |
| Accepter crée un vrai bon de commande **en brouillon** ; **pas de marqueur « ai »** | `recommendations.service.ts` `executeOrder` |
| Balise GT06 dès 15 € ; **pas de GPS téléphone** dans la version Windows | TRACKING.fr.md § 3, DEPLOYMENT.md |
| Positions contrôlées, (0, 0) rejeté | `devices.service.ts` `rejectionReason` |
| Position estimée quand le signal se tait | `dead-reckoning.ts` |
| Baltique en direct sans clé ; monde (côtes) avec une clé AISStream gratuite | `digitraffic-feed.ts`, ROADMAP |
| Avions sans clé, chargés pour la vue affichée | module aircraft, ROADMAP |
| Séismes, cyclones, inondations, feux, météo, caméras, radio, satellites sans clé | docs/INTEL.md, ROADMAP |
| Six modèles, validation glissante, WAPE (24,13 … 29,38), le plus simple gagne en cas d'égalité | `forecasting.py`, CONCEPT.fr.md § 3.1 |
| MILP OR-Tools CBC en quelques ms ; SUP-B moins cher, 12 j, 75 % à l'heure, écarté | `allocation.py`, README, `seed.ts` |
| Raisons **exigées par le code et vérifiées par les tests** | `recommendations.py`, tests |
| Démo en violet, **jamais déguisée en réel** (on ne dit pas « jamais mélangée ») | `ui.tsx`, globals.css `--color-sim` |
| Logiciel Windows, un seul fichier, sans droits administrateur | ADR 0001, docs/installer.md, `context.rs` |
| PostgreSQL 16 + PostGIS intégrés, API sur 127.0.0.1 par défaut, réseau local en option | `stage-postgres.mjs`, `services.rs` |
| Fond de carte Natural Earth embarqué ; seule la carte reste lisible hors ligne | docs/desktop-architecture.md, ROADMAP P0 #3 |
| Tous les identifiants fictifs portent DÉMO | Relecture des 18 scènes |

Les fichiers cités sont ceux de la version livrée (branche `claude/desktop-exe-evolution-e612fc`).

## 9. Corrections appliquées au concept d'origine

- Libellés en français (SUIVRE / OPTIMISER / DÉCIDER), plus de TRACK / OPTIMIZE à l'écran.
- S06 : plus de SKU qui tombent du camion dans la jauge (lien causal non démontré) ; 68 % marqué
  EXEMPLE.
- S07 : plus de marqueur « ai » sur le bon de commande ; « en brouillon ».
- S09 : le téléphone du chauffeur est retiré, la balise GT06 et la puce « RÉSEAU LOCAL ACTIVÉ »
  sont ajoutées ; « SCIP écoute tout ce qui bouge » devient « Voyons les instruments » (et annonce
  la seconde moitié).
- S10 : « sur toute la planète » devient « partout où vous regardez », avec un cadre de vue.
- S13 : « s'il arrive trop tard » devient « trop lent, pas assez fiable ».
- S14 : « imposé dans le code » devient « le code l'exige et les tests le vérifient » ; « jamais
  mélangés » devient « jamais déguisées ».
- Couleurs : les pastilles du HUD s'allument uniquement sur événement, sans motif décoratif.
- Texte minimal passé de 20 à 24 px.

## 10. Hors périmètre

Sous-titres (SRT ou incrustés), version anglaise, format vertical pour les réseaux sociaux, vraies
captures d'écran. Tous restent possibles plus tard : la voix est déjà découpée par scène avec ses
timings.

## 11. Risques

| Risque | Parade |
|---|---|
| Musique procédurale qui sonne « maigre » | Porte A dès les 35 premières mesures ; réverbération FDN, saturation, largeur stéréo, sidechain |
| Salle au son faible ou mono | Jumeau visuel pour chaque son ; test mono ; le hook se lit aussi sans le son (« +2 J », la légende) |
| Composants React Bits non déterministes | Contrat d'adaptation (§ 3.7) + test de déterminisme |
| Voix plus longue que la grille | Un clip par scène, ajustement du débit ≤ 8 %, puis coupe de mots ; lint bloquant |
| Gris clairs délavés au projecteur | Porte B ; filets à `#c9ccd0` en repli |
| Node 25 et Remotion | Vérifié au premier rendu ; repli sur Node 22 LTS via `npx` si besoin |
| Nombre de pièces sur mesure (console, clavier, séquenceur…) | Composants partagés (`Card`, `Chip`, `VuLane`), une scène par fichier, portes B et C pour arbitrer tôt |
