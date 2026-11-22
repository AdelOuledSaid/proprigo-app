'use strict';
// Sauvegarde de la base : copie cohérente (VACUUM INTO), même pendant que le site tourne.
// Les 14 dernières sauvegardes sont gardées. Copiez aussi ce dossier ailleurs (autre disque, stockage en ligne).
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 14;

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

/** Crée une sauvegarde et supprime les plus anciennes. Renvoie le chemin du fichier créé. */
function backup(db, dir, { keep = KEEP, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `proprigo-${stamp(now)}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);
  const all = list(dir);
  for (const old of all.slice(keep)) fs.unlinkSync(path.join(dir, old.file));
  return file;
}

/** Sauvegardes présentes, de la plus récente à la plus ancienne. */
function list(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^proprigo-\d{8}-\d{4}\.db$/.test(f)).sort().reverse()
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size, time: fs.statSync(path.join(dir, f)).mtimeMs }));
}

module.exports = { backup, list, KEEP };
