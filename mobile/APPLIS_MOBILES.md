# Applis Proprigo sur Google Play et l'App Store

Un seul projet (Capacitor) produit les deux applis. Elles ouvrent **https://proprigo.fr** dans un écran natif, avec en plus :
- des **notifications natives** (nouvelle mission, intervenante en route, changement de ménage),
- une **icône** et un **écran de démarrage**,
- une **page « Pas de connexion »** quand le téléphone est hors ligne.

**Bon à savoir.** Quand vous mettez le site à jour (git push), les applis sont à jour aussitôt. Il ne faut renvoyer une nouvelle version aux stores que si vous changez l'icône, le nom ou les réglages natifs.

---

## 0. Ce qu'il faut avant de commencer

| | Google Play | App Store |
|---|---|---|
| Compte | Google Play Console : 25 $ une fois | Apple Developer Program : 99 $ par an |
| Au nom d'une société | numéro D-U-N-S (gratuit) | numéro D-U-N-S (gratuit), site et e-mail @proprigo.fr |
| À votre nom (particulier) | test fermé obligatoire : 12 testeurs pendant 14 jours | pas de test imposé |

**Votre cas (auto-entrepreneur)** : ouvrez les deux comptes **à votre nom** (« Individual » chez Apple, compte « Personnel » chez Google). Pas besoin de D-U-N-S. Votre nom s'affiche comme vendeur. Chez Google, prévoyez vos 12 testeurs (famille, amis, intervenantes) dès le début.
Si vous passez en société plus tard : Apple permet de convertir un compte individuel en compte société (demande au support Apple, avec le D-U-N-S de la société), et Google permet de transférer l'appli vers le compte de la société, sans perdre les utilisateurs ni les avis.

Sur le Mac, installez :
1. **Xcode** (App Store du Mac), puis ouvrez-le une fois pour accepter la licence.
2. **Android Studio** (developer.android.com/studio).
3. **Node.js 22** (nodejs.org, version LTS).
4. **CocoaPods** n'est pas nécessaire avec Capacitor 8.

**À faire AVANT d'envoyer aux stores** (sinon refus) :
- Compléter la **politique de confidentialité** et les **mentions légales** : il ne doit rester aucun texte entre crochets [ ] ni la mention « projet de texte ».
- Créer **deux comptes de démonstration** pour les testeurs d'Apple et de Google : un client et une intervenante validée, avec de vrais mots de passe.
- Retirer `ALLOW_DEMO_WORKERS` de Render.

---

## 1. Créer les projets (une seule fois, sur le Mac)

Dans le Terminal, depuis le dossier du projet :

```
cd proprigo-app/mobile
npm install
npm run setup
```

Cela crée les dossiers `android/` et `ios/`, les icônes et l'écran de démarrage, et branche les notifications côté iPhone.

---

## 2. Android (Google Play)

### 2a. Notifications (Firebase, gratuit)
1. Allez sur console.firebase.google.com, puis « Créer un projet », nommé Proprigo. Google Analytics n'est pas nécessaire.
2. Choisissez « Ajouter une application » puis Android. Nom du package : **fr.proprigo.app**.
3. Téléchargez **google-services.json** et copiez-le dans `mobile/android/app/`.
4. Lancez `npm run sync`.
5. Dans Firebase, ouvrez la roue dentée, puis « Paramètres du projet », « Comptes de service », et « Générer une nouvelle clé privée ». Un fichier JSON se télécharge.
6. Dans **Render**, ouvrez Environment et ajoutez `FCM_SERVICE_ACCOUNT`. Collez **tout le contenu** du fichier JSON.

### 2b. Construire l'appli
1. `npm run android` ouvre Android Studio. Attendez la fin de la synchronisation.
2. Menu **Build**, puis **Generate Signed App Bundle or APK…**, puis **Android App Bundle**.
3. Choisissez « Create new… » pour créer la clé de signature (fichier `.jks`). **Gardez ce fichier et son mot de passe en lieu sûr**, hors de Git (il est déjà ignoré).
4. Choisissez **release**. Le fichier `app-release.aab` est créé dans `android/app/release/`.

### 2c. Play Console
1. Allez sur play.google.com/console, puis « Créer une application » : Proprigo, Français, Application, Gratuite.
2. Sous **Tester puis publier**, ouvrez **Test fermé**, créez une version et envoyez `app-release.aab`.
3. Ouvrez **Intégrité de l'appli**, puis **Signature d'application**. Copiez l'**empreinte SHA-256** du « certificat de clé de signature d'application ».
4. Dans **Render**, ajoutez `ANDROID_CERT_SHA256` avec cette empreinte. Ensuite, https://proprigo.fr/.well-known/assetlinks.json ne doit plus être vide. Ce lien supprime la barre d'adresse et lie l'appli au site.
5. Remplissez la fiche :
   - **Confidentialité** : https://proprigo.fr/#/confidentialite
   - **Suppression du compte** : https://proprigo.fr/suppression-compte
   - **Sécurité des données** : nom, e-mail, téléphone, adresse, photos et historique d'achats sont collectés pour le service. Les données ne sont pas vendues. Elles sont chiffrées en transit. La suppression est possible.
   - **Accès à l'appli** : donnez les comptes de démonstration.
   - **Catégorie** : Maison et intérieur ; **public** : 18 ans et plus.
   - **Captures d'écran** : au moins 2, prises sur téléphone ; **icône 512 px** ; **bannière 1024 × 500**.
