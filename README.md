# Proprigo — application, phase 1

Première version de la plateforme Proprigo : ménage à la demande, avec trois espaces (client, intervenante, administrateur).

Elle fonctionne avec **Node.js seul** : aucune bibliothèque à installer.

## Démarrer sur votre ordinateur

1. Installez Node.js version 22.13 ou plus récente (https://nodejs.org, version « LTS »).
2. Décompressez ce dossier, ouvrez un terminal dedans, puis tapez :

```
npm start
```

3. Ouvrez http://localhost:3000 dans votre navigateur.

Pour lancer les tests automatiques : `npm test`.

## Comptes de démonstration

Créés automatiquement au premier démarrage (base vide), uniquement hors production.

| Rôle | E-mail | Mot de passe |
|---|---|---|
| Administrateur | admin@proprigo.test | proprigo-admin |
| Cliente | claire@proprigo.test | demo-proprigo |
| Salariée (11e) | fatima@proprigo.test | demo-proprigo |
| Salariée (18e) | aissata@proprigo.test | demo-proprigo |
| Indépendante (20e) | ines@proprigo.test | demo-proprigo |
| Indépendante (92) | lucia@proprigo.test | demo-proprigo |
| Candidate en recrutement | mariam@proprigo.test | demo-proprigo |

Les données sont dans `data/proprigo.db`. Supprimez ce fichier pour repartir de zéro.

## Ce que fait cette version

**Client**
- Création de compte et connexion.
- Réservation : ménage à l'heure, grand nettoyage ou forfait Airbnb, code postal, date, heure, adresse.
- Prix calculé par le serveur avec la grille validée : Île-de-France (75, 77, 78, 91, 92, 93, 94, 95) un peu plus chère, une seule grille pour le reste de la France. Suppléments dimanche et jours fériés (+20 %, jours fériés calculés pour toutes les années), urgence pour une arrivée dans les 3 prochaines heures (+25 %), option matériel fourni (+15 €, pas pour Airbnb).
- Hors Île-de-France : prix indicatif et inscription sur la liste d'attente.
- Suivi des réservations, annulation avant le début (la réservation passe « à rembourser »), note de 1 à 5.
- **Paiement simulé** : aucune carte n'est débitée et aucun argent n'est encaissé. En production (`NODE_ENV=production`), les réservations sont **bloquées** tant que le vrai paiement n'est pas branché.

**Intervenante**
- Candidature en ligne : salariée ou indépendante, avec le minimum d'informations (RGPD).
- Suivi des étapes de recrutement. Aucune mission avant l'activation par l'équipe.
- Salariée : missions attribuées par le planning. Indépendante : propositions qu'elle accepte ou refuse sans pénalité, adresse exacte visible seulement après acceptation.
- Commencer et terminer une mission, heures ou montant facturé du mois.

**Administrateur**
- Chiffre d'affaires HT et marge estimée sur **toutes** les missions terminées, montant à rembourser, note moyenne.
- Hypothèses de marge (coût salariée, TVA, produits) dans `config/couts.json`, à faire valider par l'expert-comptable.
- Liste des réservations, choix direct de l'intervenante parmi celles libres à cette heure-là, suivi des remboursements.
- Équipe : validation des étapes de recrutement, absence avec remplacement automatique.
- Liste d'attente par département, journal de toutes les décisions.

**Attribution automatique** (`src/engine.js`) : salariée active, libre à cette heure-là (30 min de trajet entre deux missions) et la plus proche, sinon proposition aux 3 indépendantes les plus proches, sinon alerte à l'équipe. Maximum 3 missions par jour. La distance est **approximative** (centre de l'arrondissement ou du département) : un calcul à l'adresse exacte viendra avec l'API Adresse et un calcul d'itinéraire.

## Ajouté dans la version 0.2

