'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

// Étapes de recrutement. Une intervenante ne reçoit des missions qu'à la dernière étape.
const STEPS = {
  S: ['Inscription', 'Identité vérifiée', 'Statut pro vérifié', 'Entretien', 'Expérience vérifiée', 'Formation', 'Mission supervisée', 'Active'],
  I: ['Inscription', 'Identité vérifiée', 'SIRET et attestation URSSAF', 'Assurance RC pro', 'Entretien de sélection', 'Active'],
};

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('client','intervenante','admin')),
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  statut TEXT NOT NULL CHECK (statut IN ('S','I')),
  cp TEXT NOT NULL,
  rate REAL,
  step INTEGER NOT NULL DEFAULT 0,
  absent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id),
  service TEXT NOT NULL,
  size TEXT,
  hours REAL NOT NULL,
  cp TEXT NOT NULL,
  address TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  kit INTEGER NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  zone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'en_attente',
  worker_id INTEGER REFERENCES users(id),
  paid INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'simule',
  series_id INTEGER REFERENCES series(id),
  checklist TEXT,
  photo_consent INTEGER NOT NULL DEFAULT 0,
  home_id INTEGER REFERENCES homes(id),
  source TEXT NOT NULL DEFAULT 'client',
  ical_uid TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  refund_amount REAL,
  rating INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS offers (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('offered','refused')),
  PRIMARY KEY (booking_id, worker_id)
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  cp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS availability (
  worker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  PRIMARY KEY (worker_id, weekday)
);
CREATE TABLE IF NOT EXISTS timeoff (
  id INTEGER PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id),
  every_days INTEGER NOT NULL,
  worker_id INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('avant','apres')),
  file TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'client',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS homes (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  cp TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT 'airbnb',
  size TEXT,
  hours REAL,
  instructions TEXT,
  checklist TEXT,
  photo_consent INTEGER NOT NULL DEFAULT 0,
  preferred_worker_id INTEGER REFERENCES users(id),
  ical_url TEXT,
  checkout_time TEXT NOT NULL DEFAULT '11:00',
  last_sync TEXT,
  last_sync_result TEXT
);
CREATE TABLE IF NOT EXISTS favorites (
  client_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  worker_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  text TEXT NOT NULL
);
`;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_payments (session_id TEXT PRIMARY KEY, client_id INTEGER NOT NULL, booking_ids TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const spCols = db.prepare('PRAGMA table_info(stripe_payments)').all().map((c) => c.name);
  if (!spCols.includes('payment_intent')) db.exec('ALTER TABLE stripe_payments ADD COLUMN payment_intent TEXT');
  if (!spCols.includes('refunded_cents')) db.exec('ALTER TABLE stripe_payments ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0');
  const usCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const [c, t] of [['staff_level', 'TEXT'], ['ref_code', 'TEXT'], ['referred_by', 'INTEGER']]) if (!usCols.includes(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${t}`);
  db.exec(`CREATE TABLE IF NOT EXISTS credits (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount REAL NOT NULL, reason TEXT NOT NULL, ref_user INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS admin_notes (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL, author_id INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  if (!db.prepare('PRAGMA table_info(incidents)').all().some((c) => c.name === 'source')) db.exec("ALTER TABLE incidents ADD COLUMN source TEXT NOT NULL DEFAULT 'client'");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users(ref_code) WHERE ref_code IS NOT NULL');
  const wkCols = db.prepare('PRAGMA table_info(workers)').all().map((c) => c.name);
  for (const [c, t] of [['bio', 'TEXT'], ['languages', 'TEXT']]) if (!wkCols.includes(c)) db.exec(`ALTER TABLE workers ADD COLUMN ${c} ${t}`);
  const bkCols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  for (const [c, t] of [['refund_id', 'TEXT'], ['on_way_at', 'TEXT'], ['arrived_at', 'TEXT'], ['review', 'TEXT'], ['problem', 'TEXT'], ['problem_at', 'TEXT'], ['discount', 'REAL NOT NULL DEFAULT 0']]) if (!bkCols.includes(c)) db.exec(`ALTER TABLE bookings ADD COLUMN ${c} ${t}`);
  // mise à jour des bases créées par une version précédente
  const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (!cols.includes('payment_status')) {
    db.exec("ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'simule'");
    db.exec("UPDATE bookings SET payment_status = 'a_rembourser' WHERE status = 'annulee'");
  }
  const cols2 = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (!cols2.includes('series_id')) db.exec('ALTER TABLE bookings ADD COLUMN series_id INTEGER REFERENCES series(id)');
  if (!cols2.includes('checklist')) db.exec('ALTER TABLE bookings ADD COLUMN checklist TEXT');
  if (!cols2.includes('photo_consent')) db.exec('ALTER TABLE bookings ADD COLUMN photo_consent INTEGER NOT NULL DEFAULT 0');
  if (!cols2.includes('home_id')) db.exec('ALTER TABLE bookings ADD COLUMN home_id INTEGER REFERENCES homes(id)');
  if (!cols2.includes('source')) db.exec("ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'client'");
  if (!cols2.includes('ical_uid')) db.exec('ALTER TABLE bookings ADD COLUMN ical_uid TEXT');
  if (!cols2.includes('reminded')) db.exec('ALTER TABLE bookings ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0');
  if (!cols2.includes('refund_amount')) db.exec('ALTER TABLE bookings ADD COLUMN refund_amount REAL');
  if (!cols2.includes('ical_missing_since')) db.exec('ALTER TABLE bookings ADD COLUMN ical_missing_since INTEGER');
  if (!cols2.includes('ical_flagged')) db.exec('ALTER TABLE bookings ADD COLUMN ical_flagged INTEGER NOT NULL DEFAULT 0');
  if (!cols2.includes('ical_keep')) db.exec('ALTER TABLE bookings ADD COLUMN ical_keep INTEGER NOT NULL DEFAULT 0');
  // intervenantes d'une version précédente sans calendrier : tous les jours de 7 h à 20 h, modifiable ensuite
  const noCal = db.prepare('SELECT user_id FROM workers WHERE user_id NOT IN (SELECT DISTINCT worker_id FROM availability)').all();
  if (noCal.length && db.prepare('SELECT COUNT(*) AS n FROM availability').get().n === 0) {
    for (const w of noCal) setAvailability(db, w.user_id, ALL_WEEK);
  }
  return db;
}

// Disponibilités par défaut : 0 = dimanche … 6 = samedi.
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start: '07:00', end: '20:00' }));
const NEW_WORKER_WEEK = [1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start: '08:00', end: '18:00' }));

function setAvailability(db, workerId, days) {
  db.prepare('DELETE FROM availability WHERE worker_id = ?').run(workerId);
  const ins = db.prepare('INSERT INTO availability (worker_id, weekday, start, end) VALUES (?, ?, ?, ?)');
  for (const d of days) ins.run(workerId, d.weekday, d.start, d.end);
}

function log(db, text) {
  // une même ligne déjà écrite dans les 10 dernières minutes n'est pas répétée
  if (db.prepare("SELECT 1 FROM events WHERE text = ? AND at >= datetime('now', '-10 minutes')").get(text)) return;
  db.prepare('INSERT INTO events (text) VALUES (?)').run(text);
}

function createUser(db, { role, email, password, name, phone }) {
  const r = db.prepare('INSERT INTO users (role, email, pass_hash, name, phone) VALUES (?, ?, ?, ?, ?)')
    .run(role, email.toLowerCase().trim(), hashPassword(password), name.trim(), phone || null);
  return Number(r.lastInsertRowid);
}

/** Données d'exemple pour essayer l'application. Créées seulement si la base est vide. */
function seedDemo(db, adminPassword) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return false;
  createUser(db, { role: 'admin', email: 'admin@proprigo.test', password: adminPassword, name: 'Équipe Proprigo' });
  const workers = [
    ['fatima@proprigo.test', 'Fatima K.', 'S', '75011', null, 7],
    ['aissata@proprigo.test', 'Aïssata D.', 'S', '75018', null, 7],
    ['ines@proprigo.test', 'Inès M.', 'I', '75020', 24, 5],
    ['lucia@proprigo.test', 'Lucia P.', 'I', '92100', 24, 5],
    ['mariam@proprigo.test', 'Mariam S.', 'S', '93200', null, 3],
  ];
  for (const [email, name, statut, cp, rate, step] of workers) {
    const id = createUser(db, { role: 'intervenante', email, password: 'demo-proprigo', name });
    db.prepare('INSERT INTO workers (user_id, statut, cp, rate, step) VALUES (?, ?, ?, ?, ?)').run(id, statut, cp, rate, step);
    setAvailability(db, id, ALL_WEEK);
  }
  createUser(db, { role: 'client', email: 'claire@proprigo.test', password: 'demo-proprigo', name: 'Claire', phone: '01 23 45 67 89' });
  for (const cp of ['69003', '69007', '13008', '33000']) db.prepare('INSERT INTO waitlist (email, cp) VALUES (?, ?)').run(`exemple-${cp}@proprigo.test`, cp);
  log(db, 'Base créée avec des données d\'exemple.');
  return true;
}

module.exports = { STEPS, ALL_WEEK, NEW_WORKER_WEEK, setAvailability, open, log, createUser, hashPassword, checkPassword, seedDemo };
