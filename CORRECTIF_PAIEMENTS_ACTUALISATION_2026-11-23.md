# Correctif Stripe et rafraîchissement — 23 novembre 2026

- Sérialisation des créations de sessions Checkout concurrentes par réservation au sein d'un même processus Node.
- Réutilisation de la session Stripe `pending` existante (déjà présente dans le code fourni).
- Métadonnées `booking_ids` sur la session Checkout ET le PaymentIntent.
- Recontrôle du statut de la réservation après création de session, et tentative d'expiration si payée entre-temps.
- À la réception du webhook de paiement : expiration best-effort des autres sessions enregistrées pour les mêmes réservations.
- Si une deuxième session est encaissée, elle est marquée `duplicate_paid` et une alerte est ajoutée au journal. Aucun remboursement automatique sans vérification.
- Actualisation de l'interface des réservations et tableaux de bord toutes les 15 secondes, au retour sur l'onglet et à la reprise de focus.

## Limites importantes
- L'interdiction absolue d'un deuxième encaissement n'est pas garantie avec plusieurs processus/instances ou deux sessions Stripe déjà ouvertes. Une coordination transactionnelle distribuée et une politique de remboursement/reconciliation sont nécessaires pour cela.
- Les sessions anciennes et paiements déjà encaissés ne sont pas annulés rétroactivement.
- Les tests locaux ne remplacent pas un test d'intégration sur Render/Stripe.
- Ne pas remplacer la base SQLite persistante ni les variables d'environnement sur Render.
- `npm test` sur le ZIP reçu : 4 tests de l'interface client sont déjà incompatibles avec l'interface actuelle (assertions de chaînes absentes). 48 autres tests passent avant ajout du test de concurrence. Après ajout : 49 réussis, 4 en échec.
