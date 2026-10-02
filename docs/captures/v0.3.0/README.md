# Captures de SCIP 0.3.0 : la démo corrigée

Prises le 2 octobre 2026 sur une installation de test de `SCIP-Setup-0.2.1.exe` dont l'API et le
moteur IA ont été remplacés par ceux de la 0.3.0. Elles montrent ce que la 0.3.0
affiche ; les autres écrans sont inchangés et restent dans `../v0.2.1/`. Même format : 1440×900 à
l'échelle 2, jeu de démo, interface en français.

| Fichier | Écran | Ce qu'on y voit |
|---|---|---|
| `conseils.png` | Optimise · Conseils | « 3 conseils ouverts, 1 critique(s) », en tête « Commander 2 963 unités de SKU-006 auprès de Tema Port Distributors » |
| `conseils-pourquoi.png` | Optimise · Conseils | la même recommandation dépliée : « Le calcul porte sur Accra Central DC seul : ce site est sous son point de commande. Les 4 798 unités détenues dans les autres entrepôts ne le desservent pas sans transfert. », coût −GHS 58 672, « accepter et exécuter » |
| `control.png` | Track · Control | « 3 décisions en attente, 1 critique » |
| `commandes.png` | Réseau · Commandes | le bon de commande créé en acceptant le conseil : origine « Recommandation », brouillon, Tema Port Distributors, WH-ACC, GHS 58 672 |

## L'installeur 0.3.0

Même méthode que pour la 0.2.1 (`../v0.2.1/README.md`) : aperçu navigateur de `apps/installer/ui/`,
960×640 à l'échelle 2, bandeau « aperçu » masqué, numéros de version de l'aperçu remplacés par ceux de
la release (0.3.0, mise à jour depuis 0.2.1). Le dossier affiché est celui d'un utilisateur fictif ;
l'écran Système et l'écran Installation montrent des valeurs d'exemple (système, espace, tailles).

`installeur-01-bienvenue.png`, `-03-systeme`, `-04-type` (« Données fictives (Demo Distribution
Ghana) »), `-05-base-de-donnees`, `-06-organisation`, `-08-administrateur`, `-09-recapitulatif`,
`-10-installation`, `-11-termine`, puis `installeur-mise-a-jour.png` (« SCIP 0.2.1 est installé sur
ce poste. Cet assistant le met à jour en version 0.3.0 ») et `installeur-desinstallation.png`.

## Ce qui a été vérifié sur cette installation

Le déroulé de `docs/DEMO-scenario.md`, de 4:00 à 7:00, rejoué par un navigateur piloté :

1. Réglages → « Préparer la démo », puis Stocks → « Demander une recommandation » : le conseil de
   commande du SKU-006 apparaît.
2. « accepter et exécuter » : « Bon de commande brouillon créé ».
3. Régénération immédiate, le bon étant encore en brouillon : le conseil ne revient pas.
4. Commandes : le bon porte l'origine « Recommandation » et l'entrepôt WH-ACC.
5. « passer à… » En attente, puis Confirmée ; nouvelle régénération : le conseil ne revient pas.
6. Stocks : 2 963 unités attendues à WH-ACC.
