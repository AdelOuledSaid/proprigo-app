# PROPRIGO v1.2.0 — correctifs de fiabilité (23 novembre 2026)

## Modifications apportées
- Checkout Stripe : clé d'idempotence stable pour une même combinaison client/réservation/montant. Une requête répétée après une perte de réponse Stripe ne crée pas une nouvelle session pendant la fenêtre d'idempotence Stripe. La session enregistrée est réutilisée comme auparavant.
- Annulation par l'administration : une réservation non payée n'est plus marquée « à rembourser » et ne reçoit pas de montant de remboursement fictif.
- Remboursement Stripe : un remboursement au statut `pending` n'est plus présenté comme définitivement réussi. La réservation est marquée `remboursement_en_cours`, le montant `refunded_cents` n'est incrémenté que pour `succeeded`. Les messages d'erreur réseau n'affirment plus qu'aucune opération n'a eu lieu.
- Adaptation du test d'annulation administrative au comportement corrigé.

## Vérification
`npm test` : 37 tests réussis, 0 échec sur Node.js local.

## IMPORTANT — reste à faire avant la mise en production
- Ajouter une réconciliation automatique des remboursements `pending` via événements Stripe et/ou interrogation de l'API Stripe. Pour l'instant vérifier ces remboursements dans Stripe, ne pas les relancer aveuglément.
- Vérifier les remboursements partiels et simultanés, et le cas d'une réponse Stripe perdue après création d'un remboursement.
- Auditer complètement les permissions, les accès aux données personnelles, les conflits d'affectation et les migrations sur une copie de production.
- Configurer/tester le fournisseur d'e-mails, les mentions légales et les factures.
- Tester manuellement un parcours complet sur Render en environnement Stripe test avant de passer en réel.

## Déploiement
Ne jamais remplacer `/var/data/proprigo.db` ou `/var/data/backups` avec un ZIP. Conserver les variables secrètes dans Render, jamais dans Git. Sauvegarder la base avant déploiement.
