# PROPRIGO — Stripe, protection renforcée (correctif v1.2.2)

## Modifications

- Création de la table SQLite `stripe_checkout_attempts` à la première demande de paiement (aucune suppression ni restauration de données).
- Verrou persistant par client et liste de réservations, pris dans une transaction SQLite `BEGIN IMMEDIATE` **avant** l'appel Stripe. Un double clic concurrent est refusé pendant la création de la session.
- Clé d'idempotence aléatoire **stable par tentative** et paramètres Stripe stables (`expires_at` inclus). En cas de timeout, le serveur réessaie avec la même clé et le même corps de requête, au lieu de générer une seconde session.
- Les sessions existantes sont consultées chez Stripe avant réutilisation. Si le statut est incertain, la création d'un nouveau paiement est bloquée plutôt que de risquer un doublon.
- Si une session connue est expirée, une nouvelle tentative est autorisée à la demande suivante.
- Le bouton de marquage manuel « remboursé » est désactivé quand Stripe est actif, pour éviter de déclarer un remboursement effectué sans preuve Stripe.
- Conservation des webhooks de confirmation des paiements et `refund.updated` et du journal des remboursements déjà présents.

## Tests

- `npm test` : 49 tests réussis, dont un nouveau test simulant deux demandes Checkout simultanées.
- Aucun test réel de paiement ni de remboursement sur un compte Stripe n'a été réalisé.

## Configuration Render et Stripe

1. Conserver `DB_FILE=/var/data/proprigo.db`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL` et `PAYMENTS_ENABLED` existants ; ne jamais copier les clés dans le code ou dans Git.
2. Stripe > Webhooks : endpoint `https://proprigo-app.onrender.com/api/stripe/webhook` (adapter après configuration du domaine). Activer `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` et `refund.updated`.
3. Après déploiement, vérifier une session normale, deux clics simultanés, un abandon de Checkout, puis un remboursement test avec le webhook. Vérifier l'absence de double paiement dans Stripe et la cohérence de la réservation.
4. Conserver une sauvegarde indépendante avant déploiement ; ne jamais restaurer une ancienne base sur la production sans procédure de fusion.

## Limites et points à surveiller

- En cas d'état Stripe inconnu et d'expiration de la tentative, le serveur **bloque** la création d'un autre paiement et demande une réconciliation manuelle. C'est intentionnel pour privilégier la sécurité financière.
- Les remboursements restent à valider en mode test, notamment les statuts `pending`, `failed`, les erreurs réseau et la réconciliation des totaux.
- Les autres sujets (permissions, disponibilité des intervenantes, conformité légale, e-mails) ne font pas partie de ce correctif.
