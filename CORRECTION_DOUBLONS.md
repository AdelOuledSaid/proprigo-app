# PROPRIGO - Correction des doublons

- Les anciennes tentatives annulees pour paiement echoue sont masquees de « Mes reservations », mais restent en base pour audit.
- Une prestation simple strictement identique creee dans les 30 dernieres minutes reutilise sa reservation non payee.
- Si une session Stripe precedente est encore ouverte, son URL est reutilisee au lieu de creer une nouvelle session.
- Si le paiement est deja confirme, une nouvelle tentative identique est refusee durant cette fenetre.
- Si l'etat de Stripe est inconnu, aucun second paiement n'est cree.
- Les autres annulations, remboursements, historiques admin et reservations recurrentes restent conserves.

## Deploiement

Copier les fichiers du ZIP par-dessus le projet existant, sans remplacer .git, data/ ou .env.
Executer `npm test`, puis `git add .`, `git commit -m "Correction doublons reservations"`, `git push origin main`.
Verifier le deploiement Render et effectuer uniquement des paiements en mode test.
