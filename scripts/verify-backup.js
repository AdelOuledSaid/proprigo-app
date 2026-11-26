'use strict';
// Test de restauration : npm run verify-backup -- chemin/vers/proprigo-AAAAMMJJ-HHMM.db[.enc]
// Un fichier .enc est déchiffré avec BACKUP_ENCRYPTION_KEY. La base est restaurée dans un fichier
// temporaire, contrôlée, puis effacée : la base du site n'est jamais touchée.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verify, decrypt } = require('../src/backup');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Indiquez le fichier de sauvegarde à tester.'); process.exit(1); }
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-restore-')), 'restore.db');
try {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.enc')) {
    if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error('Définissez BACKUP_ENCRYPTION_KEY (la même que sur Render).');
    buf = decrypt(buf, process.env.BACKUP_ENCRYPTION_KEY);
  }
  fs.writeFileSync(tmp, buf);
  const v = verify(tmp);
  if (!v.ok) throw new Error('Contrôle d\'intégrité en échec : cette sauvegarde est abîmée.');
  console.log(`Restauration réussie : ${v.users} comptes, ${v.bookings} réservations, ${v.payments ?? 0} paiements Stripe.`);
} catch (e) {
  console.error('Restauration impossible :', e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}
