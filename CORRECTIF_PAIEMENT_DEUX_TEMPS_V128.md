# PROPRIGO v1.2.8 — Paiement en deux temps : plus jamais de double débit

## Problème
Page Stripe dupliquée dans deux onglets : le bouton « Payer » du deuxième onglet reste actif après le premier paiement.
Cette page appartient à Stripe : PROPRIGO ne peut pas la masquer.

## Solution
- Les sessions Checkout des réservations sont créées avec `capture_method=manual` et la carte bancaire seulement
  (Apple Pay / Google Pay restent possibles, ce sont des cartes).
- Quand un client valide « Payer », Stripe **bloque** le montant sans le prélever.
- Le webhook décide, dans une transaction SQLite (table `stripe_claims`) :
  - premier paiement autorisé pour la réservation → **encaissé** (capture), réservation payée ;
  - tout autre paiement pour la même réservation → **autorisation annulée** : aucun débit, rien à rembourser ;
  - réservation annulée entre-temps ou montant différent du prix → autorisation annulée.
- Webhooks rejoués ou simultanés : un seul encaissement (clés d'idempotence `proprigo-capture-…` / `proprigo-cancel-…`).
- Journal admin : « Paiement en double bloqué … non encaissés, aucun débit ». Le client reçoit « Deuxième paiement annulé ».
- Les anciens paiements encaissés directement (avant cette version) restent couverts par le remboursement automatique de la v1.2.7.
- Cartes cadeaux et packs : inchangés (encaissement direct).

## À faire sur Stripe (obligatoire)
Stripe > Développeurs > Webhooks > endpoint `/api/stripe/webhook` > ajouter les événements :
- `payment_intent.amount_capturable_updated` (nouveau, indispensable)
- `payment_intent.succeeded` (v1.2.7)
en plus de ceux déjà cochés (`checkout.session.completed`, `checkout.session.expired`, …).
Sans `payment_intent.amount_capturable_updated`, un paiement bloqué en trop n'est jamais encaissé et se libère seul après 7 jours.

## Tests
`npm test` : 64/64, dont `test/stripe-capture.test.js` (deux onglets, validation simultanée, webhooks rejoués, réservation annulée, montant faux).
Faux Stripe uniquement : refaire le test des deux onglets sur Render en mode test.
