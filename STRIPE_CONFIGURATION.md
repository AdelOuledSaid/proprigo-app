# PROPRIGO — Stripe Checkout (mode test)

## Configuration Render

Dans **Render > proprigo-app > Environment**, configurer :

- `APP_URL=https://proprigo-app.onrender.com`
- `STRIPE_SECRET_KEY=sk_test_...` (secret, jamais dans Git)
- `STRIPE_WEBHOOK_SECRET=whsec_...` (obtenu en créant le webhook Stripe)
- `PAYMENTS_ENABLED=true` **uniquement après la configuration du webhook**
- `ADMIN_PASSWORD` : conserver le mot de passe fort existant
- `DB_FILE` : conserver le chemin actuel sur le disque persistant Render

Stripe Dashboard (mode test) > Développeurs > Webhooks > Ajouter une destination :

`https://proprigo-app.onrender.com/api/stripe/webhook`

Événements : `checkout.session.completed`, `checkout.session.expired`.

La clé publique `pk_test_...` n'est pas requise pour Checkout hébergé. Elle peut être conservée dans Render si souhaité.

## Fonctionnement

- Réservation ponctuelle : Checkout puis confirmation par webhook.
- Récurrence, paiement global : toutes les interventions de la série sont payées dans une seule session Checkout.
- Récurrence, paiement par intervention : première intervention payée lors de la réservation ; les suivantes restent en attente et se règlent depuis « Mes réservations » avant l'intervention.
- Aucune attribution d'intervenante pour une réservation en attente de paiement créée dans ce parcours.
- Le retour vers le site après Checkout **n'est pas** une preuve de paiement. Seul le webhook signé met à jour la base.
- Les réservations Airbnb automatiques sont **désactivées en production** dans cette version : elles ne peuvent pas être garanties prépayées sans un mécanisme d'autorisation/encaissement supplémentaire.

## Tests avant production

1. `npm test` (24 tests historiques + 1 test signature webhook).
2. Déployer sur Render avec des clés `sk_test_` et un webhook de **test**.
3. Effectuer une réservation ponctuelle avec la carte test Stripe `4242 4242 4242 4242`, date future, CVC arbitraire.
4. Vérifier dans Stripe que la session est payée, puis dans « Mes réservations » que le statut devient « Payé » et qu'une intervenante peut être attribuée.
5. Tester le refus de paiement, le retour arrière, les deux modes récurrents, l'idempotence des événements webhook et l'absence d'attribution avant paiement.
6. Avant passage en live : tests de remboursements, CGV, facturation, sécurité et autorisations de prélèvement pour les paiements futurs.

## Limites à ne pas ignorer

- Le paiement **par intervention** nécessite une action du client pour payer chaque intervention future ; il ne s'agit **pas** d'un prélèvement automatique. Aucun paiement automatique n'est promis.
- Les remboursements Stripe réels **ne sont pas automatisés** : l'ancienne fonction administrative « marquer remboursé » ne déclenche aucun virement Stripe. Traiter les remboursements dans Stripe et ne marquer « remboursé » dans PROPRIGO qu'après confirmation effective.
- Les modifications d'une réservation déjà payée peuvent nécessiter un ajustement de prix manuel ; à auditer avant lancement public.
- Les missions Airbnb automatiques restent suspendues en production jusqu'à leur prise en charge sécurisée.
- Les tests locaux et tests historiques ne remplacent pas un test réel de bout en bout avec Stripe et Render.
