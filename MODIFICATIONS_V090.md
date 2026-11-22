# PROPRIGO v0.9.0 — nouvelle interface « ça brille »

Interface seulement : la logique Stripe, l'attribution manuelle et le serveur ne changent pas.

- Illustrations originales (façade parisienne avant / après, seau, étoiles corail) dans `public/art.js`.
- Grand panneau bleu en tête de chaque espace : prochain ménage (client), missions du jour (intervenante), choses à traiter (administration).
- Jauge « ça brille » qui avance avec la checklist, visible par l'intervenante et par le client pendant le ménage.
- Barre d'onglets en bas de l'écran sur téléphone, adaptée à chaque rôle ; « Se déconnecter » dans Mon compte.
- Tuiles illustrées pour les prestations, statuts avec pastille de couleur, champs et boutons plus confortables au doigt.
- Animation discrète des étoiles, désactivée si le téléphone demande moins d'animations.

## Déploiement

`npm test`, puis `git add .`, `git commit -m "Nouvelle interface v0.9"`, `git push origin main`.
