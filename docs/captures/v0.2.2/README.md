# Captures de SCIP après la 0.2.1 : la démo corrigée

Prises le 2 octobre 2026 sur une installation de test de `SCIP-Setup-0.2.1.exe` dont l'API et le
moteur IA ont été remplacés par ceux de cette branche. Elles montrent ce que la version suivante
affichera ; les autres écrans sont inchangés et restent dans `../v0.2.1/`. Même format : 1440×900 à
l'échelle 2, jeu de démo, interface en français.

| Fichier | Écran | Ce qu'on y voit |
|---|---|---|
| `conseils.png` | Optimise · Conseils | « 3 conseils ouverts, 1 critique(s) », en tête « Commander 2 963 unités de SKU-006 auprès de Tema Port Distributors » |
| `conseils-pourquoi.png` | Optimise · Conseils | la même recommandation dépliée : « Le calcul porte sur Accra Central DC seul : ce site est sous son point de commande. Les 4 798 unités détenues dans les autres entrepôts ne le desservent pas sans transfert. », coût −GHS 58 672, « accepter et exécuter » |
| `control.png` | Track · Control | « 3 décisions en attente, 1 critique » |
| `commandes.png` | Réseau · Commandes | le bon de commande créé en acceptant le conseil : origine « Recommandation », brouillon, Tema Port Distributors, WH-ACC, GHS 58 672 |
| `installeur-04-type.png` | Installeur · Type | aperçu de l'installeur : « Données fictives (Demo Distribution Ghana) » |

## Ce qui a été vérifié sur cette installation

Le déroulé de `docs/DEMO-scenario.md`, de 4:00 à 7:00, rejoué par un navigateur piloté :

1. Réglages → « Préparer la démo », puis Stocks → « Demander une recommandation » : le conseil de
   commande du SKU-006 apparaît.
2. « accepter et exécuter » : « Bon de commande brouillon créé ».
3. Régénération immédiate, le bon étant encore en brouillon : le conseil ne revient pas.
4. Commandes : le bon porte l'origine « Recommandation » et l'entrepôt WH-ACC.
5. « passer à… » En attente, puis Confirmée ; nouvelle régénération : le conseil ne revient pas.
6. Stocks : 2 963 unités attendues à WH-ACC.
