# Proprigo v1.7.0 — applis Android et iPhone

- Nouveau dossier `mobile/` : projet Capacitor 8 pour Google Play et l'App Store. Guide pas à pas : `mobile/APPLIS_MOBILES.md`.
- Notifications natives : iPhone (Apple, APNs) et Android (Firebase, FCM), en plus des notifications web existantes.
- `/.well-known/assetlinks.json` : relie l'appli Android au site (variable ANDROID_CERT_SHA256).
- `/suppression-compte` : page publique exigée par les stores.
- Les intervenantes peuvent demander la suppression de leur compte depuis l'appli (exigence Apple).
- À la déconnexion, le téléphone ne reçoit plus les notifications du compte.
- /api/health indique si les notifications des applis sont configurées.

Nouvelles variables Render (facultatives, à ajouter au moment de publier) :
ANDROID_CERT_SHA256, FCM_SERVICE_ACCOUNT, APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (fr.proprigo.app).

## Auto-entrepreneur : factures sans TVA
- `config/entreprise.json` : `regimeTVA: "franchise"`. Les factures portent « TVA non applicable, art. 293 B du CGI », sans ligne HT/TVA ; le site affiche les prix sans « HT/TTC ».
- Raison sociale : votre « Prénom NOM EI » (mention EI obligatoire), adresse, SIRET.
- Alerte e-mail aux responsables à 80 % de 37 500 €, au-delà de 37 500 € puis de 41 250 € (chiffre d'affaires facturé de l'année). /api/health affiche le compteur.
- Le jour où vous passez en société ou à la TVA : mettez `regimeTVA: "normal"` et les infos de la société, puis redéployez. Les anciennes factures restent sans TVA.
