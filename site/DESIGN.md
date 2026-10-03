---
version: alpha
name: scip-site-design-analysis
description: >
  Site vitrine de SCIP (Supply Chain Intelligence Platform), logiciel Windows
  tout-en-un. Le site porte l'identité du logiciel (charte v1.0, source unique
  apps/web/src/app/globals.css) : gris neutre clair, l'encre #141516 porte la
  seule action, la couleur n'apparaît que sur les événements, le violet ne dit
  que « démo ». Polices du logiciel : IBM Plex Sans, IBM Plex Sans Condensed
  (titres et mots géants, 600-700), IBM Plex Mono. Élément signature : de
  vraies captures de SCIP 0.2.1, encadrées en fenêtres inclinées, posées
  devant un mot géant gris sur gris.
colors:
  accent: "#141516"          # l'encre = LA couleur d'action
  on-accent: "#ffffff"
  canvas: "#e3e4e6"
  surface: "#f1f2f3"
  surface-2: "#ffffff"
  hairline: "#d6d8db"
  ink: "#141516"
  muted: "#5c6166"
  dim: "#747a80"             # deuxième voix des titres
  map: "#dcdee1"
  crit: "#c8412f"            # événement : retard
  warn: "#a8740f"            # événement : avertissement (SmartScreen)
  ok: "#3f8a5c"
  live: "#2f8a55"            # événement : « sans clé », en direct
  info: "#3b6fb0"            # focus clavier, sélection
  sim: "#6e56c9"             # UNIQUEMENT démo / simulé
  dark-canvas: "#121314"     # thème sombre du logiciel (section du film)
typography:
  giant: { fontFamily: "IBM Plex Sans Condensed", fontSize: "25–37vw", fontWeight: 700, lineHeight: 0.82, letterSpacing: -0.02em, color: "rgba(20,21,22,.065)" }
  cover: { fontFamily: "IBM Plex Sans Condensed", fontSize: "clamp(110px, 27vw, 430px)", fontWeight: 700, lineHeight: 0.8 }
  hero: { fontFamily: "IBM Plex Sans Condensed", fontSize: "clamp(42px, 5.6vw, 92px)", fontWeight: 700, lineHeight: 0.95 }
  section: { fontFamily: "IBM Plex Sans Condensed", fontSize: "clamp(30px, 3.9vw, 62px)", fontWeight: 700, lineHeight: 0.98 }
  card: { fontFamily: "IBM Plex Sans Condensed", fontSize: "clamp(20px, 1.7vw, 27px)", fontWeight: 600 }
  kpi: { fontFamily: "IBM Plex Sans Condensed", fontSize: "clamp(40px, 4.2vw, 72px)", fontWeight: 500, fontVariantNumeric: tabular-nums }
  body: { fontFamily: "IBM Plex Sans", fontSize: "clamp(15px, .95vw, 17px)", lineHeight: 1.55, maxWidth: 45ch }
  label: { fontFamily: "IBM Plex Mono", fontSize: "11–12px", fontWeight: 500, letterSpacing: 0.14em, textTransform: uppercase }
rounded: { xs: 4px, sm: 6px, card: 10px, panel: 14px, pill: 9999px }
spacing: { section: "clamp(64px, 8vw, 120px)", gutter: "clamp(20px, 4vw, 56px)", gap: 12px }
shadows:
  sm: "0 1px 2px rgb(0 0 0 / 0.08)"
  md: "0 6px 18px rgb(0 0 0 / 0.14)"
  lg: "0 20px 48px rgb(0 0 0 / 0.24)"     # réservée aux fenêtres de capture
