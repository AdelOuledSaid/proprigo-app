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

# v1.1.0 — nettoyage de bureaux

- Nouvelle prestation « Nettoyage de bureaux » : 42 € TTC / h en Île-de-France (35 € HT), 39 € TTC / h ailleurs (32,50 € HT). Marge estimée : environ 36 % et 31 %.
- Prestation aux professionnels : TVA à 20 %, affichée au récapitulatif ; pas de crédit d'impôt ; reçu « prestation à un professionnel » ; jamais dans l'attestation fiscale.
- Checklist par défaut adaptée aux bureaux (postes de travail, corbeilles, sanitaires, coin café, salle de réunion, poignées).
- Quatrième tuile sur l'accueil et dans la réservation, quatrième fiche « Nettoyage de bureaux » dans les prix, illustration de bureau.
- Les prix se changent dans `src/pricing.js` (ligne GRID, colonne `bureau`).

# v1.2.0 — croissance : cadeaux, abonnement, options, entreprises, Google, versements

## Gagner plus par client
- **Carte cadeau** (page « Carte cadeau », lien en pied de page et bandeau sur l'accueil) : 50, 100, 150 ou 200 €, payée par Stripe, code envoyé par e-mail au destinataire (ou à l'acheteur), valable 1 an, utilisable une seule fois. Le code est créé seulement quand Stripe confirme le paiement du bon montant.
- **Packs d'heures prépayés** : 10 h payées = 11 h de crédit (370 € → 407 €), 20 h = 23 h (740 € → 851 €).
- **Crédit Proprigo** (parrainage, carte, pack) : déduit automatiquement, jusqu'à 100 % du prix ; un ménage entièrement couvert est confirmé sans passer par Stripe. Annulé, le crédit revient.
- **Abonnement** : chaque semaine ou toutes les deux semaines, −5 %.
- **Options** : repassage (+1 h), vitres intérieures (+1 h), four, réfrigérateur, draps (+0,5 h chacune), au tarif de l'heure ; les tâches s'ajoutent à la checklist.
- **Forfait fin de bail** (grand nettoyage) : taille → durée réglée et checklist de l'état des lieux.

## Entreprises
- Page **« Entreprises »** et **demande de devis** (alerte par e-mail et dans « À traiter », 5 demandes par heure au maximum).
- **Profil société** (Mon compte) : raison sociale, SIRET, TVA, adresse de facturation ; le reçu est « Facturé à » la société.
- **Remise volume** (comptes société, bureaux et Airbnb) : −5 % à partir de 10 prestations dans le mois, −10 % à partir de 30 ; jamais cumulée avec l'abonnement ; calculée par le serveur seulement.
- **Bureaux de 6 h à 22 h** ; ménages jusqu'à 12 h avec les options.

## Visibilité et équipe
- **105 pages pour Google** : ménage à domicile, ménage Airbnb et nettoyage de bureaux, pour les 20 arrondissements de Paris et 15 villes proches (ex. /menage-a-domicile/paris-11), avec plan du site `/sitemap.xml` et `robots.txt`. Le bouton « Voir les créneaux » préremplit le code postal.
- **Avis Google** : après 5 étoiles, invitation à laisser un avis Google. Réglage Render : `GOOGLE_REVIEW_URL` = le lien « Demander des avis » de votre fiche Google.
- **Versements aux indépendantes** (Chiffres) : ce qui est dû par semaine, « Marquer versé » avec la référence du virement, e-mail à l'intervenante, impossible de verser deux fois la même semaine. **Bonus qualité** : +1 €/h pour une note moyenne ≥ 4,8 sur les 10 derniers avis (5 au moins). L'intervenante voit « En attente de versement » et son bonus.

## À faire de votre côté
- Render → Environment : ajouter `GOOGLE_REVIEW_URL`.
- Google Search Console : déclarer le site et envoyer `https://VOTRE-DOMAINE/sitemap.xml`.
- Stripe : rien à changer (le webhook existant gère aussi les cartes cadeaux et les packs).
