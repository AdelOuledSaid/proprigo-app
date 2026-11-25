# Proprigo v1.6.0 — 12 améliorations

## Côté client
- **Satisfait ou on revient** : 48 h après la fin d'un ménage, bouton « On revient ». L'équipe reçoit l'alerte et planifie un retour gratuit (sans facture).
- **Vrais avis sur l'accueil** : seulement ceux que les clients acceptent de publier (case à cocher), affichés à partir de 3 avis. Masquables par l'admin (onglet Suivi).
- **Suivi le jour J** : l'intervenante indique en partant dans combien de temps elle arrive ; le client voit « arrivée estimée vers 10:25 ».
- Notifications sur téléphone (Mon compte).

## Côté intervenante
- Planning de la semaine en grille (missions, propositions, congés, disponibilités).
- Notifications sur téléphone pour les nouvelles missions (sur iPhone : ajouter le site à l'écran d'accueil d'abord).
- Gains mois par mois sur 12 mois, avec ce qui a déjà été viré.

## Côté admin
- Planning : pendant le glisser-déposer, les cases possibles s'affichent en vert et les impossibles en rouge.
- Export comptable : factures et avoirs du mois en CSV (Excel) et en version imprimable (onglet Paiements).
- Relances automatiques des clients inactifs (45 jours par défaut, au plus une fois tous les 120 jours, lien de désinscription). Réglages et aperçu dans l'onglet Suivi.

## Pour vendre plus
- **Services à la personne** (onglet Tarifs et zones) : une fois la déclaration faite, cochez la case et saisissez le numéro SAP. Alors seulement le site affiche les prix après crédit d'impôt, les factures portent la mention légale et l'attestation annuelle devient officielle.
- **Avance immédiate URSSAF** : les clients peuvent demander à être prévenus (Mon compte) ; le nombre d'intéressés s'affiche dans l'admin. Le paiement à 50 % lui-même nécessite l'habilitation URSSAF et ses identifiants API : il sera branché quand vous les aurez.
- Pages **/#/recrutement**, **/#/syndics**, **/#/agences** avec formulaire de devis.

## Variables facultatives
- VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY : sinon générées automatiquement et gardées en base.

# v1.8.0 — niveaux des intervenantes
- 🔵 Bleu au départ, 🥇 Or (25 ménages, note 4,6) : priorité sur les missions, 💎 Platine (75 ménages, note 4,8) : priorité + 1 € de l'heure.
- La note compte à partir de 5 avis ; la plus mauvaise note est mise de côté.
- Priorité : à distance comparable (3 km d'avance pour l'Or, 6 km pour le Platine).
- Badge visible des clients sur la fiche de l'intervenante ; carte « Mon niveau » avec la progression dans l'espace intervenante.
- Réglages (seuils et bonus) dans l'admin, onglet Tarifs et zones. Le bonus Platine remplace l'ancien « bonus qualité ».
- Salariées : le bonus Platine est à ajouter sur la fiche de paie (le site l'indique, il ne fait pas la paie).

# v1.8.1 — photos des intervenantes
- Chaque intervenante peut ajouter sa photo (Compte › Ma présentation aux clients). Recadrée en carré, affichée en petit cercle.
- La photo n'est montrée aux clients qu'après accord de l'équipe (admin › Équipe : ✅ Accepter / ✖️ Refuser, e-mail aux responsables à chaque nouvelle photo).
- Seuls les clients qui ont une réservation avec elle voient sa photo.
- Les clients voient « Prénom + initiale » (ex. Fatima K.), jamais le nom de famille complet, y compris dans les données envoyées.
- Bande des étapes déplacée tout en haut de l'accueil, sous le titre.
