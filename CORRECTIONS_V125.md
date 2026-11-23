# PROPRIGO v1.2.5 — Synchronisation administrateur

- Les réservations du tableau administrateur sont triées par numéro décroissant (`ORDER BY id DESC`).
- Suppression de la limite de 200 lignes dans l’aperçu administrateur pour ne pas masquer les anciennes réservations. Attention : une pagination serveur sera préférable à grande échelle.
- Les tâches « À traiter » affichent les réservations les plus récentes en premier.
- Endpoint authentifié `GET /api/admin/revision` (réservé aux comptes administrateurs) : compte et ID maximal des réservations + ID maximal du journal.
- L’interface contrôle cette révision toutes les 20 secondes, ainsi qu’au retour sur l’onglet, et recharge l’administration uniquement si elle a changé.
- Le rafraîchissement ne coupe pas la saisie d’un champ actif ; le bouton « Actualiser » permet de forcer le rechargement.
- Le rafraîchissement conserve l’onglet sélectionné et la position verticale.
- Aucun changement des traitements Stripe, remboursements, données ou variables Render.

## Vérification

1. `npm test`
2. Se connecter à l’administration et ouvrir « Réservations » : le numéro le plus grand doit être en tête.
3. Dans un autre navigateur, créer et payer une nouvelle réservation en mode test.
4. Sans se déconnecter de l’administration, attendre au plus 20 secondes et vérifier l’apparition de la réservation.
5. Vérifier le statut dans « À traiter » et le bon fonctionnement du bouton « Actualiser ».

**Limites** : le rafraîchissement est suspendu pendant la saisie active pour éviter la perte de formulaire. L’empreinte du journal détecte les changements qui y sont enregistrés ; les changements silencieux ne sont pas nécessairement détectés.