6. Compte à votre nom uniquement : invitez 12 testeurs (adresses Gmail), qui doivent garder l'appli **14 jours de suite**, puis demandez l'accès à la production.

---

## 3. iPhone (App Store)

### 3a. Notifications (clé Apple)
1. Allez sur developer.apple.com/account, puis **Certificates, Identifiers & Profiles**.
2. Dans **Identifiers**, cliquez sur « + », puis App IDs et App. Bundle ID : **fr.proprigo.app**. Cochez **Push Notifications**.
3. Dans **Keys**, cliquez sur « + », nommez la clé Proprigo et cochez **Apple Push Notifications service (APNs)**. Téléchargez le fichier `AuthKey_XXXXXX.p8`. **Il ne se télécharge qu'une fois** : rangez-le en lieu sûr.
4. Dans **Render**, ajoutez :
   - `APNS_KEY` : le contenu du fichier `.p8`, y compris les lignes BEGIN et END ;
   - `APNS_KEY_ID` : les 10 caractères affichés à côté de la clé ;
   - `APNS_TEAM_ID` : votre Team ID (en haut à droite du compte développeur) ;
   - `APNS_BUNDLE_ID` : `fr.proprigo.app`.

### 3b. Construire et envoyer
1. `npm run ios` ouvre Xcode.
2. Cliquez sur **App** à gauche, puis ouvrez l'onglet **Signing & Capabilities** :
   - pour **Team**, choisissez votre compte développeur ;
   - cliquez sur **+ Capability** et ajoutez **Push Notifications**.
3. Faites un essai sur votre iPhone branché au Mac : choisissez-le en haut de la fenêtre, puis appuyez sur ▶.
4. En haut, choisissez **Any iOS Device**, puis le menu **Product** et **Archive**. Quand c'est fini, cliquez sur **Distribute App** puis **App Store Connect**.

### 3c. App Store Connect
1. Allez sur appstoreconnect.apple.com, ouvrez **Apps**, puis « + » et **Nouvelle app** : Proprigo, Français, Bundle ID fr.proprigo.app.
2. Utilisez **TestFlight** pour essayer l'appli sur votre iPhone avant de l'envoyer.
3. Remplissez la fiche :
   - captures 6,9 pouces (iPhone 16 Pro Max ou équivalent) ;
   - description, mots-clés, URL d'assistance et URL de confidentialité ;
   - **Confidentialité de l'app** : mêmes données que pour Google, liées à l'identité, pas de pistage.
4. Dans **Informations pour la vérification**, donnez les comptes de démonstration et ajoutez cette note :
   > Proprigo is a home-cleaning booking service in Paris. Cleaning is a physical service performed at the customer's home, so payment uses Stripe (guideline 3.1.3(e) / 3.1.5(a)). The app provides native push notifications for real-time job status (cleaner on the way, ETA, new job offers for cleaners). Demo client: … / Demo cleaner: …
5. Cliquez sur **Soumettre pour vérification**.

**Risque connu.** Apple refuse parfois les applis qui affichent un site (règle 4.2, « fonctionnalité minimale »). Proprigo a des notifications natives, des espaces client et intervenante, et un suivi en temps réel : c'est ce qui fait la différence. Si Apple refuse quand même, répondez dans App Store Connect en décrivant ces fonctions. On peut aussi ajouter d'autres fonctions natives, par exemple la photo de fin de ménage prise avec l'appareil photo, ou Face ID.

---

## 4. Vérifier que tout marche

- https://proprigo.fr/api/health doit afficher `applis: iPhone ok, Android ok`.
- Dans l'appli, connectez-vous et ouvrez « Mon compte ». Appuyez sur **Activer les notifications**, puis **Envoyer une notification de test**.
- Les intervenantes activent les notifications depuis leur espace, rubrique « Notifications sur ce téléphone ».

## 5. Plus tard : nouvelle version native
1. Modifiez ce qu'il faut (icône dans `mobile/assets/`, ou réglages).
2. `npm run icons` si l'icône a changé, puis `npm run sync`.
3. **Android** : augmentez `versionCode` dans `android/app/build.gradle`, puis reconstruisez l'App Bundle.
4. **iPhone** : augmentez « Build » dans Xcode, puis Archive et Distribute.