motion: { ease: "cubic-bezier(.22, 1, .36, 1)", reveal: "0.6s, translateY(18px), une seule fois", load: "0.7–0.9s, paliers de 0.1s" }
components:
  button-primary: { backgroundColor: "{colors.accent}", textColor: "{colors.on-accent}", rounded: "{rounded.pill}", height: 44px, padding: "0 22px", font: "IBM Plex Sans 600 14px" }
  button-primary-hover: { opacity: 0.86 }
  button-primary-active: { transform: "scale(0.97)" }
  button-outline: { backgroundColor: "{colors.surface-2}", textColor: "{colors.ink}", borderColor: "{colors.hairline}" }
  segmented: { backgroundColor: "{colors.surface-2}", borderColor: "{colors.hairline}", rounded: "{rounded.pill}", item-active: "{colors.accent}" }
  panel: { backgroundColor: "{colors.surface}", rounded: "{rounded.panel}", border: none, shadow: none }
  shot-window: { backgroundColor: "{colors.surface-2}", borderColor: "{colors.hairline}", rounded: "{rounded.panel}", boxShadow: "{shadows.lg}" }
  demo-tag: { textColor: "{colors.sim}", backgroundColor: "rgb(110 86 201 / .1)", border: "1px dashed {colors.sim}", rounded: "{rounded.pill}" }
  chip: { borderColor: "{colors.hairline}", rounded: "{rounded.pill}", font: "IBM Plex Mono 600 10.5px uppercase" }
  tab-pill: { backgroundColor: "{colors.surface-2}", borderColor: "{colors.hairline}", rounded: "{rounded.pill}", font: "IBM Plex Sans 500 12.5px" }
---

## Overview

Le site et le logiciel doivent se lire comme le même objet. Tout ce que le
site montre du produit est une capture réelle de SCIP 0.2.1 (jeu de démo), et
tout ce qu'il affirme se retrouve dans le dépôt ou dans une capture.
Caractéristiques clés : (1) barre de navigation calquée sur celle de l'app
(logo hexagone, mot-symbole en mono espacé, sélecteur segmenté en capitales,
pilule encre) ; (2) un mot géant par page, gris sur gris, en Plex Sans
Condensed 700 : SCIP · TRACK · OPTIMISE · RÉSEAU · SETUP ; (3) des fenêtres de
capture inclinées en perspective, seules à porter une ombre ; (4) panneaux
plats, pilules, chips et libellés mono repris de globals.css ; (5) encre =
seule action, couleur = événement, violet = démo ; (6) chiffres de démo dans
un encart à filet violet pointillé, jamais mêlés aux faits du projet ; (7) la
métaphore musicale reste dans la section du film « Le Signal ».
Modèles de composition (skill web-du-future-2) : [6] (gris produit, mot
fantôme, ombre large), [9] (héros copie / figure, process numéroté), [5]
(vidéo, cartes en éventail), pin [P-5917] (mot géant derrière le produit).

## Colors

- **Encre** ({colors.accent}) : titres, boutons, segment actif, cellule
  inversée d'une grille. La seule couleur d'action.
- **Canvas et surfaces** ({colors.canvas}, {colors.surface},
  {colors.surface-2}) : 90 % de la page, à plat.
- **Événements** : {colors.crit}, {colors.warn}, {colors.ok}, {colors.live},
  {colors.info}. Petites surfaces, toujours avec du texte.
- **{colors.sim}** : uniquement l'étiquette « données démo » et le filet des
  encarts de chiffres de démo.
- La deuxième voix d'un titre est {colors.dim}, jamais une couleur.
- Aucun dégradé, aucun aplat saturé. Le sombre ({colors.dark-canvas}) n'existe
  que comme thème sombre du logiciel, sur la section du film.

## Typography

IBM Plex Sans (texte, 400-600), IBM Plex Sans Condensed (titres 700, cartes
600, chiffres 500), IBM Plex Mono (libellés, mot-symbole, étiquettes). Ce
sont les polices du logiciel ; aucune autre famille.

