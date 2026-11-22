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

# v0.9.1 — page d'accueil

- Façade « avant / après » interactive : on glisse pour faire briller l'immeuble (un balayage au chargement montre le geste, supprimé si le téléphone demande moins d'animations ; utilisable au clavier).
- Prix affichés dès l'accueil (grille Île-de-France), sélecteur de taille pour le forfait Airbnb.
- Quatre garanties vérifiables : paiement Stripe, annulation 24 h, intervenantes vérifiées, remplaçante.
- Téléphone de démonstration avec le suivi en direct et la jauge « ça brille ».
- Section hôtes Airbnb et conciergeries, FAQ courte, dernier appel à réserver avec le code postal.
- Aucun avis ni chiffre inventé : à ajouter seulement quand vous aurez de vrais avis clients.

# v0.9.2 — salon haussmannien

- Nouvelle illustration originale en haut de la page d'accueil : salon haussmannien (cheminée en marbre, miroir doré, porte-fenêtre sur les toits de Paris, parquet en point de Hongrie) avec une intervenante en tablier bleu Proprigo.
- Le curseur « avant / après » passe du salon en désordre (vitre ternie, linge sur le fauteuil, tasses, poussière) au salon qui brille.
