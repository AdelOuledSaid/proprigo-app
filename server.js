'use strict';
// Démarrage : node server.js   (Node.js 22.13 ou plus récent, aucune installation nécessaire)
const [MAJ, MIN] = process.versions.node.split('.').map(Number);
if (MAJ < 22 || (MAJ === 22 && MIN < 13)) {
  console.error(`Votre version de Node.js (${process.versions.node}) est trop ancienne.`);
  console.error('Installez la version LTS depuis https://nodejs.org (22.13 ou plus récente), fermez cette fenêtre, rouvrez-la et relancez npm start.');
  process.exit(1);
}
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'proprigo.db');
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'proprigo-admin';

if (PROD && !process.env.ADMIN_PASSWORD) {
  console.error('En production, définissez ADMIN_PASSWORD (12 caractères minimum).');
  process.exit(1);
}
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const { server, reportError } = createApp({
  dbFile: DB_FILE, adminPassword: ADMIN_PASSWORD, seed: !PROD || process.env.SEED === '1', secureCookies: PROD,
  production: PROD, paymentsEnabled: process.env.PAYMENTS_ENABLED === 'true', // activer uniquement après configuration Stripe et tests
  autoSync: true, // calendriers Airbnb relus toutes les 6 heures, rappels envoyés la veille
  appUrl: process.env.APP_URL || `http://localhost:${PORT}`,
  // E-mails : RESEND_API_KEY (ou MAIL_PROVIDER + MAIL_API_KEY) et EMAIL_FROM (ou MAIL_FROM).
  mail: {
    provider: process.env.MAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : process.env.BREVO_API_KEY ? 'brevo' : undefined),
    apiKey: process.env.MAIL_API_KEY || process.env.RESEND_API_KEY || process.env.BREVO_API_KEY,
    from: process.env.MAIL_FROM || process.env.EMAIL_FROM,
    replyTo: process.env.MAIL_REPLY_TO || process.env.EMAIL_REPLY_TO, // facultatif : où arrivent les réponses des clients
  },
  googleReviewUrl: process.env.GOOGLE_REVIEW_URL || '', // lien « laisser un avis » de votre fiche Google
  adminEmail: process.env.ADMIN_EMAIL || '', // vraie adresse du responsable (connexion et alertes)
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups'), // une sauvegarde par jour, 14 gardées
});
server.listen(PORT, () => {
  console.log(`Proprigo tourne sur http://localhost:${PORT}`);
  if (PROD && !(process.env.MAIL_PROVIDER || process.env.RESEND_API_KEY || process.env.BREVO_API_KEY)) console.warn('ATTENTION : aucun service d\'e-mail configuré (RESEND_API_KEY) : aucun e-mail ne part.');
  if (PROD && !process.env.ADMIN_EMAIL) console.warn('Conseil : définissez ADMIN_EMAIL (ex. contact@proprigo.fr) pour recevoir les alertes du site.');
  if (PROD && process.env.ALLOW_DEMO_WORKERS === 'true') console.warn('ATTENTION : ALLOW_DEMO_WORKERS=true en production. Supprimez cette variable une fois les profils de test créés.');
  if (!PROD) console.log('Comptes de démonstration : voir README.md');
});

// Erreur non rattrapée : gardée en base et signalée au responsable par e-mail.
// Pour une exception, le processus s'arrête ensuite proprement : Render le relance tout seul.
process.on('unhandledRejection', (err) => reportError('tâche de fond', err));
process.on('uncaughtException', (err) => {
  reportError('arrêt imprévu du serveur', err);
  setTimeout(() => process.exit(1), 3000).unref();
});