| Token | Taille | Graisse | Usage |
|---|---|---|---|
| giant | 25–37vw (jusqu'à 58vw mobile) | 700 | mot géant de page, derrière la figure |
| cover | 27vw × 2 lignes | 700 | SCIP / SETUP (telecharger) |
| hero | clamp(42px, 5.6vw, 92px) | 700 | H1 |
| section | clamp(30px, 3.9vw, 62px) | 700 | H2, titres d'onglet |
| kpi | clamp(40px, 4.2vw, 72px) | 500 | chiffres, tabulaires |
| body | clamp(15px, .95vw, 17px) | 400 | ≤ 45ch, ≤ 4 lignes |
| label | 11–12px mono | 500 | eyebrows, légendes, métadonnées |

## Layout

Contenu max 1480px, gouttière {spacing.gutter}, sections {spacing.section}.
Héros : copie c1–c5, fenêtre c6–c12 qui affleure le bord droit. Têtes de
section : titre à gauche, paragraphe à droite. Blocs d'onglet : capture et
copie en alternance (1.28fr / .72fr). Grilles à 12px de gouttière.

## Elevation & Depth

Les surfaces sont plates, comme dans le logiciel. La profondeur est réservée
aux fenêtres de capture : {shadows.lg}, perspective (rotateY −7° ou rotateX
4–5°), suivi du curseur amorti (±2–4°), parallaxe au scroll (±10–18px). Le
flou d'arrière-plan n'existe que sur la barre de navigation.

## Shapes

Panneaux 14px, tuiles 10px, pilules pour boutons, segments, chips, onglets.
Les seules images sont les captures (WebP, 1600×1000 pour le logiciel,
1280×853 pour l'installeur) et l'affiche du film.

## Components

Voir le front-matter. Tous dérivent de globals.css : `.btn`, `.segmented`,
`.panel`, `.chip`, `.pill`, `.t-label`, `.kbd`.

### Signature Components

- **La fenêtre de capture** (`.shot` > `.shot-win` > `img`) : capture réelle,
  bord 1px, rayon 14px, ombre lg, légende mono « Pilier · Écran » +
  {components.demo-tag}.
- **Le mot géant de page** (`.ghost`) : gris sur gris, coupé par un bord,
  partiellement masqué par la fenêtre.
- **L'éventail** (optimisation) : trois fenêtres qui se chevauchent, tournées
  de −5°, 1° et 6°.
- **L'encart « Dans la démo »** (`.fact`) : chiffres tirés de la capture
  voisine, filet gauche violet pointillé.
- **La couverture** (telecharger) : SCIP plein, SETUP en contour gris,
  l'installeur réel devant la ligne 2, métadonnées dans les coins.
- **La boucle de décision** (index) : les quatre étapes de Control, l'étape
  Recommandation en encre, qui s'allument dans l'ordre une fois.

## Do's and Don'ts

Do :
1. Montrer un écran = intégrer sa capture réelle, avec son nom exact.
2. Tout chiffre vient du dépôt ou d'une capture ; les chiffres de démo vont
   dans un encart `.fact`.
3. Employer le vocabulaire du logiciel : Track, Optimise, Réseau, Control,
   Carte live, Conseils, Stocks, Commandes, Situation, Balises.
4. Écrire « OPTIMISE », jamais « OPTIMIZE ».
5. Dire les limites (page Télécharger) plutôt que les masquer.
6. Garder les révélations uniques et `prefers-reduced-motion`.

Don't :
1. Pas d'écran redessiné, pas de fonction qui n'existe pas.
2. Pas d'autre police que IBM Plex.
3. Pas de couleur d'action autre que l'encre ; le violet ne sort pas de
   « démo ».
4. Pas de dégradé, pas de scène WebGL décorative, pas de point qui pulse.
5. Pas de métaphore musicale hors de la section du film.
6. Pas de client, de prix, de témoignage ni de pourcentage de gain.

## Responsive Behavior

| Largeur | Stratégie |
|---|---|
| ≥ 1100px | héros 2 colonnes, fenêtre inclinée qui affleure le bord droit |
| ≤ 1100px | héros empilé, fenêtre à plat, mot géant derrière la fenêtre |
| ≤ 960px | blocs d'onglet en 1 colonne, copie avant capture |
| ≤ 700px | barre en 2 rangées : logo + Télécharger, puis sélecteur segmenté pleine largeur |
| ≤ 640px | boutons pleine largeur (cibles ≥ 44px) |

## Iteration Guide

1. Les tokens sont dans `site/css/base.css` ; ils recopient globals.css.
   Si la charte du logiciel change, changer là d'abord.
2. Nouvelle capture : la prendre sur le logiciel réel en 1440×900 à 2x, la
   convertir en WebP 1600 de large dans `site/assets/screens/` (1280 pour
   l'installeur ; Pillow, rééchantillonnage LANCZOS, qualité 82, method 6 :
   les réglages des captures en place), donner `width`, `height` et un `alt`
   qui décrit ce qu'on y lit.
3. Référence produit : `docs/site-vitrine-reference-produit.md` (branche de
   l'application) et le README des captures. Vérifier chaque phrase contre
   ces deux fichiers.
4. Nouvelle page : un mot géant en vocabulaire du logiciel, une fenêtre de
   capture en héros, puis des blocs capture + copie.
5. Contrôler sur captures 1440 et 390 avant de livrer ; console propre.
