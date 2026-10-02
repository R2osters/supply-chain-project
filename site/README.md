# Site vitrine de SCIP

Le site public du logiciel : cinq pages statiques, sans dépendance ni étape de construction.

En ligne : <https://r2osters.github.io/supply-chain-project/>

## Contenu

| Fichier | Rôle |
|---|---|
| `index.html`, `suivi.html`, `optimisation.html`, `reseau.html`, `telecharger.html` | les cinq pages ; chacune a sa feuille dans `css/` |
| `404.html` | page d'erreur servie par GitHub Pages |
| `css/base.css` | jetons et composants communs, repris de la charte du logiciel (`apps/web/src/app/globals.css`) |
| `js/site.js` | révélations, inclinaison des fenêtres, lecture du film, lien vers la dernière release |
| `assets/screens/` | captures réelles de SCIP et de son installeur (WebP) |
| `assets/video/` | le film « Le Signal » en version web et son affiche |
| `DESIGN.md` | le système de design du site |

Chaque écran montré est une capture réelle du logiciel, et chaque chiffre vient du dépôt ou d'une
capture. La liste des faits vérifiés est tenue dans `docs/site-vitrine-reference-produit.md`, sur la
branche de l'application.

## Voir le site en local

```bash
python -m http.server 8765 --directory site
```

Puis ouvrir <http://localhost:8765>.

## Le bouton de téléchargement

Dans le HTML, le bouton pointe sur la page de la dernière release, et la version, le nom du fichier
et sa taille sont écrits en dur : ce sont les valeurs de repli. Au chargement, `js/site.js` interroge
l'API GitHub (`releases/latest`) ; si elle répond, le bouton devient un téléchargement direct de
l'installeur et les éléments marqués `data-rel` prennent les valeurs de la release. La réponse est
gardée une heure dans le navigateur, parce que l'API anonyme est limitée à 60 appels par heure et
par adresse.

À chaque nouvelle version, mettre quand même à jour les valeurs de repli et les captures.

### macOS et Linux

Les lignes macOS et Linux de la page Télécharger sont dans le HTML, masquées (`hidden`,
`data-if="unix"`). `js/site.js` ne les affiche que si la dernière release contient les deux
paquets (`SCIP-<version>-macos-arm64.dmg` et `SCIP-<version>-linux-amd64.deb`), contrôlés comme
l'installeur : nom attendu, version de la release, lien de cette release. Dans ce cas seulement,
les deux phrases « Il n'existe pas de version macOS ni Linux » (`data-unless="unix"`) laissent la
place à leurs variantes. Sans script, ou si l'API ne répond pas, la page reste dans l'état écrit
dans le HTML : le jour où une release publie ces paquets, inverser les attributs `hidden` des
éléments `data-if` et `data-unless` pour que cet état de repli dise vrai.

Chaque ligne porte ses limites, visibles sans clic : version préliminaire, non signée (avec la
marche à suivre sur Mac), mise à jour manuelle, construite et testée automatiquement mais pas
encore essayée par une personne. Windows reste le bouton principal.

## Publier

GitHub Pages sert la branche `gh-pages`, qui ne contient que ce dossier. Depuis la racine du dépôt,
une fois les changements du site commités :

```bash
git subtree split --prefix site -b gh-pages-build
```

```bash
git push origin gh-pages-build:gh-pages --force
```

```bash
git branch -D gh-pages-build
```

La mise en ligne prend une à deux minutes. Rien d'autre n'est publié : ni `master`, ni les releases.

## Le film

`assets/video/scip-le-signal-web.mp4` est la version web du film (1920 × 1080, 30 images par
seconde, environ 45 Mo), réencodée depuis le fichier original de 194 Mo, que GitHub refuse
(limite de 100 Mo par fichier). L'original reste hors du dépôt.

Après une modification d'une feuille de style ou du script, changer le suffixe `?v=` des liens dans
les pages : sans cela, un navigateur peut garder l'ancienne version en cache.
