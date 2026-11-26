# Proprigo v1.9.0 — 11 améliorations

## Client
- **Avec qui ?** À la réservation, le client choisit une intervenante déjà venue chez lui (sa préférée est cochée d'office) ou « Peu importe ». Les créneaux ★ montrent quand elle est libre.
- **Pourboire** sur un ménage terminé (2, 5, 10 € ou autre, jusqu'à 50 €), dans les 30 jours. Payé par carte (Stripe), reversé à 100 % : ajouté au versement des indépendantes, dans l'export de paie des salariées. L'intervenante est prévenue (e-mail + notification).
- **Rappel la veille** à partir de 17 h (plus jamais la nuit) : e-mail + notification, au client (« pensez aux clés ou au code ») et à l'intervenante.

## Intervenante
- **Documents qui expirent** (titre de séjour, attestation URSSAF : 6 mois par défaut, assurance) : date « valable jusqu'au », alertes à 30 jours et 7 jours (elle + vous), et à l'expiration plus de nouvelles missions jusqu'à validation de la nouvelle version. Bouton « Envoyer la nouvelle version ».
- **Relevé mensuel** (Mes gains › Historique › 📄 Relevé) : missions, heures, bonus Platine, pourboires, versements reçus ; imprimable en PDF.
- **Langues** : français, português, español, العربية (de droite à gauche), choix en haut de l'espace. Les messages, consignes et adresses ne sont jamais traduits ; les messages rapides envoyés au client restent en français.
- **Itinéraire de la journée** : Google Maps avec toutes les adresses du jour dans l'ordre (à partir de 2 missions).

## Admin
- **Absence non prévenue** (bouton sur la réservation, le jour même ou après) : la mission repart à attribuer, l'intervenante est prévenue, et pas de Platine pendant 6 mois.
- **Paie des salariées** (Paiements › CSV) : ménages, heures, dont dimanches et jours fériés, niveau, prime Platine, pourboires, absences, congés.
- **Virement groupé SEPA** : l'indépendante enregistre son IBAN (vérifié, vous êtes prévenu à chaque changement) ; un fichier à importer dans votre banque ; puis « tout marquer versé ». Ajoutez l'IBAN de Proprigo dans `config/entreprise.json` (champs `iban` et `bic`).
- **Notes partagées** : une note sur un client peut être montrée à l'intervenante sur ses missions chez lui (« 📝 À savoir »), jamais au client.

# v1.9.1 — tarif des indépendantes
- Tarif proposé par défaut aux nouvelles indépendantes : 23 € de l'heure (au lieu de 24 €).
- Le responsable peut changer le tarif d'une indépendante (Équipe › sa fiche), avec son accord ; elle est prévenue par e-mail.
- Historique des tarifs : chaque ménage est payé au tarif du jour où il a été fait (pas de baisse rétroactive).

## v1.9.2 — prix plus concurrentiels, intervenantes à 22 €

- Ménage à domicile : 36 € de l'heure en Île-de-France (avant 37 €), 34 € ailleurs.
- Abonnement chaque semaine ou toutes les 2 semaines : −10 % (avant −5 %), soit 32,40 € de l'heure. L'étiquette affichée suit la valeur réglée dans « Tarifs et zones ».
- Grand nettoyage : 44 € (avant 42 €), 40 € hors IDF.
- Bureaux : 36 € HT de l'heure en IDF (43,20 € TTC), 34 € HT ailleurs (40,80 € TTC).
- Airbnb : studio 99 €, T2 125 €, T3 152 €, maison 205 € (IDF) ; 93 / 121 / 146 / 195 € ailleurs.
- Tarif proposé aux nouvelles indépendantes : 22 € de l'heure (inscription, ajout par le responsable, aide « Combien vais-je gagner ? »).
- Les réservations déjà faites gardent leur prix. Les indépendantes déjà inscrites gardent leur tarif.
- Attention : si des prix ont déjà été enregistrés dans Administration → Tarifs et zones, ce sont eux qui s'appliquent. Il faut alors y mettre les nouveaux prix.

## v1.9.3 — prêt pour la SASU

- Nouveau modèle `config/entreprise.sasu.exemple.json` : raison sociale, SASU, capital, RCS, SIRET, président, contact, hébergeur.
- Page Mentions légales remplie automatiquement depuis `config/entreprise.json` (le texte « Projet de texte » disparaît quand tout est rempli). L'IBAN et le BIC ne sont jamais affichés.
- Factures et avoirs : « PROPRIGO, SASU au capital de … », RCS et SIRET (déjà gérés, vérifiés par un test).
- La SASU peut rester en franchise de TVA sous 37 500 € par an ; passer `regimeTVA` à « normal » le jour où elle facture la TVA.

## v1.9.4 — corrections d'écrans, étoiles, mode clair, anglais

- Ménage terminé côté client : plus de « Prêt à commencer 0 sur 5 » ; « Ce qui était prévu » si rien n'a été coché.
- Badge « Votre préférée » et bouton « Signaler un problème » ne débordent plus sur téléphone.
- Espace intervenante : le choix de langue est lisible (texte foncé sur fond blanc).
- Mode clair toujours, même si le téléphone est en mode sombre.
- Petites étoiles brillantes en arrière-plan (fixes si le téléphone limite les animations).
- Anglais ajouté pour les intervenantes (avec français, portugais, espagnol, arabe), dates de la semaine et des gains comprises.
- Espace responsable : sa propre page d'aide (tâches courantes de l'administration) au lieu des questions des clients.
- Aide client : la garantie « On revient » sous 48 h est expliquée.

## v1.9.5

- Étoiles de l'arrière-plan plus grandes et plus visibles, plus coupées au bord de l'écran.

## v1.9.6

- Liens Entreprises, Syndics et Agences immobilières en haut : dans le menu et sous le formulaire de l'accueil.
- « ? » et « 48 h » ne passent plus seuls à la ligne.

## v1.9.7

- Accueil : « Vous êtes un professionnel ? » remonté juste après le choix des prestations, avant le code postal.
- Prix avec centimes affichés proprement (43,20 € au lieu de 43,2 €).

## v1.9.8

- Menu : « Particuliers » ajouté, avant Entreprises, Syndics et Agences immobilières.
- « Devenir intervenante » devient « Travailler avec nous » (menu, bas de page, connexion, inscription) ; la page de recrutement précise que femmes et hommes sont les bienvenus.
- Sur ordinateur, le menu tient sur une ligne (icônes seulement sur téléphone).

## v1.9.9

- Espace intervenante, « Ma semaine » sur téléphone : calendrier en pastilles, une icône par type de ménage (🏠 ménage, 🧳 Airbnb, 🧽 grand nettoyage, 🏢 bureaux), nombre de missions du jour, 🌴 pour les congés. On touche un jour pour voir ses missions.
- Les zips ne contiennent plus de dossier .git.

## v1.9.10

- Réservation côté client : l'étiquette suit le ménage en direct (« 🚶 En route », « 📍 Arrivée », « 🧽 En cours ») au lieu de rester sur « Confirmée ».
- Quand le ménage a commencé sans tâche cochée : « Ménage commencé » au lieu de « Prêt à commencer ».
- Message « … est arrivée chez vous, le ménage va commencer. »
- Une fois l'intervenante partie, plus de lien « Annuler » ni « Modifier » ; le serveur refuse l'annulation après l'arrivée (test ajouté).
- Correction : rond vide affiché au-dessus du message de suivi.

## v1.9.11

- Après un bouton ou la mise à jour automatique (toutes les 15 s), la page garde sa position : elle ne remonte plus en haut et ne « saute » plus.
- Les étapes animées (Réservé → Terminé) ne se rejouent plus à chaque mise à jour.
- Correction : l'animation des étoiles de fond modifiait celle des petites étincelles des illustrations.

## v1.9.12

- Mise à jour automatique silencieuse : toutes les 15 s, l'appli vérifie en arrière-plan si quelque chose a changé ; si rien n'a changé, l'écran ne bouge pas du tout (avant, la page était redessinée à chaque fois).
