# PROPRIGO v1.4.0 — Corrections avant ouverture

Numéros = lignes de la feuille de route.

| N° | Correction |
|---|---|
| 7, 8 | Après un paiement Stripe confirmé, le client reçoit « Réservation confirmée » (montant, date, adresse, numéro de facture). Une seule fois, même si Stripe renvoie l'événement. |
| 12 | Chaque nouvelle réservation (payée, réglée par crédit, ou en démo) envoie « Nouvelle réservation n° … à attribuer » aux responsables. Une seule fois. |
| 24 | Une même demande (même prestation, adresse, date, heure, dans les 30 min) ne crée jamais deux réservations : double clic, deux onglets, retour arrière, récurrentes comprises, crédit utilisé ou non. Avec Stripe, le client retrouve le paiement en cours. |
| 35 | Factures numérotées sans trou, par année : F2026-000001, F2026-000002… émises au paiement. Chaque remboursement (total ou partiel) crée un avoir A2026-000001 lié à la facture. Mentions : vendeur, client, désignation, HT, taux et montant de TVA, TTC, date d'acquittement, mentions B2B (pénalités, indemnité de 40 €). Les réservations déjà payées reçoivent leur facture au démarrage. Bouton « Facture » dès le paiement. **À remplir : `config/entreprise.json`** (raison sociale, adresse, SIRET, TVA…). `/api/health` affiche `factures: à compléter` tant que ce n'est pas fait. |
| 4 | Confirmation de l'adresse e-mail : lien dans l'e-mail de bienvenue (valable 7 jours, usage unique). En production, réserver exige une adresse confirmée ; une candidate ne peut pas être activée sans. Bandeau « Renvoyer le lien » (3 par heure). Les comptes existants sont considérés confirmés. |
| 13 | E-mails : 2 nouveaux essais immédiats si le fournisseur ne répond pas, puis file d'attente gardée en base (5 min, 15 min, 1 h, 3 h, 6 h). Même clé à chaque essai chez Resend : jamais deux envois du même e-mail. Erreur définitive (adresse refusée) notée au journal. État visible dans Admin › Suivi › E-mails. |
| 45 | Audit automatique des accès (`test/acces.test.js`) : les 90 routes essayées par un visiteur, un autre client, une intervenante et un planificateur. Aucun accès anormal trouvé. Le test casse si une route s'ouvre un jour par erreur. |
| 50, 56 | Polices Inter et Outfit hébergées sur le site (licence OFL, fichiers dans `public/fonts`) : plus aucune requête vers Google, donc plus d'adresse IP transmise. Fichiers compressés (app.js : 173 Ko → 47 Ko) ; une page déjà visitée n'est pas retéléchargée. |
| 51 | Surveillance : toute panne du serveur est gardée en base et envoyée par e-mail aux responsables (une alerte par heure au plus). `/api/health` affiche `erreurs24h`. |

## Tests
`npm test` : 79/79, dont `test/lancement-v140.test.js` (8) et `test/acces.test.js`.
Vérifié dans un navigateur en mode production : bandeau, lien de confirmation, facture.

## À faire de votre côté
1. Remplir `config/entreprise.json` avec votre expert-comptable, puis redéployer.
2. Surveillance externe gratuite (UptimeRobot ou Better Stack) sur `https://proprigo.fr/api/health`, toutes les 5 minutes, alerte par e-mail ou SMS.
3. Faire valider par l'expert-comptable : taux de TVA, traitement du crédit (carte cadeau, parrainage) sur les factures.
