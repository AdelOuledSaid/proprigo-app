# PROPRIGO v1.3.0 — Corrections de l'audit

| Priorité | Constat | Correction |
|---|---|---|
| Haute | Données privées dans le ZIP | `.gitignore` élargi (`*.db`, sauvegardes, `outbox`, photos, `.env*`). Nouvelle commande `npm run package` : archive du code par `git archive`, refusée si une donnée privée est suivie par Git. |
| Haute | Pas de contrôle d'origine (CSRF) | Toute requête API autre que GET doit venir du site (`Origin`, sinon `Referer`, sinon `Sec-Fetch-Site`). En plus du cookie `SameSite=Lax` et du JSON obligatoire. Le webhook Stripe reste protégé par sa signature. |
| Moyenne | Tentatives de connexion en mémoire | Table SQLite `login_attempts` : conservée après redémarrage. Trois limites : 5 erreurs adresse + compte → 10 min ; 20 erreurs sur un compte → 1 h ; 50 erreurs depuis une adresse → 1 h. Vraie adresse du visiteur derrière Render (`X-Forwarded-For`). |
| Moyenne | Airbnb désactivé en production | Réactivé quand Stripe est actif : chaque départ détecté crée un ménage **à payer**, sans intervenante. Le client reçoit un message et un e-mail « Payer ce ménage ». L'attribution n'est possible qu'après paiement (règle déjà existante). Un séjour disparu n'annule toujours rien. Sans Stripe, la synchronisation reste suspendue. |
| Moyenne | Photos nettoyées au démarrage seulement | Nettoyage au démarrage puis toutes les 24 h (et purge des anciennes tentatives de connexion). |
| Moyenne | Sauvegardes locales | Chaque sauvegarde est vérifiée (essai d'ouverture et contrôle d'intégrité). Copie externe chiffrée AES-256 vers un stockage compatible S3 (R2, B2…), jamais en clair. Téléchargement chiffré depuis l'admin. `npm run verify-backup` pour tester une restauration. Voir `SAUVEGARDES.md`. |

## Tests
`npm test` : 71/71, dont 7 nouveaux (`test/audit-v130.test.js`). La signature S3 est validée sur l'exemple officiel d'AWS.
Connexion vérifiée dans un vrai navigateur en mode production avec le contrôle d'origine.
Non testé en conditions réelles : l'envoi vers un vrai bucket R2 (à faire après configuration).
