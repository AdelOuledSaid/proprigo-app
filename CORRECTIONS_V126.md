# PROPRIGO v1.2.6 — Libellés de remboursement

- Annulation non payée : affiche « Annulée — non payée » au lieu de « À payer avant intervention ».
- Annulation remboursée partiellement : affiche le montant remboursé (ex. 55,50 € sur 111 €).
- Remboursement total : conserve « Remboursé ».
- Le libellé est corrigé dans les vues client et administrateur, sans changer les données financières ni les protections Stripe.
- Ajout de 4 tests de régression des libellés.

## Vérifications restantes avant Stripe réel

- Les webhooks HTTP 200 et un remboursement de 55,50 € ont été constatés sur les captures de test.
- La résistance à deux paiements Stripe simultanés de la même réservation n'a PAS été validée de bout en bout avec Stripe.
- Vérifier sur Render le rendu des réservations n° 14 et n° 15 et les données de remboursement.
- Ne jamais recopier un fichier .env ou une base de données locale par-dessus la production.
