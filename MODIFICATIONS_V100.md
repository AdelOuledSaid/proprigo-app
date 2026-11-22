# PROPRIGO v1.0.0 — les trois espaces au complet

## Administration
- **Planning de la semaine** (onglet Planning) : une ligne par intervenante, les ménages en blocs ; glisser un ménage sur une intervenante pour l'attribuer, ou le toucher pour choisir dans la liste (téléphone). Semaine précédente / suivante.
- **Remboursement réel dans Stripe** : bouton « Rembourser X € ». Montant de la règle d'annulation, clé d'idempotence fixe (jamais deux remboursements), jamais plus que le paiement. Le client reçoit un message. « Déjà remboursé dans Stripe » reste disponible pour un remboursement fait à la main.
- **Fiches client et intervenante** avec historique, avis, notes basses, et **notes internes** de l'équipe.
- **Vrais chiffres** (onglet Chiffres) : argent réellement encaissé dans Stripe (remboursements déduits), ce mois / mois dernier / total, clients qui reviennent, taux d'annulation, codes postaux les plus demandés, parrainages.
- **Compte « planning »** (Équipe → Comptes de l'équipe) : voit planning, réservations, équipe et messages ; ne voit ni l'argent ni les coordonnées complètes, ne peut ni rembourser ni créer de compte.
- « À traiter » distingue les réclamations, les problèmes sur place et les notes basses.

## Intervenante
- Boutons du jour J : **Je pars** → **Je suis arrivée** → Commencer → Terminer ; le client est prévenu (message + e-mail).
- **Itinéraire** Google Maps et Citymapper vers l'adresse.
- **Mes gains** : ce mois, mois dernier, à venir, barres des 6 derniers mois (heures pour les salariées, euros au tarif pour les indépendantes).
- **Problème sur place** (pas d'accès, casse, logement très sale, insécurité) : alerte immédiate de l'équipe par e-mail et dans « À traiter ».
- **Ma présentation** (Mon compte) : quelques mots et langues parlées, visibles par ses clients.

## Client
- Suivi en direct en 5 étapes (Réservé, Confirmée, En route / Arrivée, En cours, Terminé), actualisé tout seul le jour du ménage.
- **Fiche de l'intervenante** : prénom, ancienneté, nombre de ménages, note réelle, langues, présentation, dernier avis.
- **Avis avec commentaire** : étoiles puis un mot ; une note inférieure à 4 crée une alerte qualité.
- **Parrainage** : code personnel, lien à partager ; 10 € offerts au filleul sur son premier ménage (jamais plus de 50 % du prix), 10 € au parrain quand ce ménage est terminé.
- **Attestation fiscale annuelle** (Mon compte → Mes documents) : ménages à domicile de l'année, hors Airbnb. Marquée provisoire tant que la déclaration « services à la personne » n'est pas obtenue.

## Non fait, et pourquoi
- **Notifications sur le téléphone** (push) : il faut une bibliothèque de chiffrement à installer, impossible dans cet environnement sans réseau. Les e-mails partent déjà à chaque étape.

## Déploiement
Les nouvelles colonnes et tables s'ajoutent toutes seules au démarrage. Sauvegardez d'abord la base Render, puis `npm test`, `git add .`, `git commit -m "Proprigo v1.0"`, `git push origin main`.
Après le déploiement, faites un remboursement test d'un petit montant en mode test Stripe avant de l'utiliser pour un vrai client.
