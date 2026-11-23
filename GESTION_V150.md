# PROPRIGO v1.5.0 — Outils de gestion

Numéros = lignes de la feuille de route.

## Documents des intervenantes et refus de candidature (n° 18, 19)
- Espace intervenante › « Mes documents » : dépôt en PDF, JPEG ou PNG (5 Mo maximum). Le contenu réel du fichier est vérifié, pas seulement son nom.
- Pièces demandées :
  - salariée : identité, sécurité sociale, RIB ;
  - indépendante : identité, SIRET (INSEE ou Kbis), attestation de vigilance URSSAF de moins de 6 mois, assurance RC pro, RIB ;
  - casier judiciaire facultatif.
- Admin › Équipe › Fiche : « Ouvrir », « Valider », « Refuser » (raison obligatoire, envoyée à l'intervenante par e-mail). « À traiter » signale les documents à vérifier.
- En production, une intervenante ne peut pas passer « Active » tant que toutes les pièces obligatoires ne sont pas validées.
- Fichiers privés (dossier `documents/` à côté de la base, hors du site public), visibles seulement par l'intervenante et le responsable. Chaque consultation par le responsable est notée au journal.
- « Refuser la candidature » : raison interne (jamais envoyée), message neutre à la candidate. Plus aucun dépôt possible. Documents supprimés automatiquement 30 jours après.

## Paiements et remboursements (n° 42)
Admin › onglet « Paiements », mois par mois :
- chaque paiement avec sa facture, chaque remboursement avec son avoir, les doublons bloqués ou remboursés, les contestations ;
- totaux : encaissé par carte, crédit Proprigo utilisé, remboursé, net, TVA ;
- « Exporter pour le comptable (CSV) » : fichier ouvrable dans Excel, avec les accents.

## Contestations bancaires (n° 43)
- Nouveaux événements Stripe gérés : `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated`.
- À l'ouverture d'une contestation :
  - e-mail au responsable avec le montant, le motif et la date limite de réponse ;
  - alerte au journal ;
  - réclamation ajoutée sur la réservation.
- « Dossier de preuve » : une page à enregistrer en PDF et à joindre à la réponse dans Stripe. Elle reprend la réservation, la date de commande, le paiement et la facture, l'intervenante, les heures « en route » et « arrivée », les tâches cochées, les photos, les messages et l'historique.
- « Répondre dans Stripe » ouvre la contestation dans le tableau de bord Stripe.
- À la clôture, un e-mail annonce « gagnée » ou « perdue ».

## Statistiques (n° 41)
Admin › « Chiffres », sur 12 mois, avec un graphique :
- CA net TTC et HT, remboursements, panier moyen ;
- ménages réalisés et heures ;
- annulations et taux d'annulation (les paiements abandonnés ne comptent pas) ;
- nouveaux clients et clients actifs ;
- répartition du chiffre d'affaires par prestation.

Avec Stripe, le chiffre d'affaires vient des factures. En démonstration, il est théorique.

## Tarifs et zones (n° 44)
Admin › « Tarifs et zones » :
- prix Île-de-France et hors Île-de-France ;
- suppléments dimanche et urgence, remise abonnement, matériel ;
- départements ouverts.

Règles :
- Un prix qui ne couvre pas le coût d'une heure (21,09 € HT, `config/couts.json`), remise abonnement comprise, est refusé. Un forfait Airbnb à marge négative aussi.
- Les nouvelles réservations suivent tout de suite la nouvelle grille, ainsi que l'accueil, les pages Google et les CGV. Les réservations existantes gardent leur prix.
- Historique des changements et ligne au journal. « Revenir aux prix d'origine » remplit le formulaire avec la grille de départ.

## À faire sur Stripe
Webhook `/api/stripe/webhook` › ajouter les événements `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`.

## Tests
`npm test` : 83/83, dont `test/gestion-v150.test.js` (4). L'audit des accès couvre les nouveaux écrans, réservés au responsable.
Vérifié dans un navigateur : espace intervenante (mobile), fiche de la candidate, statistiques, paiements, tarifs.

## v1.5.1 — retours
- Candidate : le calendrier des disponibilités et les congés ne s'affichent plus avant l'acceptation. Elle voit seulement sa candidature et « Mes documents ».
- Acceptation : e-mail « Votre candidature est acceptée » avec le bouton « Régler mes disponibilités ».
- Liste des pièces demandées modifiable : Admin › Équipe › « Pièces demandées aux intervenantes ». On peut ajouter, renommer et retirer une pièce, la demander aux salariées, aux indépendantes ou aux deux, et la rendre obligatoire ou facultative. Les pièces déjà validées restent valables.
- Champs sans type (Nom, Code postal, Téléphone…) : même style partout.
