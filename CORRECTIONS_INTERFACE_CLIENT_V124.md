# PROPRIGO v1.2.4 — Interface client

Base : dossier complet PROPRIGO v1.2.3. Les protections Stripe et la réconciliation des remboursements sont conservées.

## Changements
- Onglets « En cours et à venir » et « Historique (terminées et annulées) » dans Mes réservations.
- Une réservation annulée reste consultable dans l'historique, mais n'affiche plus « Payer cette intervention ».
- Bouton d'annulation renommé « Annuler ma réservation » et confirmation détaillant prix, retenue et remboursement prévisionnel, avant l'appel serveur.
- Distinction des statuts « À rembourser » et « Remboursement en cours ».
- Blocage serveur existant du paiement des réservations annulées conservé.

## Validation
54 tests automatiques réussis. À tester manuellement dans le navigateur : onglets, annulation avant/après 24 h, affichage du montant et absence de bouton payer sur une réservation annulée. Les montants de l'écran sont une estimation; le serveur recalcule les conditions à la confirmation.

## Déploiement
Copier le contenu du dossier proprigo-app dans le projet local sans remplacer .git, .env ni les données. `npm test`, puis `git status`, `git add .`, `git commit -m "Interface client PROPRIGO v1.2.4"`, `git push origin main`. Vérifier le déploiement Render.
