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

## v1.10.0 — devis professionnels

- Admin, « Devis professionnels » (toujours visible dans « À traiter ») : pour chaque demande, « 📝 Faire le devis » (prestation, heures par passage, prix de l'heure, fréquence, date de début, message), total calculé en direct, « 📨 Envoyer le devis par e-mail ».
- Numéro de devis D2026-0001…, valable 30 jours, avec vos mentions (raison sociale, SIRET, TVA ou franchise).
- Le client reçoit un e-mail avec un lien : il voit le devis, peut l'imprimer ou l'enregistrer en PDF, et l'accepte en ligne (« Bon pour accord » avec son nom) ou répond par un message.
- Vous êtes prévenu par e-mail ; la demande passe à « ✅ Accepté par … le … » ou « Refusé », avec la réponse du client. Devis modifiable et renvoyable tant qu'il n'est pas accepté. « Classer sans suite » remplace « Traitée ».

## v1.10.1

- Ménage terminé côté client : « ✅ Ce qui a été fait » au lieu de « Ce qui était prévu ».
- Note en pastilles rondes, 5 étoiles proposées d'office ; le client change s'il veut et valide avec « ⭐ Envoyer ma note » (rien n'est envoyé sans son clic).
- Pourboire juste après la note, en cercles 2 €, 5 €, 10 €, Autre ; « Pas satisfait ? On revient » ensuite.
- Accueil : le suivi du jour du ménage ne redessine plus l'écran si rien n'a changé.

## v1.11.0 — après le devis accepté : planifier et faire payer

- Devis accepté : bouton « 📅 Planifier les passages » (adresse, premier passage, heure, nombre de passages ; les dates suivantes se calculent selon la fréquence, 2 fois par semaine = lundi/jeudi…).
- Un espace client est créé pour l'entreprise s'il n'existe pas (lien « Créer mon mot de passe », valable 7 jours).
- Le client reçoit les dates par e-mail et paie par carte dans son espace : passage par passage, ou « 💳 Tout payer en une fois ». Une facture par passage, l'intervenante est choisie après le paiement.
- Le devis passe à « 📅 N passages planifiés ».

## v1.11.1

- « Mes réservations » : l'historique est replié (« 📜 Historique · N ménages · Afficher ») ; seul le dernier ménage terminé à noter (ou encore sous garantie 48 h) reste visible.
- Pourboire replié : « 💝 Laisser un pourboire à … », petits cercles 2 €, 5 €, 10 €, Autre à l'ouverture.

## v1.12.0 — prêt pour l'ouverture

- **Effacer les données de test** (Admin → Suivi, responsable seulement) : réservations, paiements, factures, devis, messages et photos d'essai ; option comptes de démo et comptes clients de test. Sauvegarde automatique juste avant, confirmation « EFFACER ». La prochaine facture repart à F2026-000001. Refusé dès que Stripe est en mode réel (clé sk_live).
- **Virement pour les entreprises** : un client passe en « virement en fin de mois » (Admin → Paiements, ou au moment de planifier un devis). Ses passages sont confirmés sans carte. Début de mois : « 🧾 Facturer octobre » crée une facture par passage et envoie un relevé (référence PROPRIGO-R0001, IBAN, échéance 30 jours). « 💶 Virement reçu : marquer payé » à réception. Le client voit ses relevés dans « Mes réservations » et peut les imprimer en PDF.
- **Intervenant au masculin** : choix Femme / Homme à l'inscription, à la création par le responsable et dans la liste « Équipe ». Les textes côté client s'accordent (« Intervenant vérifié », « votre intervenant préféré », « est arrivé »…).
- **Version anglaise pour les clients** : bouton « 🇬🇧 English » dans le menu pour les visiteurs et les clients (mémorisé). Accueil, pages pros, réservation, mes réservations, logements, compte, aide et dates traduits. L'admin reste en français ; e-mails, CGV et mentions légales restent en français.

## v1.12.1 — devis : le client fait tout seul, de l'accord au paiement

- En acceptant le devis, le client indique l'adresse, le premier passage, l'heure (et le nombre de passages si c'est régulier), choisit le mot de passe de son espace et signe. Les passages sont créés, il est connecté à son espace, puis envoyé directement au paiement par carte (passages du mois à venir).
- Si vous avez coché « Proposer aussi le paiement par virement » dans le devis, il peut choisir le virement : relevé en fin de mois, rien à payer tout de suite.
- S'il a déjà un espace avec cette adresse e-mail, les passages y sont ajoutés.
- Les formulaires de demande de devis expliquent les 3 étapes ; pas besoin de créer un compte avant.
- Vous êtes prévenu par e-mail ; le devis passe directement à « 📅 N passages planifiés ».

## v1.12.2 — prélèvement SEPA par Stripe pour les entreprises

- Devis : la case « Proposer aussi le prélèvement SEPA en fin de mois » permet au client de choisir « Par prélèvement » en acceptant. Il est envoyé sur la page Stripe : il saisit son IBAN et accepte le mandat SEPA (Stripe garde le mandat et lui en envoie une copie). Ses passages sont confirmés dès que Stripe confirme le mandat.
- Admin → Paiements : « Prélèvement SEPA (invitation par e-mail) » pour un client existant ; il reçoit un lien vers la page « Prélèvement » de son espace.
- Début de mois : « 🧾 Facturer » crée les factures, envoie le relevé et lance le prélèvement automatiquement. Le relevé passe à « Payé » tout seul quand Stripe confirme (quelques jours). Prélèvement rejeté : vous et le client êtes prévenus, bouton « 🔁 Relancer le prélèvement ».
- Stripe (une fois) : activer « Prélèvement SEPA » dans Paramètres → Moyens de paiement, et ajouter l'événement payment_intent.payment_failed au webhook.

## v1.13.0 — tableau de bord du mois

- Admin → Chiffres, en haut : chiffre d'affaires, marge (en € et en %), ménages faits, heures, panier moyen, clients servis, avec la comparaison au mois précédent (▲ / ▼).
- « Où va l'argent » : part des intervenantes, des frais (paiement, produits, linge) et de votre marge.
- Ce qui est encore prévu dans le mois (ménages réservés pas encore faits).
- Clients : servis, nouveaux, qui reviennent, comptes créés, abonnés.
- Graphique des 6 derniers mois et détail par prestation. Choix du mois en haut à droite.
- Marge calculée avant cotisations, impôts et frais fixes ; tarif réel de chaque indépendante (historique compris), coût horaire des salariées depuis config/couts.js ; en franchise de TVA, chiffre d'affaires = prix payé.

## v1.13.1 — Audit complet

- Sécurité : l'adresse IP du visiteur ne peut plus être falsifiée (anti-abus fiable).
- Sécurité : 5 inscriptions maximum par heure et par adresse IP.
- Sécurité : le site ne peut plus être affiché dans une autre page (anti-clickjacking) ; HTTPS forcé (HSTS) en production.
- Vitesse : index ajoutés à la base de données (réservations, factures, messages, photos).
- Correction : erreur JavaScript sur la page de connexion après la page d'accueil.
- Accessibilité : libellé ajouté sur le choix de l'intervenant favori.
- CGV : nouvel article 4 bis « Clients professionnels » (devis, prélèvement/virement, 30 jours, pénalités, 40 €).
- Partage : description pour Google et image d'aperçu (WhatsApp, Facebook, SMS…) avec `og.png`.

## v1.13.2 — Notifications début et fin de ménage

- Le client reçoit maintenant une notification sur son téléphone quand le ménage commence et quand il est terminé (avant : e-mail seulement).

## v1.13.3 — Invitation à activer les notifications

- Une petite fenêtre « 🔔 Activer les notifications / Plus tard » s'affiche :
  - pour le client, juste après sa réservation (écran « C'est réservé ! » ou retour du paiement) ;
  - pour l'intervenante, à l'ouverture de son espace.
- Un appui sur « Activer » affiche la demande officielle du téléphone.
- Jamais affichée si c'est déjà activé ou bloqué ; redemandée au plus une fois par semaine, 3 fois maximum.
- Traduite pour les intervenantes (pt, es, ar, en) et les clients (en).

## v1.13.4 — Options de réservation plus claires

- Grand nettoyage : vitres, four et réfrigérateur ne sont plus proposés en option payante (ils sont déjà compris). Un encadré vert le rappelle. Le serveur refuse aussi de les facturer.
- Les options s'appellent « Options en plus », avec la phrase « Chaque option ajoute du temps au ménage, au même prix de l'heure ».
- Chaque option affiche « +1 h de ménage, soit +36 € » et la durée totale s'affiche (ex. 4 h = 3 h + 1 h d'options).
- Case matériel : « on apporte aspirateur et produits » (au lieu de « l'intervenante »).
