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

const { server } = createApp({
  dbFile: DB_FILE, adminPassword: ADMIN_PASSWORD, seed: !PROD || process.env.SEED === '1', secureCookies: PROD,
  production: PROD, paymentsEnabled: process.env.PAYMENTS_ENABLED === 'true', // activer uniquement après configuration Stripe et tests
  autoSync: true, // calendriers Airbnb relus toutes les 6 heures, rappels envoyés la veille
  appUrl: process.env.APP_URL || `http://localhost:${PORT}`,
  mail: { provider: process.env.MAIL_PROVIDER, apiKey: process.env.MAIL_API_KEY, from: process.env.MAIL_FROM },
  googleReviewUrl: process.env.GOOGLE_REVIEW_URL || '', // lien « laisser un avis » de votre fiche Google
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups'), // une sauvegarde par jour, 14 gardées
});
server.listen(PORT, () => {
  console.log(`Proprigo tourne sur http://localhost:${PORT}`);
  if (!PROD) console.log('Comptes de démonstration : voir README.md');
});
