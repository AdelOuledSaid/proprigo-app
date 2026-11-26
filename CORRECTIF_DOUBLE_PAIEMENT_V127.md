# PROPRIGO v1.2.7 — Double paiement Stripe remboursé automatiquement

## Problème constaté (test du 23/11/2026)
Page de paiement Stripe dupliquée dans deux onglets : les deux paiements passent pour la même réservation.
Les deux onglets utilisent la même session Stripe : l'ancienne détection (`duplicate_paid`) ne voyait que les doublons venant d'une autre session, et ne remboursait rien.

## Correction
- Nouvel événement webhook écouté : `payment_intent.succeeded`. Chaque encaissement réussi est noté (table `stripe_intents_seen`).
- Si la réservation est déjà payée par un autre encaissement identifié, l'encaissement en trop est **remboursé automatiquement en totalité** (raison Stripe `duplicate`).
- Une seule fois par encaissement : table `stripe_duplicate_refunds` + clé d'idempotence `proprigo-duplicate-<payment_intent>`.
- Le paiement retenu n'est jamais remboursé ; tant qu'il n'est pas identifié, rien n'est remboursé (le contrôle est refait à la confirmation de session).
- Deux sessions différentes payées : la seconde passe à `duplicate_refunded`.
- Journal admin : « Double paiement … remboursés automatiquement ». En cas d'échec : « ALERTE DOUBLE PAIEMENT … À rembourser dans Stripe ».
- Le client reçoit un e-mail « Paiement en double remboursé ».

## À faire sur Stripe (obligatoire)
Stripe > Développeurs > Webhooks > endpoint `/api/stripe/webhook` > Ajouter l'événement **`payment_intent.succeeded`**.
Sans cet événement, le cas « même lien dans deux onglets » n'est pas détecté.

## Tests
`npm test` : 59/59, dont 3 nouveaux (`test/stripe-double.test.js`) : deux onglets, événements dans le désordre et rejoués, deux sessions.
Tests avec un faux Stripe : refaire le test des deux onglets sur Render en mode test.
