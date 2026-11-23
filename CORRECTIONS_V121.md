# PROPRIGO — correctifs appliqués au dossier transmis (base 1.2.0)

- Checkout Stripe : clé d'idempotence dérivée de l'identifiant client, des réservations, du montant et d'une fenêtre de 30 minutes ; conservation de la recherche de session existante. Cela réduit les doublons mais ne remplace pas un verrou transactionnel complet contre les requêtes concurrentes.
- Remboursement Stripe : journal `stripe_refund_ledger` évitant de comptabiliser deux fois une même réponse de remboursement Stripe.
- Remboursement `pending` : la réservation passe à `remboursement_en_cours`, et non à `rembourse`.
- Webhook `refund.updated` : finalise un remboursement réussi ou remet à traiter un remboursement échoué/annulé. Il faut activer cet événement sur le webhook Stripe.
- Annulation administrateur : ne demande plus un remboursement pour une réservation non encaissée.

## Vérification

`npm test` : 48 tests existants réussis. Pas de test d'intégration Stripe réel ni de test de concurrence effectué.

## À terminer avant production

1. Vérifier le webhook Stripe et l'événement `refund.updated` en mode test.
2. Vérifier les remboursements en cours/échoués et la réconciliation comptable, notamment après erreurs réseau.
3. Ajouter une protection transactionnelle contre deux créations simultanées de sessions Checkout.
4. Auditer permissions, factures et conformité légale, notifications et planning.
5. Tester les migrations sur une copie de la base, jamais sur la base de production sans sauvegarde.

Les dossiers `.git`, `node_modules`, `data` et les secrets `.env` sont volontairement exclus du ZIP de livraison.
