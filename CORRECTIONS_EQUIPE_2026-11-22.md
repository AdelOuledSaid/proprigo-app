# PROPRIGO — corrections équipe et doublons

## Changements
- Ajout de l'inscription d'une intervenante réelle depuis **Administration > Équipe** (compte inactif jusqu'à validation des étapes).
- Bouton pour ajouter cinq profils fictifs marqués TEST, initialement inactifs et absents ; leur activation par le parcours administratif est interdite.
- En production, la création de profils fictifs exige temporairement `ALLOW_DEMO_WORKERS=true` dans Render ; supprimer cette variable après les essais. Ces profils ne sont **pas** des prestataires réels et ne doivent pas être utilisés pour des missions clients.
- Indicateur de réservations : exclut les réservations annulées sans paiement (`paiement_echoue`).
- Conservation des corrections précédentes : masquage des tentatives échouées dans l'espace client et protection contre les doublons.
- 26 tests automatiques réussis.

## Déploiement
1. **Ne pas supprimer ni remplacer** la base de données `/var/data/proprigo.db`, ni `/var/data/backups`, ni les variables Stripe.
2. Copier les fichiers du ZIP dans le projet local en conservant `.git` et tout fichier `.env` local.
3. `npm test`
4. `git add . && git commit -m "Gestion equipe et correction doublons" && git push origin main`
5. Attendre le statut Live sur Render et recharger le navigateur.
6. Administration > Équipe : créer les vraies intervenantes et vérifier les étapes d'intégration.
7. Pour les cinq profils fictifs, ajouter `ALLOW_DEMO_WORKERS=true` dans les variables Render, redéployer, cliquer le bouton, puis retirer cette variable. Ne pas les activer.

## Important
Les dix sauvegardes examinées sur Render ne contiennent aucun compte intervenante. Le ZIP n'en ajoute pas automatiquement dans la base de production et ne restaure aucune sauvegarde. Les données et paiements de production restent inchangés au déploiement.
