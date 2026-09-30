# Le Signal — vidéo de présentation de SCIP

## Ce que c'est

Un film de 2 min 50 s (170 s, 1920×1080, 30 images/s) qui présente SCIP, la plateforme
d'intelligence logistique, comme un morceau de musique : 120 BPM, 85 mesures, 18 scènes. Un retard
de livraison y est une note qui tombe à contretemps, et le logiciel est l'orchestre qui l'entend
puis joue la réponse.

Tout est généré par du code, sans montage à la main :

- l'image est une composition [Remotion](https://www.remotion.dev) (React), une scène par fichier
  dans `src/scenes/` ;
- la musique est procédurale (Python, `scripts/music/`), rendue en stems puis mixée avec la voix ;
- la voix off est synthétisée par scène (`scripts/vo.py`), et ses timings mot à mot pilotent les
  textes et les événements à l'écran ;
- `timeline/timeline.json` est la source unique : scènes, mesures, textes de la voix et cues.
  L'image et le son lisent tous les deux ce fichier, d'où la synchro.

Sortie : `out/scip-le-signal.mp4` (H.264 CRF 18, AAC 320 kb/s). La conception complète est dans
`docs/superpowers/specs/2026-09-29-video-le-signal-design.md`.

## Prérequis

- **Node 20 ou plus récent** (npm inclus). Sous Node 25, vitest 5 affiche un avertissement
  `EBADENGINE` à l'installation : il fonctionne quand même.
- **Python 3.12** pour la voix, la musique, le lint et les contrôles audio.
- Un accès réseau la première fois (voix edge-tts, fond de carte Natural Earth, Chrome de
  Remotion). Ensuite les caches `.vo-cache/` et `.geo-cache/` suffisent.
- De la place pendant un rendu : environ 330 Mo dans le dossier temporaire (voir l'astuce plus
  bas) et 450 Mo dans `out/` (vidéo muette intermédiaire, puis film final de 223 Mo).

Les commandes ci-dessous sont données pour PowerShell, depuis `media/promo-video/`.

## Régénérer

```powershell
cd media/promo-video
npm install

# Environnement Python (une fois)
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

# 1. Voix off : un MP3 par scène + generated/vo-timings.json (réseau, sinon le cache est réutilisé)
python scripts/vo.py
# 2. Cues : chaque événement résolu en image absolue -> generated/cues.json
python scripts/cues.py
# 3. Lint bloquant : grille de 15 images, voix contenues dans leur scène, clics à 64,0 s et 162,0 s
python scripts/lint_timeline.py

# 4. Musique : les stems (.stems/) puis le master (public/audio/master.wav), depuis scripts/
cd scripts
python -m music.score
python -m music.mix
cd ..

# 5. Fond de carte : Natural Earth v5.1.2 -> generated/geo.json
npm run geo

# 6. Rendu final -> out/scip-le-signal.mp4
npm run render
```

`npm run render` se fait en deux temps (décision R22) :

1. Remotion rend l'image **sans le son** (`--muted`) dans `out/scip-le-signal.video.mp4`
   (H.264, CRF 18, 1920×1080) ;
2. `scripts/mux.mjs` y ajoute `public/audio/master.wav` avec le ffmpeg fourni par Remotion
   (`-c:v copy -c:a aac -b:a 320k`), écrit `out/scip-le-signal.mp4` et supprime le fichier
   intermédiaire.

Le mux AAC de Remotion décale le son de 2 048 échantillons (1,28 image) : chaque cue tomberait une
à deux images en retard. Le remux ne décale rien. `npm run render:draft` suit le même chemin en
1280×720 (CRF 28) vers `out/scip-le-signal-draft.mp4`, pour que les brouillons soient synchrones
eux aussi.

`generated/*.json` et `public/audio/vo/*.mp3` sont commités : si la timeline ne change pas, on peut
sauter les étapes 1 à 3 et 5, et le rendu reste reproductible sans réseau.

**Astuce : petit disque système.** Chaque rendu copie `public/` et le profil de Chrome dans le
dossier temporaire (souvent sur `C:`). Pour le garder sur le disque du projet, avant
`npm run render` :

