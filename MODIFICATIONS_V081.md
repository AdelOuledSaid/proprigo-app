# PROPRIGO v0.8.1 — réservations sans intervenante préalablement disponible

- Les créneaux proposés (07h–20h, par pas de 30 minutes, selon la durée) ne dépendent plus de la présence d’intervenantes inscrites.
- Le client choisit un créneau, puis règle sa réservation avec Stripe Checkout en production.
- Après confirmation par webhook signé, la réservation reste **en attente d’attribution** dans l’administration.
- L’administrateur choisit une intervenante; l’attribution d’une réservation non payée est bloquée en production.
- Les paiements groupés ou par intervention pour les ménages récurrents sont conservés.
- Les événements Stripe `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` sont reconnus.

## Important avant commercialisation

Le paiement ne garantit pas la disponibilité d’une intervenante : cette réserve doit être clairement communiquée au client. En cas d’impossibilité, annuler et **effectuer le remboursement réel dans Stripe** (le bouton « Marquer remboursé » de l’application ne déclenche pas de remboursement bancaire). Les paiements récurrents individuels ne sont pas prélevés automatiquement. Les ménages Airbnb automatiques restent à finaliser. Vérifier aussi les modifications de réservation avec différence de prix, la politique d’annulation et les emails. Ne pas activer les paiements réels avant validation de ces parcours.

## Déploiement

Sauvegarder la base persistante Render. Remplacer les fichiers du projet, `npm test`, puis `git add .`, `git commit -m "Reservations avec attribution manuelle"`, `git push origin main`. Vérifier les variables Stripe dans Render sans les exposer dans le dépôt. Faire une réservation de test sans intervenante, confirmer le paiement et vérifier l'affichage dans l'administration.