1. **Réservations récurrentes** : chaque semaine ou toutes les 2 semaines (4, 8 ou 12 ménages réservés d'avance), avec la même intervenante quand elle est libre. Le client peut arrêter la récurrence : les ménages à venir sont annulés et passent « à rembourser ».
2. **Modification d'une réservation** : date, heure, durée, adresse, jusqu'à 24 h avant. Le prix est recalculé (l'écart est noté dans le journal), la disponibilité vérifiée, et l'intervenante gardée si elle est libre.
3. **Disponibilités des intervenantes** : horaires par jour de la semaine et congés. Le client ne voit que les heures où une intervenante peut réellement venir ; une réservation sans intervenante libre est refusée. Un congé confie automatiquement les missions concernées à une autre intervenante. Nouvelles intervenantes : lundi au samedi, 8 h–18 h par défaut.
4. **Photos avant / après** : seulement si le client l'accepte à la réservation. Visibles par le client, l'intervenante et l'équipe uniquement ; supprimées automatiquement après 90 jours ; 12 maximum par ménage, JPEG ou PNG vérifiés. Au moins une photo « après » est demandée pour terminer. **Signaler un problème** : le client écrit à l'équipe qualité, qui voit les signalements dans le tableau de bord.
5. **Messagerie par réservation** entre client, intervenante et équipe. Les numéros de téléphone et e-mails tapés dans un message sont masqués, et l'intervenante ne voit plus le téléphone du client. Réponses rapides pour l'intervenante (retard, arrivée, accès impossible).
6. **Checklist** : tâches par défaut selon la prestation, modifiables par le client (ajout ou retrait), reprises automatiquement pour la même adresse. L'intervenante coche ce qui est fait ; le client voit le résultat.

Les photos sont enregistrées dans `data/photos/`.

## Ajouté dans la version 0.3

- **Intervenante préférée** : après un ménage, le client peut garder l'intervenante (« ★ Garder … pour mes prochains ménages »), pour tous ses ménages ou pour un logement précis. Elle est choisie en priorité quand elle est libre. Ordre de priorité : intervenante de la récurrence, puis celle du logement, puis la préférée du client.
- **Garantie de remplacement** : si l'intervenante prévue devient indisponible (absence, congé, refus, changement par l'équipe), une remplaçante vérifiée est cherchée automatiquement et le client reçoit un message de « Équipe Proprigo » : une autre intervenante vérifiée viendra, ou il peut choisir un autre créneau pour garder la sienne.
- **Choix du client** : si son intervenante préférée n'est pas libre, le client le voit au moment de réserver (avec les heures où elle est libre ce jour-là) et sur la réservation (bouton « Voir quand … est libre », qui propose les créneaux des 14 prochains jours et déplace la réservation en un clic).
- **Espace propriétaires** (« Mes logements ») : plusieurs logements avec adresse, type de ménage, consignes pour l'intervenante (visibles seulement par celle qui a la mission), checklist, photos, intervenante préférée et heure de départ des voyageurs. Bouton « Réserver un ménage » qui préremplit tout.
- **Calendrier Airbnb** : collez le lien d'export iCal de l'annonce (Airbnb, Abritel, Booking). Chaque départ de voyageurs dans les 60 jours crée un ménage à l'heure de départ ; un séjour annulé annule le ménage et prévient le client. Synchronisation automatique toutes les 6 heures, ou à la demande. Seuls les liens https de ces plateformes sont acceptés.

## Ajouté dans la version 0.7

- **Téléphone** : bandeau compact (logo, bouton « Réserver » pour les clients, bouton « Menu »), disponibilités en grandes cases avec interrupteur par jour, administration en onglets (À traiter, Réservations, Équipe, Chiffres, Suivi), journal filtrable par type et par numéro de réservation.
- **Créneaux plus justes** : le temps de trajet entre deux missions dépend maintenant de la distance (30 min minimum, environ 4 min par km) ; le jour même, un ménage se réserve au moins 1 h à l'avance.
- **Indépendantes** : une mission proposée reste « Recherche en cours », sans intervenante, jusqu'à son acceptation. Une proposition en attente bloque l'horaire : la même indépendante ne reçoit plus deux propositions qui se chevauchent, et ne peut pas accepter une mission si elle est déjà prise à cette heure-là.
- **Journal** : une ligne identique écrite dans les 10 minutes précédentes n'est plus répétée.

## Ajouté dans la version 0.6 (suite de l'audit)

- **Calendriers Airbnb : plus aucune annulation automatique.** Un séjour absent du calendrier n'est signalé que s'il manque à deux synchronisations d'affilée, à au moins une heure d'écart. Le ménage reste prévu ; le client (« Garder le ménage » / « Annuler le ménage ») ou l'équipe (« Garder » / « Annuler et rembourser ») décide. Si le séjour réapparaît, le signalement disparaît.
- **Téléchargement des calendriers renforcé** : 10 secondes maximum, 1 Mo lu au maximum (même si la taille n'est pas annoncée), pas de redirection, type de contenu vérifié, fichier coupé ou page d'erreur rejeté sans rien modifier, 3 000 événements au maximum, adresses internes refusées (y compris IPv6 et adresses réservées), une synchronisation manuelle toutes les 2 minutes par logement.
- **Sauvegardes** : une par jour dans `data/backups` (les 14 dernières sont gardées), bouton « Sauvegarder maintenant » dans l'administration, commande `npm run backup`. Copiez ce dossier ailleurs régulièrement ; pensez aussi au dossier `data/photos`.
- **Surveillance** : l'adresse `/api/health` répond `{"ok": true}` si la base fonctionne et si la dernière sauvegarde a moins de 48 h (erreur 503 sinon). Faites-la vérifier toutes les 5 minutes par un service de surveillance de site, avec alerte par SMS ou e-mail.

## Ajouté dans la version 0.5

- **Installation sur l'écran d'accueil** : icône Proprigo, ouverture en plein écran, page « Pas de connexion » si le téléphone est hors ligne. Sur iPhone : Safari → Partager → « Sur l'écran d'accueil ». Sur Android : Chrome → ⋮ → « Installer l'application » (fonctionne pleinement une fois le site en HTTPS).
- **Mot de passe oublié** : lien envoyé par e-mail, valable 1 heure et à usage unique (jeton stocké haché, même réponse que le compte existe ou non, 3 demandes par heure au maximum). Les autres appareils sont déconnectés après le changement.
- **Mon compte** : modifier son nom et son téléphone, changer de mot de passe, supprimer son compte client (RGPD : coordonnées, logements et photos effacés ; factures gardées sans coordonnées ; refusé tant qu'un ménage est prévu).
- **Corrections vues sur iPhone** (0.4.1) : réservations en fiches dans l'administration, journal sans doublons et replié, missions à venir repliées, champs de date pleine largeur.

## Ajouté dans la version 0.4

- **Réservation en 4 étapes** : prestation → date et heure (seulement les créneaux libres) → récapitulatif (adresse, durée, options, total TTC, conditions d'annulation) → acceptation des CGV et paiement.
- **Accueil client** : prochain ménage, suivi en 4 étapes (réservé, intervenante confirmée, en cours, terminé), prénom de l'intervenante, et trois actions : Modifier, Contacter, Réserver à nouveau.
- **Règle d'annulation** : gratuite jusqu'à 24 h avant, ensuite 50 % du prix retenu. Le montant à rembourser apparaît dans le tableau de bord.
- **E-mails** : bienvenue, confirmation, modification, annulation, intervenante confirmée ou remplacée, début et fin du ménage, rappel la veille. Sans configuration, ils sont enregistrés dans `data/outbox/` et visibles dans l'administration (« E-mails envoyés »).
- **Reçus** imprimables pour les ménages terminés (« DOCUMENT DE TEST » tant que le paiement est simulé).
- **Intervenante** : missions du jour en premier, grands boutons Commencer / Terminer, missions à venir repliées.
- **Administration** : bloc « À traiter maintenant » (missions des 3 prochains jours sans intervenante avec liste de choix directe, réclamations, absences, remboursements, candidatures) avant les statistiques.
- **Pages d'information** : aide et réclamations, nos intervenantes, CGV, mentions légales, confidentialité (projets à compléter et à faire relire par un avocat), liens en pied de page.

### Envoyer de vrais e-mails

Créez un compte chez Brevo ou Resend, vérifiez votre domaine, puis démarrez avec :

```
MAIL_PROVIDER=brevo MAIL_API_KEY=… MAIL_FROM="Proprigo <bonjour@votre-domaine.fr>" APP_URL=https://votre-domaine.fr npm start
```

(`MAIL_PROVIDER=resend` pour Resend.) Ne mettez jamais la clé dans le code ni dans une conversation.

## Organisation du code

```
server.js          démarrage
src/pricing.js     grille de prix, zones, suppléments, marge estimée
src/checklist.js   tâches par défaut selon la prestation
src/ical.js        lecture des calendriers Airbnb / Abritel / Booking
config/couts.json  hypothèses de coût pour la marge
src/engine.js      attribution des missions
src/db.js          base de données (SQLite intégré à Node.js), étapes de recrutement
src/app.js         serveur web, comptes, API
public/            interface (HTML, CSS, JavaScript)
test/              tests automatiques
```

Pour changer un prix : `src/pricing.js`, objet `GRID`. Pour ouvrir une nouvelle zone : `OPEN_ZONES` et `IDF_DEPTS`.

## Sécurité déjà en place

- Mots de passe chiffrés (scrypt), jamais stockés en clair.
- Session dans un cookie protégé (HttpOnly, SameSite), « Secure » en production.
- Prix toujours recalculé par le serveur : un prix envoyé par le navigateur est ignoré.
- Chaque action vérifie le rôle (un client ne peut pas ouvrir l'espace administrateur).
- Limitation des tentatives de connexion, échappement de tous les textes affichés.

## Avant la mise en ligne (à faire)

1. **Paiement réel** : brancher Stripe (Checkout pour les clients, Connect pour reverser aux indépendantes, webhooks). Aujourd'hui le paiement est simulé et la production refuse les réservations tant qu'il n'est pas branché.
2. **E-mails réels** : configurer Brevo ou Resend (voir plus haut). SMS plus tard.
3. **Hébergement** avec HTTPS et **sauvegarde quotidienne** de `data/` (base + photos). Démarrer avec `NODE_ENV=production ADMIN_PASSWORD=… npm start`.
4. **Textes juridiques** : compléter les passages entre crochets des CGV, mentions légales et politique de confidentialité, puis faire relire par un avocat. Choisir un médiateur de la consommation, souscrire l'assurance RC pro.
5. **Tests sur de vrais téléphones** (iPhone et Android), accessibilité, vitesse.
6. **Test de sécurité** par un professionnel ; mot de passe administrateur long et unique.
7. **Documents de l'entreprise** : statuts, SIRET, déclaration services à la personne (crédit d'impôt), contrats des salariées et des indépendantes.

Plus tard : codes promo et parrainage, application mobile, mot de passe oublié, suivi en direct.