```powershell
New-Item -ItemType Directory -Force out\tmp | Out-Null
$env:TEMP = "$PWD\out\tmp"; $env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
npm run render
Remove-Item -Recurse -Force out\tmp
```

`npm run stills` et `npm run check:determinism` le font d'eux-mêmes (`scripts/render-lib.mjs`).

## Modifier une phrase

1. Modifier le texte dans `timeline/timeline.json`, champ `vo.screen` de la scène. C'est le texte
   affiché et prononcé. La table `pronunciation` s'applique toute seule (« SCIP » est dit « Skip »,
   « AIS » est épelé). Si une cue est ancrée sur un mot (`"word": ...`), ce mot doit rester dans la
   phrase.
2. `python scripts/vo.py` : nouvelle voix et nouveaux timings. Si le clip déborde de sa scène,
   accélérer la voix avec `vo.rate` (le débit par défaut, `voice.defaultRate`, est `-4%` ; 8 points
   de plus au maximum, soit `+4%`) ou couper des mots ; la grille ne bouge jamais.
3. `python scripts/cues.py` : les cues suivent les mots.
4. `python scripts/lint_timeline.py` : doit passer.
5. Depuis `scripts/` : `python -m music.score` puis `python -m music.mix` (le ducking suit les
   nouveaux mots).
6. `npm run render:draft` pour vérifier, puis `npm run render`.

Le texte affiché à l'écran en dehors de la voix (tampons, puces, cartes) est dans le fichier de la
scène, `src/scenes/Sxx*.tsx`.

## Contrôles

- **Tests** : `npx vitest run` (bibliothèque, composants, React Bits adaptés) et
  `python -m pytest tests/py` (audio : durée exacte, crête, loudness, mono, alignement des cues).
  Typage : `npm run typecheck`. Lint : `python scripts/lint_timeline.py`.
- **Déterminisme** : `npm run check:determinism` rend 15 images réparties sur les 18 scènes, dans
  l'ordre croissant puis décroissant, puis une troisième fois dans une seule page comme le fait
  `remotion render`, et compare les sha256. Chrome n'est pas exact au bit près sur l'anticrénelage
  des glyphes : quand deux hash diffèrent, un écart d'au plus ±2 niveaux sur au plus 0,1 % des
  pixels est accepté comme bruit de rastérisation (décision R23) ; au-delà, le contrôle échoue et
  les images sont écrites dans `out/determinism/`. `--strict` exige des hash identiques.
- **Images clés** : `npm run stills -- --frames 127,1920,4860 --out out/stills` (voir l'en-tête de
  `scripts/stills.mjs` pour les plages et les noms de cues).
- **Rapport audio** : depuis `scripts/`, `python -m music.report` mesure le master (loudness
  -16 LUFS ±0,5, crête vraie ≤ -1 dBTP, perte mono ≤ 3 dB, alignement des cues) et écrit
  `out/audio-report.txt` et `out/spectrogram.png`. Pour contrôler le fichier final, décoder
  d'abord son son :
  `npx remotion ffmpeg -y -i out/scip-le-signal.mp4 -map 0:a -c:a pcm_s24le out/final-audio.wav`,
  puis `python -m music.report ../out/final-audio.wav`.
- **Rapport de contrôle** (porte D) : sonde du MP4 (`npx remotion ffprobe out/scip-le-signal.mp4`),
  mesures audio du fichier final, déterminisme, tests, puis la checklist des faits du spec § 8,
  ligne par ligne, chacune prouvée par un still pleine taille
  (`npm run stills -- --frames 1000,1370,1680 --out out/stills/facts`).

## Licences

- **Polices IBM Plex** (Sans, Sans Condensed, Mono), via `@fontsource` : SIL Open Font License 1.1.
- **Fond de carte Natural Earth** v5.1.2 : domaine public.
- **React Bits** (reactbits.dev) : les composants adaptés de `src/rb/` sont sous licence MIT +
  Commons Clause, réécrits pour être des fonctions pures de l'image Remotion.
- **Voix off** : générée avec Microsoft Edge TTS (voix `fr-FR-RemyMultilingualNeural`, via
  `edge-tts`) pour un projet scolaire non commercial.
- La musique et les effets sonores sont produits par le code de `scripts/music/`, sans échantillon
  extérieur.
