# Sauvegardes PROPRIGO

## Ce qui se passe tout seul
- Une sauvegarde par jour sur le disque Render (`/var/data/backups`), les 14 dernières gardées.
- Chaque sauvegarde est **vérifiée** juste après sa création : elle est ouverte et son intégrité est contrôlée.
- Si le stockage externe est configuré, elle est **chiffrée** (AES-256) puis envoyée hors de Render.
- État visible dans l'admin (onglet Suivi → Sauvegardes) et sur `/api/health` (`backup`, `backupExterne`).

## Configurer la copie externe (Cloudflare R2, environ 10 minutes, gratuit jusqu'à 10 Go)
1. Cloudflare → R2 → « Créer un bucket », nom : `proprigo-sauvegardes`. Ne le rendez pas public.
2. R2 → « Gérer les jetons d'API R2 » → créer un jeton **Lecture et écriture d'objets**, limité à ce bucket.
   Notez l'ID de clé d'accès, la clé secrète et l'URL du point de terminaison `https://<compte>.r2.cloudflarestorage.com`.
3. Render → votre service → Environment, ajoutez :
   - `BACKUP_S3_ENDPOINT` = `https://<compte>.r2.cloudflarestorage.com`
   - `BACKUP_S3_BUCKET` = `proprigo-sauvegardes`
   - `BACKUP_S3_ACCESS_KEY` = l'ID de clé d'accès
   - `BACKUP_S3_SECRET_KEY` = la clé secrète
   - `BACKUP_ENCRYPTION_KEY` = une longue phrase secrète (20 caractères minimum)
4. Enregistrez (Render redémarre), puis Admin → Sauvegardes → « Sauvegarder maintenant ».
   Le message « Copie externe chiffrée envoyée le… » doit apparaître et le fichier `proprigo/proprigo-….db.enc` doit être visible dans R2.

**Gardez `BACKUP_ENCRYPTION_KEY` ailleurs que sur Render** (gestionnaire de mots de passe) : sans elle, les copies sont illisibles, même pour vous.
Autres fournisseurs compatibles S3 : Backblaze B2, Scaleway, OVHcloud, AWS (renseignez alors aussi `BACKUP_S3_REGION`).

## Sans stockage externe
Avec `BACKUP_ENCRYPTION_KEY` définie, le bouton « Télécharger la dernière (chiffrée) » apparaît dans l'admin.
Téléchargez une copie chaque semaine et gardez-la sur un autre support.

## Tester une restauration (une fois par mois)
Sur votre ordinateur, dans le dossier du projet :
```
set BACKUP_ENCRYPTION_KEY=votre-phrase-secrete        (Windows)
export BACKUP_ENCRYPTION_KEY='votre-phrase-secrete'   (Mac / Linux)
npm run verify-backup -- chemin/vers/proprigo-20261123-0300.db.enc
```
Le message attendu est « Restauration réussie : N comptes, N réservations… ». La base du site n'est jamais touchée.

## Restaurer vraiment (en cas de perte)
Ne restaurez jamais une sauvegarde par-dessus une production qui fonctionne. En cas de perte du disque :
1. Déchiffrez la copie (le script ci-dessus la contrôle d'abord).
2. Arrêtez le service Render, déposez le fichier à la place de `/var/data/proprigo.db` (shell Render), puis redémarrez.
3. Les paiements Stripe postérieurs à la sauvegarde sont à rapprocher depuis le tableau de bord Stripe.
