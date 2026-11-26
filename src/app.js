'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const db_ = require('./db');
const engine = require('./engine');
const pricing = require('./pricing');
const checklist = require('./checklist');
const ical = require('./ical');
const mailer = require('./mailer');
const seo = require('./seo');
const backups = require('./backup');
const push = require('./push');
const tiers = require('./tiers');
const nativePush = require('./native-push');
const VERSION = require('../package.json').version;
const os = require('node:os');
const stripePay = require('./stripe-pay');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 14;
const MIN_LEAD_MIN = 60;
const REFERRAL_EUR = 10; // offert au filleul sur son premier ménage, et au parrain après ce ménage // un ménage du jour se réserve au moins 1 h à l'avance (temps de trajet)
const TYPES = { '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({ dbFile = ':memory:', adminPassword = 'proprigo-admin', seed = true, secureCookies = false, production = false, paymentsEnabled = false, photosDir = null, icalAllowAny = false, icalFetch = undefined, autoSync = false, mail = {}, appUrl = 'http://localhost:3000', now = () => new Date(), backupDir = null, googleReviewUrl = '', adminEmail = '', companyConfig = null } = {}) {
  const PHOTOS = photosDir || (dbFile === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-photos-')) : path.join(path.dirname(dbFile), 'photos'));
  fs.mkdirSync(PHOTOS, { recursive: true });
  const db = db_.open(dbFile);
  const stripeReady = paymentsEnabled && stripePay.configured();
  if (seed) db_.seedDemo(db, adminPassword);
  // Adresse e-mail confirmée. Les comptes qui existaient avant cette version sont considérés confirmés.
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
    db.exec("UPDATE users SET email_verified_at = datetime('now')");
  }
  db.exec('CREATE TABLE IF NOT EXISTS email_checks (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)');
  // Colonnes ajoutées en v1.6 : garantie, avis publiés, heure d'arrivée estimée, relances.
  {
    const addCol = (table, col, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };
    for (const [c, t] of [['eta_at', 'TEXT'], ['finished_at', 'TEXT'], ['review_public', 'INTEGER NOT NULL DEFAULT 0'], ['review_hidden', 'INTEGER NOT NULL DEFAULT 0'],
      ['guarantee_at', 'TEXT'], ['guarantee_text', 'TEXT'], ['guarantee_status', 'TEXT'], ['guarantee_of', 'INTEGER'], ['guarantee_visit_id', 'INTEGER']]) addCol('bookings', c, t);
    for (const [c, t] of [['marketing_optout', 'INTEGER NOT NULL DEFAULT 0'], ['last_nudge_at', 'TEXT'], ['wants_avance', 'INTEGER NOT NULL DEFAULT 0'], ['lang', 'TEXT']]) addCol('users', c, t);
  }
  // Compte responsable : ADMIN_EMAIL donne sa vraie adresse (connexion + alertes : nouvelles réservations, contestations, pannes).
  // L'ancien compte « admin@proprigo.test » prend cette adresse ; sans aucun responsable, il est créé.
  if (adminEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    const target = adminEmail.trim().toLowerCase();
    const taken = db.prepare('SELECT id, role FROM users WHERE email = ?').get(target);
    const placeholder = db.prepare("SELECT id FROM users WHERE email = 'admin@proprigo.test' AND role = 'admin'").get();
    if (!taken && placeholder) {
      db.prepare("UPDATE users SET email = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(target, placeholder.id);
      db_.log(db, `Compte responsable : adresse admin@proprigo.test remplacée par ${target}.`);
    } else if (!taken && !db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").get()) {
      const id = db_.createUser(db, { role: 'admin', email: target, password: adminPassword, name: 'Équipe Proprigo' });
      db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(id);
      db_.log(db, `Compte responsable créé : ${target}.`);
    } else if (taken && taken.role !== 'admin') {
      console.warn(`ADMIN_EMAIL ${target} appartient déjà à un compte ${taken.role} : rien n'a été changé.`);
    }
  }
  // Protection CSRF : une requête qui modifie des données doit venir du site lui-même.
  // Le navigateur envoie toujours Origin (ou au moins Referer) sur un POST ; un autre site ne peut pas le falsifier.
  const ownOrigins = new Set([(() => { try { return new URL(appUrl).origin; } catch { return ''; } })()].filter(Boolean));
  const sameOrigin = (req) => {
    const src = req.headers.origin || (req.headers.referer ? (() => { try { return new URL(req.headers.referer).origin; } catch { return 'invalid'; } })() : '');
    if (!src) return !production || req.headers['sec-fetch-site'] === 'same-origin' || !req.headers['sec-fetch-site'];
    if (src === 'null' || src === 'invalid') return false;
    const host = req.headers.host;
    return ownOrigins.has(src) || (host && (src === `https://${host}` || (!production && src === `http://${host}`)));
  };
  // Derrière Render, l'adresse du visiteur est la première de X-Forwarded-For.
  const clientIp = (req) => (production && typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress || '').slice(0, 64);
  // Tentatives de connexion : gardées dans la base, donc conservées après un redémarrage.
  db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`);
  const LIMITS = [
    { kind: 'ip+email', max: 5, lockMs: 10 * 60e3 },   // 5 erreurs pour un compte depuis une adresse → 10 min
    { kind: 'email', max: 20, lockMs: 60 * 60e3 },     // 20 erreurs sur un compte, toutes adresses → 1 h
    { kind: 'ip', max: 50, lockMs: 60 * 60e3 },        // 50 erreurs depuis une adresse, tous comptes → 1 h
  ];
  const attemptKeys = (ip, email) => ({ 'ip+email': `ie|${ip}|${email}`, email: `e|${email}`, ip: `i|${ip}` });
  const loginBlocked = (ip, email) => {
    const keys = attemptKeys(ip, email); const t = Date.now();
    return LIMITS.some((l) => (db.prepare('SELECT until FROM login_attempts WHERE key = ?').get(keys[l.kind])?.until || 0) > t);
  };
  const loginFailed = (ip, email) => {
    const keys = attemptKeys(ip, email); const t = Date.now();
    for (const l of LIMITS) {
      const k = keys[l.kind];
      const row = db.prepare('SELECT n, updated FROM login_attempts WHERE key = ?').get(k);
      const n = row && t - row.updated < l.lockMs ? row.n + 1 : 1; // le compteur repart de zéro après une période calme
      if (n >= l.max) db.prepare('INSERT INTO login_attempts (key, n, until, updated) VALUES (?, 0, ?, ?) ON CONFLICT(key) DO UPDATE SET n = 0, until = excluded.until, updated = excluded.updated').run(k, t + l.lockMs, t);
      else db.prepare('INSERT INTO login_attempts (key, n, until, updated) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET n = excluded.n, updated = excluded.updated').run(k, n, t);
    }
  };
  const loginOk = (ip, email) => db.prepare('DELETE FROM login_attempts WHERE key = ?').run(attemptKeys(ip, email)['ip+email']);
  const purgeAttempts = () => db.prepare('DELETE FROM login_attempts WHERE until < ? AND updated < ?').run(Date.now(), Date.now() - 24 * 3600e3);
  const syncAsks = new Map();
  // ---- surveillance : chaque panne est gardée en base ; le responsable reçoit au plus un e-mail par heure
  db.exec(`CREATE TABLE IF NOT EXISTS server_errors (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), place TEXT NOT NULL, message TEXT NOT NULL, stack TEXT)`);
  function reportError(place, err) {
    const message = String(err && err.message || err).slice(0, 500);
    console.error(`[erreur] ${place} :`, err);
    try {
      db.prepare('INSERT INTO server_errors (place, message, stack) VALUES (?, ?, ?)').run(String(place).slice(0, 200), message, String(err && err.stack || '').slice(0, 4000));
      db.prepare("DELETE FROM server_errors WHERE at < datetime('now', '-30 days')").run();
      const hour = new Date().toISOString().slice(0, 13);
      const n = db.prepare("SELECT COUNT(*) AS n FROM server_errors WHERE at >= datetime('now', '-1 hour')").get().n;
      for (const to of db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").all().map((a) => a.email)) {
        mailer.send(to, `Alerte Proprigo : erreur sur le site (${place})`, 'Une erreur est survenue sur le site', [
          `${place} : ${message}`, `${n} erreur(s) dans la dernière heure. Détails : Admin › Suivi › Journal, et les journaux de Render.`,
          'Vous recevez au plus une alerte par heure.',
        ], { label: 'Ouvrir l\'admin', path: '/#/admin' }, { key: `alert-${hour}-${to}` });
      }
    } catch (e2) { console.error('Surveillance indisponible :', e2.message); }
  }
  const gzCache = new Map(); // fichiers du site déjà compressés (clé : fichier + version)
  mailer.configure({
    outbox: mail.outbox || (dbFile === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-outbox-')) : path.join(path.dirname(dbFile), 'outbox')),
    provider: mail.provider, apiKey: mail.apiKey, from: mail.from, replyTo: mail.replyTo, appUrl, db,
    retryDelaysMs: mail.retryDelaysMs || [2000, 8000],
    onError: (t) => db_.log(db, t),
  });
  // Règle d'annulation : gratuite jusqu'à 24 h avant, 50 % retenus ensuite.
  const FREE_CANCEL_HOURS = 24;
  const LATE_CANCEL_KEEP = 0.5;
  const refundFor = (b) => (hoursBefore(b) >= FREE_CANCEL_HOURS ? b.total : Math.round(b.total * (1 - LATE_CANCEL_KEEP) * 100) / 100);
  const emailOf = (uid) => (db.prepare('SELECT email FROM users WHERE id = ?').get(uid) || {}).email;
  const fr = (d) => engine.frDate(d);
  // RGPD : les photos sont supprimées 90 jours après leur ajout (au démarrage, puis chaque jour)
  const purgePhotos = () => {
    let n = 0;
    for (const ph of db.prepare("SELECT * FROM photos WHERE created_at < datetime('now', '-90 days')").all()) {
      try { fs.unlinkSync(path.join(PHOTOS, path.basename(ph.file))); } catch { /* déjà supprimée */ }
      db.prepare('DELETE FROM photos WHERE id = ?').run(ph.id);
      n += 1;
    }
    if (n) db_.log(db, `Photos de plus de 90 jours supprimées : ${n}.`);
    return n;
  };
  purgePhotos();

  // ---------- outils ----------
  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const readBody = (req, limit = 100_000) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Requête trop grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
  const cookieOf = (req, name) => {
    const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  };
  const sessionCookie = (token, maxAge) =>
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const currentUser = (req) => {
    const t = cookieOf(req, 'sid');
    if (!t) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
    if (!s || s.expires < Date.now()) return null;
    return db.prepare('SELECT id, role, email, name, phone, staff_level, email_verified_at IS NOT NULL AS email_verified, wants_avance, lang, billing, sepa_pm IS NOT NULL AS sepa_ready, sepa_last4 FROM users WHERE id = ?').get(s.user_id) || null;
  };
  const need = (user, role) => {
    if (!user) throw new HttpError(401, 'Connectez-vous pour continuer.');
    if (role && user.role !== role) throw new HttpError(403, 'Accès réservé.');
    // compte « planning » : seulement le planning, les réservations, l'équipe et les messages
    if (role === 'admin' && user.staff_level === 'planning') throw new HttpError(403, 'Accès réservé au responsable.');
  };
  // routes ouvertes au compte « planning » comme au responsable
  const needStaff = (user) => { need(user); if (user.role !== 'admin') throw new HttpError(403, 'Accès réservé.'); };
  const isOwner = (user) => user && user.role === 'admin' && user.staff_level !== 'planning';
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const login = (res, userId) => {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_DAYS * 864e5);
    return sessionCookie(token, SESSION_DAYS * 86400);
  };
  // ce que voit un client : prénom et initiale du nom, jamais le nom complet
  const displayName = (name) => { const [first, ...rest] = String(name || '').trim().split(/\s+/); const last = rest.join(' '); return last ? `${first} ${last[0].toUpperCase()}.` : first; };
  // intervenante demandée par le client au moment de réserver
  if (!db.prepare('PRAGMA table_info(bookings)').all().some((x) => x.name === 'want_worker_id')) db.exec('ALTER TABLE bookings ADD COLUMN want_worker_id INTEGER');
  // le client ne peut demander qu'une intervenante déjà venue chez lui
  const pastWorker = (clientId, wid) => Boolean(wid && db.prepare("SELECT 1 FROM bookings WHERE client_id = ? AND worker_id = ? AND status = 'terminee'").get(clientId, Number(wid)));
  // photo de profil des intervenantes
  for (const [c, t] of [['avatar', 'TEXT'], ['avatar_status', 'TEXT'], ['avatar_at', 'TEXT']]) if (!db.prepare('PRAGMA table_info(workers)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE workers ADD COLUMN ${c} ${t}`);
  if (!db.prepare('PRAGMA table_info(workers)').all().some((x) => x.name === 'gender')) db.exec('ALTER TABLE workers ADD COLUMN gender TEXT'); // 'h' homme, sinon femme
  const genderOf = (wid) => (wid && (db.prepare('SELECT gender FROM workers WHERE user_id = ?').get(wid) || {}).gender === 'h' ? 'h' : 'f');
  const hasAvatar = (wid) => Boolean(wid && db.prepare("SELECT 1 FROM workers WHERE user_id = ? AND avatar IS NOT NULL AND avatar_status = 'valide'").get(wid));
  const bookingView = (b) => {
    const w = b.worker_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(b.worker_id) : null;
    const photos = db.prepare('SELECT id, kind FROM photos WHERE booking_id = ? ORDER BY id').all(b.id);
    const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE booking_id = ?').get(b.id).n;
    const inc = db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE booking_id = ? AND resolved = 0').get(b.id).n;
    let list = [];
    try { list = JSON.parse(b.checklist || '[]'); } catch { list = []; }
    const tipRow = b.status === 'terminee' ? db.prepare("SELECT amount_cents FROM tips WHERE booking_id = ? AND status = 'paye'").get(b.id) : null;
    return { ...b, tip: tipRow ? tipRow.amount_cents / 100 : null, worker_name: w ? w.name : null, worker_display: w ? displayName(w.name) : null, worker_gender: genderOf(b.worker_id), worker_photo: hasAvatar(b.worker_id), checklist: list, photos, messages: msgs, incidents: inc, guarantee_open: guaranteeOpen(b) };
  };
  const nowParisHM = () => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(now());
  const hoursBefore = (b) => (Date.parse(`${b.date}T${b.time}:00`) - Date.parse(`${pricing.todayParis(now())}T${nowParisHM()}:00`)) / 36e5;
  const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const canSee = (user, b) => user && (user.role === 'admin' || b.client_id === user.id || b.worker_id === user.id);
  const workerProfile = (id) => db.prepare('SELECT w.*, u.name, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(id);

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), handler });

  // ----- surveillance : à appeler toutes les 5 minutes par un service de surveillance -----
  const started = Date.now();
  let lastBackup = null;
  let lastBackupError = null;
  route('GET', '/api/health', () => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const backupOk = !backupDir || (lastBackup && Date.now() - lastBackup < 48 * 3600e3) || Date.now() - started < 3600e3;
    const ok = dbOk && backupOk;
    const data = { ok, version: VERSION, uptimeMinutes: Math.round((Date.now() - started) / 60e3), database: dbOk ? 'ok' : 'erreur', backup: !backupDir ? 'désactivée' : backupOk ? 'ok' : 'en retard', emails: mailer.cfg.provider ? `${mailer.cfg.provider} (${String(mailer.cfg.from).replace(/^.*<|>.*$/g, '')}${mailer.cfg.replyTo ? `, réponses à ${String(mailer.cfg.replyTo).replace(/^.*<|>.*$/g, '')}` : ''})` : 'mode local : aucun e-mail ne part', paiements: stripeReady ? (String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live_') ? 'Stripe réel' : 'Stripe test') : 'simulés', erreurs24h: db.prepare("SELECT COUNT(*) AS n FROM server_errors WHERE at >= datetime('now', '-1 day')").get().n, tva: franchiseTVA ? `franchise (293 B) : CA ${parisYear()} ${Math.round(caAnnee(parisYear())).toLocaleString('fr-FR')} € sur 37 500 €` : 'TVA facturée', factures: companyMissing.length ? `à compléter (config/entreprise.json : ${companyMissing.join(', ')})` : 'ok', applis: (() => { const c = nativePush.config(); return `iPhone ${c.apns ? 'ok' : 'non configuré'}, Android ${c.fcm ? 'ok' : 'non configuré'}`; })(), backupExterne: !offsite.configured ? 'non configurée' : offsite.ok ? 'ok' : offsite.ok === false ? 'en échec' : 'en attente' };
    return ok ? data : { status: 503, data };
  });
  // Copie hors de Render : état du dernier envoi (affiché dans l'admin et /api/health)
  let offsite = { configured: false, ok: null, at: null, error: null, file: null };
  try { offsite.configured = Boolean(backups.offsiteConfig()); } catch (e) { offsite = { ...offsite, configured: true, ok: false, error: e.message }; }
  const runOffsite = async (f) => {
    let cfg;
    try { cfg = backups.offsiteConfig(); } catch (e) { offsite = { ...offsite, ok: false, error: e.message }; return; }
    if (!cfg) return;
    try {
      const name = await backups.uploadOffsite(f, cfg);
      offsite = { configured: true, ok: true, at: Date.now(), error: null, file: name };
    } catch (e) {
      offsite = { ...offsite, configured: true, ok: false, error: e.message };
      db_.log(db, `Sauvegarde externe impossible : ${e.message}`);
    }
  };
  let lastVerify = null;
  const runBackup = () => {
    try {
      const f = backups.backup(db, backupDir);
      // Essai de restauration : la copie doit s'ouvrir et être intacte.
      const v = backups.verify(f);
      lastVerify = { ...v, file: path.basename(f) };
      if (!v.ok) throw new Error('copie créée mais abîmée (contrôle d\'intégrité en échec)');
      lastBackup = Date.now();
      lastBackupError = null;
      runOffsite(f).catch(() => {});
      return f;
    } catch (e) {
      lastBackupError = e.message;
      db_.log(db, `Sauvegarde impossible : ${e.message}`);
      return null;
    }
  };
  if (backupDir && autoSync) {
    const existing = backups.list(backupDir)[0];
    if (existing) lastBackup = existing.time;
    setTimeout(runBackup, 2 * 60e3).unref();
    setInterval(runBackup, 24 * 3600e3).unref();
  }
  route('GET', '/api/admin/backups', ({ user }) => {
    need(user, 'admin');
    if (!backupDir) return { enabled: false, list: [] };
    return { enabled: true, error: lastBackupError, verify: lastVerify,
      offsite: { ...offsite, at: offsite.at ? new Date(offsite.at).toISOString() : null },
      download: Boolean(process.env.BACKUP_ENCRYPTION_KEY && process.env.BACKUP_ENCRYPTION_KEY.length >= 20),
      list: backups.list(backupDir).slice(0, 5).map((b) => ({ file: b.file, size: b.size, time: new Date(b.time).toISOString() })) };
  });
  // Télécharger la dernière sauvegarde, toujours chiffrée (à garder sur un autre support).
  route('GET', '/api/admin/backups/latest', ({ user, res }) => {
    need(user, 'admin');
    if (!backupDir) throw new HttpError(400, 'Sauvegardes désactivées.');
    const key = process.env.BACKUP_ENCRYPTION_KEY;
    if (!key || key.length < 20) throw new HttpError(400, 'Définissez BACKUP_ENCRYPTION_KEY sur Render pour télécharger une sauvegarde chiffrée.');
    const last = backups.list(backupDir)[0];
    if (!last) throw new HttpError(404, 'Aucune sauvegarde pour le moment.');
    const buf = backups.encrypt(fs.readFileSync(path.join(backupDir, last.file)), key);
    db_.log(db, `Sauvegarde ${last.file} téléchargée (chiffrée) par ${user.email}.`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${last.file}.enc"`, 'Cache-Control': 'no-store' });
    res.end(buf);
    return { streamed: true };
  });
  // ----- effacer les données de test avant l'ouverture (impossible une fois Stripe en mode réel) -----
  const stripeLive = () => /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
  const TEST_TABLES = ['bookings', 'invoices', 'stripe_payments', 'stripe_claims', 'stripe_disputes', 'stripe_duplicate_refunds', 'stripe_intents_seen', 'stripe_refund_ledger',
    'tips', 'messages', 'photos', 'incidents', 'offers', 'payouts', 'series', 'credits', 'gift_cards', 'quote_requests', 'worker_absences', 'admin_notes', 'transfer_bills'];
  route('GET', '/api/admin/test-data', ({ user }) => {
    need(user, 'admin');
    const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const count = (t) => (has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
    return { allowed: !stripeLive(), bookings: count('bookings'), invoices: count('invoices'), quotes: count('quote_requests'),
      demoAccounts: db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@proprigo.test' AND id <> ?").get(user.id).n,
      clients: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'client' AND email NOT LIKE '%@proprigo.test'").get().n };
  });
  route('POST', '/api/admin/test-data/reset', ({ user, body }) => {
    need(user, 'admin');
    if (stripeLive()) throw new HttpError(409, 'Stripe est en mode réel : les données ne peuvent plus être effacées (factures obligatoires à garder 10 ans).');
    if (body.confirm !== 'EFFACER') throw new HttpError(400, 'Écrivez EFFACER en majuscules pour confirmer.');
    let saved = null;
    if (backupDir) { saved = runBackup(); if (!saved) throw new HttpError(500, 'La sauvegarde de sécurité a échoué : rien n\'a été effacé.'); }
    const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const ids = db.prepare(`SELECT id FROM users WHERE id <> ? AND ((? AND email LIKE '%@proprigo.test') OR (? AND role = 'client'))`)
      .all(user.id, body.demo ? 1 : 0, body.clients ? 1 : 0).map((r) => r.id);
    const done = {};
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const t of TEST_TABLES) if (has(t)) done[t] = Number(db.prepare(`DELETE FROM ${t}`).run().changes);
      if (ids.length) {
        const list = ids.join(',');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'users'").all().map((r) => r.name);
        for (const t of tables) {
          const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
          for (const c of ['user_id', 'client_id', 'worker_id']) if (cols.includes(c)) db.prepare(`DELETE FROM ${t} WHERE ${c} IN (${list})`).run();
        }
        done.users = Number(db.prepare(`DELETE FROM users WHERE id IN (${list})`).run().changes);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
    try { for (const f of fs.readdirSync(PHOTOS)) fs.rmSync(path.join(PHOTOS, f), { recursive: true, force: true }); } catch { /* dossier absent */ }
    db_.log(db, `DONNÉES DE TEST EFFACÉES par ${user.email} : ${done.bookings || 0} réservations, ${done.invoices || 0} factures, ${done.users || 0} comptes${saved ? ` (sauvegarde avant : ${path.basename(saved)})` : ''}.`);
    return { ok: true, message: `Données de test effacées : ${done.bookings || 0} réservations, ${done.invoices || 0} factures et avoirs${done.users ? `, ${done.users} comptes` : ''}. La prochaine facture sera F${parisYear()}-000001.${saved ? ' Une sauvegarde a été faite juste avant.' : ''}` };
  });
  route('POST', '/api/admin/backups', ({ user }) => {
    need(user, 'admin');
    if (!backupDir) throw new HttpError(400, 'Sauvegardes désactivées.');
    const f = runBackup();
    if (!f) throw new HttpError(500, `Sauvegarde impossible : ${lastBackupError}`);
    db_.log(db, `Sauvegarde manuelle créée : ${path.basename(f)}.`);
    return { ok: true, message: 'Sauvegarde créée.' };
  });

  route('GET', '/api/me', ({ user }) => ({ user, worker: user && user.role === 'intervenante' ? workerProfile(user.id) : null }));

  // ----- confirmation de l'adresse e-mail -----
  const VERIFY_DAYS = 7;
  const shaTok = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const verifyAsks = new Map();
  function verificationLink(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM email_checks WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO email_checks (token_hash, user_id, expires) VALUES (?, ?, ?)').run(shaTok(token), userId, Date.now() + VERIFY_DAYS * 864e5);
    return `/#/confirmer-email?t=${token}`;
  }
  // En production, réserver demande une adresse confirmée (sinon : confirmations, factures et rappels n'arrivent pas).
  const needVerifiedEmail = (user) => {
    if (!production || !user || user.role === 'admin') return;
    if (!db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(user.id)?.email_verified_at) {
      throw new HttpError(403, "Confirmez d'abord votre adresse e-mail avec le lien que nous vous avons envoyé. Vous pouvez le recevoir à nouveau depuis « Mon compte ».");
    }
  };
  route('POST', '/api/email/verify', ({ body }) => {
    const token = str(body.token, 100);
    const row = /^[0-9a-f]{64}$/.test(token) ? db.prepare('SELECT * FROM email_checks WHERE token_hash = ?').get(shaTok(token)) : null;
    if (!row || row.expires < Date.now()) throw new HttpError(400, 'Ce lien n\'est plus valable. Connectez-vous et demandez-en un nouveau depuis « Mon compte ».');
    db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(row.user_id);
    db.prepare('DELETE FROM email_checks WHERE user_id = ?').run(row.user_id);
    return { ok: true, message: 'Merci, votre adresse e-mail est confirmée.' };
  });
  route('POST', '/api/email/resend', ({ user }) => {
    need(user);
    const u = db.prepare('SELECT id, name, email, email_verified_at FROM users WHERE id = ?').get(user.id);
    if (u.email_verified_at) return { ok: true, message: 'Votre adresse est déjà confirmée.' };
    const recent = (verifyAsks.get(u.id) || []).filter((t) => t > Date.now() - 3600e3);
    if (recent.length >= 3) throw new HttpError(429, 'Trois liens envoyés dans l\'heure : vérifiez vos courriers indésirables, puis réessayez plus tard.');
    verifyAsks.set(u.id, [...recent, Date.now()]);
    mailer.send(u.email, 'Confirmez votre adresse e-mail', 'Confirmez votre adresse e-mail', [`Bonjour ${u.name.split(' ')[0]},`, `Cliquez sur le bouton pour confirmer votre adresse. Le lien est valable ${VERIFY_DAYS} jours.`],
      { label: 'Confirmer mon adresse', path: verificationLink(u.id) });
    return { ok: true, message: `Lien envoyé à ${u.email}.` };
  });

  route('POST', '/api/signup', ({ body }) => {
    const role = body.role === 'intervenante' ? 'intervenante' : 'client';
    const email = str(body.email, 120).toLowerCase();
    const name = str(body.name, 80);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name) throw new HttpError(400, 'Indiquez votre nom.');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
    if (password.length < 10) throw new HttpError(400, 'Mot de passe : 10 caractères minimum.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail.');
    let statut;
    let cp;
    let rate = null;
    if (role === 'intervenante') {
      statut = body.statut === 'I' ? 'I' : 'S';
      cp = str(body.cp, 5);
      if (!pricing.zoneOf(cp)) throw new HttpError(400, 'Code postal invalide.');
      if (statut === 'I') {
        rate = Number(body.rate);
        if (!(rate >= 15 && rate <= 40)) throw new HttpError(400, 'Tarif horaire entre 15 et 40 €.');
      }
    }
    const refCode = str(body.ref, 12).toUpperCase();
    const sponsor = role === 'client' && refCode ? db.prepare("SELECT id FROM users WHERE ref_code = ? AND role = 'client'").get(refCode) : null;
    if (role === 'client' && refCode && !sponsor) throw new HttpError(400, 'Code de parrainage inconnu. Vérifiez-le ou laissez le champ vide.');
    const id = db_.createUser(db, { role, email, password, name, phone: str(body.phone, 20) });
    if (sponsor) {
      db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(sponsor.id, id);
      db.prepare("INSERT INTO credits (user_id, amount, reason, ref_user) VALUES (?, ?, 'Bienvenue : parrainage', ?)").run(id, REFERRAL_EUR, sponsor.id);
      db_.log(db, `Nouveau client parrainé (code ${refCode}) : ${REFERRAL_EUR} € offerts sur son premier ménage.`);
    }
    if (role === 'intervenante') {
      db.prepare('INSERT INTO workers (user_id, statut, cp, rate, gender) VALUES (?, ?, ?, ?, ?)').run(id, statut, cp, rate, body.gender === 'h' ? 'h' : 'f');
      db_.setAvailability(db, id, db_.NEW_WORKER_WEEK);
      db_.log(db, `Nouvelle candidature : ${name} (${statut === 'S' ? 'salariée' : 'indépendante'}, ${cp}).`);
    }
    const confirmPath = verificationLink(id);
    if (role === 'intervenante') mailer.send(email, 'Votre candidature Proprigo', `Bonjour ${name.split(' ')[0]}, merci pour votre candidature`, ["Première étape : confirmez votre adresse e-mail avec le bouton ci-dessous (lien valable 7 jours).", "Notre équipe vous contacte ensuite pour la suite : vérification de l'identité, entretien, formation.", 'Pensez à indiquer vos disponibilités dans votre espace.'], { label: 'Confirmer mon adresse', path: confirmPath });
    else mailer.send(email, 'Bienvenue chez Proprigo', `Bienvenue ${name.split(' ')[0]}`, ['Votre compte est créé. Confirmez votre adresse e-mail avec le bouton ci-dessous (lien valable 7 jours) : c\'est là que vous recevrez vos confirmations, rappels et factures.', 'Ensuite, réservez un ménage en quelques minutes, avec des intervenantes vérifiées.'], { label: 'Confirmer mon adresse', path: confirmPath });
    return { status: 201, data: { ok: true }, headers: { 'Set-Cookie': login(null, id) } };
  });

  route('POST', '/api/login', ({ body, ip }) => {
    const email = str(body.email, 120).toLowerCase();
    if (loginBlocked(ip, email)) throw new HttpError(429, 'Trop d\'essais. Réessayez dans quelques minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !db_.checkPassword(String(body.password || ''), u.pass_hash)) {
      loginFailed(ip, email);
      throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
    }
    loginOk(ip, email);
    return { data: { ok: true, role: u.role }, headers: { 'Set-Cookie': login(null, u.id) } };
  });

  // ----- mot de passe oublié -----
  const RESET_MINUTES = 60;
  const resetAsks = new Map();
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  route('POST', '/api/password/forgot', ({ body, ip }) => {
    const email = str(body.email, 120).toLowerCase();
    const same = { ok: true, message: 'Si un compte existe avec cet e-mail, un lien pour choisir un nouveau mot de passe vient de lui être envoyé. Il est valable 1 heure.' };
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
    const key = ip + '|' + email;
    const recent = (resetAsks.get(key) || []).filter((t) => t > Date.now() - 3600e3);
    if (recent.length >= 3) throw new HttpError(429, 'Trop de demandes. Réessayez dans une heure.');
    resetAsks.set(key, [...recent, Date.now()]);
    const u = db.prepare("SELECT id, name FROM users WHERE email = ? AND email NOT LIKE 'supprime-%'").get(email);
    if (!u) return same; // même réponse : on ne révèle pas si le compte existe
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM resets WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO resets (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + RESET_MINUTES * 60e3);
    mailer.send(email, 'Nouveau mot de passe Proprigo', 'Choisir un nouveau mot de passe', [`Bonjour ${u.name.split(' ')[0]},`, 'Vous avez demandé à changer votre mot de passe. Le lien ci-dessous est valable 1 heure et ne sert qu\'une fois.', "Si vous n'avez rien demandé, ignorez cet e-mail : votre mot de passe reste le même."], { label: 'Choisir un nouveau mot de passe', path: `/#/nouveau-mot-de-passe?t=${token}` });
    return same;
  });
  route('POST', '/api/password/reset', ({ body }) => {
    const token = str(body.token, 100);
    const password = typeof body.password === 'string' ? body.password : '';
    const r = /^[0-9a-f]{64}$/.test(token) ? db.prepare('SELECT * FROM resets WHERE token_hash = ?').get(sha(token)) : null;
    if (!r || r.used || r.expires < Date.now()) throw new HttpError(400, 'Ce lien a expiré ou a déjà servi. Demandez-en un nouveau.');
    if (password.length < 10) throw new HttpError(400, 'Mot de passe : 10 caractères minimum.');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(db_.hashPassword(password), r.user_id);
    db.prepare('UPDATE resets SET used = 1 WHERE token_hash = ?').run(r.token_hash);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // déconnecte les autres appareils
    const u = db.prepare('SELECT role, email FROM users WHERE id = ?').get(r.user_id);
    mailer.send(u.email, 'Votre mot de passe a été changé', 'Mot de passe changé', ["Le mot de passe de votre compte Proprigo vient d'être changé.", "Si ce n'est pas vous, écrivez-nous tout de suite."], null);
    return { data: { ok: true, role: u.role }, headers: { 'Set-Cookie': login(null, r.user_id) } };
  });

  // ----- mon compte -----
  route('POST', '/api/account', ({ user, body }) => {
    need(user);
    const name = str(body.name, 80);
    const phone = str(body.phone, 20);
    if (name.length < 2) throw new HttpError(400, 'Indiquez votre nom.');
    if (phone && !/^[+0-9 .()-]{6,20}$/.test(phone)) throw new HttpError(400, 'Numéro de téléphone invalide.');
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone || null, user.id);
    return { ok: true, message: 'Informations enregistrées.' };
  });
  route('POST', '/api/account/company', ({ user, body }) => {
    need(user, 'client');
    const company = str(body.company, 120);
    const siret = str(body.siret, 20).replace(/\s+/g, '');
    const vat = str(body.vat_number, 20).replace(/\s+/g, '').toUpperCase();
    const billing = str(body.billing_address, 200);
    if (siret && !/^\d{14}$/.test(siret)) throw new HttpError(400, 'Le SIRET compte 14 chiffres.');
    if (vat && !/^[A-Z]{2}[0-9A-Z]{8,12}$/.test(vat)) throw new HttpError(400, 'Numéro de TVA invalide (ex. FR12345678901).');
    if (!company && (siret || vat)) throw new HttpError(400, 'Indiquez la raison sociale.');
    db.prepare('UPDATE users SET company = ?, siret = ?, vat_number = ?, billing_address = ? WHERE id = ?').run(company || null, siret || null, vat || null, billing || null, user.id);
    return { ok: true, message: company ? 'Société enregistrée : vos prochaines factures seront à son nom.' : 'Société retirée.' };
  });
  route('GET', '/api/account/company', ({ user }) => {
    need(user, 'client');
    const c = db.prepare('SELECT company, siret, vat_number, billing_address FROM users WHERE id = ?').get(user.id);
    const n = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE client_id = ? AND status <> 'annulee' AND substr(date, 1, 7) = ?").get(user.id, pricing.todayParis(now()).slice(0, 7)).n;
    return { ...c, monthCount: n, volume: volumeRate(user) };
  });

  // ----- demande de devis (entreprises, agences, syndics, conciergeries) -----
  const QUOTE_KINDS = { bureaux: 'Bureaux', agence: 'Agence immobilière / fins de bail', syndic: 'Syndic / parties communes', conciergerie: 'Conciergerie / logements Airbnb', autre: 'Autre' };
  const devisAsks = new Map();
  route('POST', '/api/quote-requests', ({ body, ip }) => {
    const recent = (devisAsks.get(ip) || []).filter((t) => t > Date.now() - 3600e3);
    if (recent.length >= 5) throw new HttpError(429, 'Trop de demandes. Réessayez dans une heure.');
    const company = str(body.company, 120); const name = str(body.name, 80);
    const email = str(body.email, 120).toLowerCase(); const phone = str(body.phone, 20);
    const cp = str(body.cp, 5); const kind = Object.hasOwn(QUOTE_KINDS, body.kind) ? body.kind : null;
    const surface = Math.min(100000, Math.max(0, Math.round(Number(body.surface) || 0))) || null;
    const frequency = str(body.frequency, 60); const message = str(body.message, 1000);
    if (!company || !name) throw new HttpError(400, 'Indiquez la société et votre nom.');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
    if (!/^\d{5}$/.test(cp)) throw new HttpError(400, 'Code postal à 5 chiffres.');
    if (!kind) throw new HttpError(400, 'Choisissez le type de besoin.');
    devisAsks.set(ip, [...recent, Date.now()]);
    const id = Number(db.prepare('INSERT INTO quote_requests (company, name, email, phone, cp, kind, surface, frequency, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(company, name, email, phone || null, cp, kind, surface, frequency || null, message || null).lastInsertRowid);
    db_.log(db, `Demande de devis n° ${id} : ${company} (${QUOTE_KINDS[kind]}, ${cp}).`);
    for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").all()) mailer.send(a.email, `Demande de devis : ${company}`, 'Nouvelle demande de devis', [`${company} · ${QUOTE_KINDS[kind]} · ${cp}${surface ? ` · ${surface} m²` : ''}${frequency ? ` · ${frequency}` : ''}`, `${name} · ${email}${phone ? ` · ${phone}` : ''}`, ...(message ? [message] : [])], { label: 'Voir les demandes', path: '/#/admin' });
    mailer.send(email, 'Votre demande de devis Proprigo', 'Demande bien reçue', [`Bonjour ${name.split(' ')[0]},`, 'Nous avons bien reçu votre demande. Nous vous recontactons sous 24 h ouvrées avec une proposition.'], null);
    return { ok: true, message: 'Demande envoyée. Nous vous recontactons sous 24 h ouvrées.' };
  });
  route('GET', '/api/admin/quote-requests', ({ user }) => {
    needStaff(user);
    return db.prepare("SELECT * FROM quote_requests ORDER BY CASE status WHEN 'nouveau' THEN 0 WHEN 'accepte' THEN 1 WHEN 'refuse' THEN 2 WHEN 'envoye' THEN 3 WHEN 'planifie' THEN 4 ELSE 5 END, id DESC LIMIT 50").all().map(quoteView);
  });
  route('POST', '/api/admin/quote-requests/:id/done', ({ user, id }) => {
    needStaff(user);
    db.prepare("UPDATE quote_requests SET status = 'traite' WHERE id = ?").run(id);
    return { ok: true, message: 'Demande classée sans suite.' };
  });

  // ----- devis envoyé au professionnel, accepté en ligne -----
  const qCols = db.prepare('PRAGMA table_info(quote_requests)').all().map((c) => c.name);
  for (const [c, t] of [['offer_json', 'TEXT'], ['offer_number', 'TEXT'], ['offer_token', 'TEXT'], ['offer_sent_at', 'TEXT'], ['answered_at', 'TEXT'], ['answer_name', 'TEXT'], ['answer_message', 'TEXT']]) {
    if (!qCols.includes(c)) db.exec(`ALTER TABLE quote_requests ADD COLUMN ${c} ${t}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS quote_offer_token ON quote_requests(offer_token) WHERE offer_token IS NOT NULL');
  const QUOTE_FREQ = { once: ['Une seule fois', 0], weekly: ['Chaque semaine', 52 / 12], twice: ['2 fois par semaine', 104 / 12], biweekly: ['Toutes les 2 semaines', 26 / 12], monthly: ['Chaque mois', 1] };
  const QUOTE_VALID_DAYS = 30;
  const r2 = (n) => Math.round(n * 100) / 100;
  const offerOf = (q) => {
    if (!q.offer_json) return null;
    const o = JSON.parse(q.offer_json);
    const vat = franchiseTVA ? 0 : pricing.COSTS.tvaPro;
    const perVisitHT = r2(o.hours * o.rate);
    const perMonth = QUOTE_FREQ[o.frequency][1];
    return { ...o, frequencyLabel: QUOTE_FREQ[o.frequency][0], perVisitHT, vatRate: vat, perVisitVAT: r2(perVisitHT * vat), perVisitTTC: r2(perVisitHT * (1 + vat)),
      perMonthHT: perMonth ? r2(perVisitHT * perMonth) : null, perMonthTTC: perMonth ? r2(perVisitHT * perMonth * (1 + vat)) : null,
      validUntil: q.offer_sent_at ? new Date(Date.parse(q.offer_sent_at) + QUOTE_VALID_DAYS * 864e5).toISOString().slice(0, 10) : null };
  };
  const quoteView = (q) => ({ ...q, offer_token: undefined, kindLabel: QUOTE_KINDS[q.kind], offer: offerOf(q), link: q.offer_token ? `/#/devis?t=${q.offer_token}` : null });
  route('POST', '/api/admin/quote-requests/:id/offer', ({ user, id, body }) => {
    needStaff(user);
    const q = db.prepare('SELECT * FROM quote_requests WHERE id = ?').get(id);
    if (!q) throw new HttpError(404, 'Demande introuvable.');
    if (['accepte', 'planifie'].includes(q.status)) throw new HttpError(409, 'Ce devis est déjà accepté.');
    const label = str(body.label, 120); const message = str(body.message, 1000); const start = str(body.start, 10);
    const hours = Math.round(Number(body.hours) * 4) / 4; const rate = r2(Number(body.rate));
    const frequency = Object.hasOwn(QUOTE_FREQ, body.frequency) ? body.frequency : null;
    if (!label) throw new HttpError(400, 'Décrivez la prestation.');
    if (!(hours >= 0.5 && hours <= 100)) throw new HttpError(400, 'Nombre d\'heures par passage entre 0,5 et 100.');
    if (!(rate >= 15 && rate <= 200)) throw new HttpError(400, 'Prix de l\'heure entre 15 € et 200 €.');
    if (!frequency) throw new HttpError(400, 'Choisissez la fréquence.');
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new HttpError(400, 'Date de début invalide.');
    const year = now().getFullYear();
    let number = q.offer_number;
    if (!number) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM quote_requests WHERE offer_number LIKE ?").get(`D${year}-%`).n + 1;
      number = `D${year}-${String(n).padStart(4, '0')}`;
    }
    const token = q.offer_token || crypto.randomBytes(24).toString('hex');
    const sentAt = now().toISOString();
    db.prepare("UPDATE quote_requests SET offer_json = ?, offer_number = ?, offer_token = ?, offer_sent_at = ?, status = 'envoye', answered_at = NULL, answer_name = NULL, answer_message = NULL WHERE id = ?")
      .run(JSON.stringify({ label, hours, rate, frequency, start: start || null, message: message || null, allowTransfer: body.allowTransfer === true || body.allowTransfer === 'on' }), number, token, sentAt, id);
    const fresh = db.prepare('SELECT * FROM quote_requests WHERE id = ?').get(id);
    const o = offerOf(fresh);
    const money = (n) => `${n.toFixed(2).replace('.', ',')} €`;
    mailer.send(q.email, `Votre devis Proprigo ${number}`, `Votre devis ${number}`, [
      `Bonjour ${q.name.split(' ')[0]},`,
      `Voici notre proposition pour ${q.company} : ${label}.`,
      `${String(hours).replace('.', ',')} h par passage, ${o.frequencyLabel.toLowerCase()} : ${money(o.perVisitHT)} HT par passage${o.vatRate ? ` (${money(o.perVisitTTC)} TTC)` : ''}.`,
      ...(o.perMonthHT ? [`Soit environ ${money(o.perMonthHT)} HT par mois.`] : []),
      ...(message ? [message] : []),
      `Ce devis est valable ${QUOTE_VALID_DAYS} jours. Avec le bouton ci-dessous : vous le consultez, vous l'acceptez, vous choisissez l'adresse et la date du premier passage, et vous réglez ${o.allowTransfer ? 'par carte ou par virement' : 'par carte'}. Votre espace Proprigo est créé au passage.`,
    ], { label: 'Voir et accepter le devis', path: `/#/devis?t=${token}` });
    db_.log(db, `Devis ${number} envoyé à ${q.company} (${money(o.perVisitHT)} HT par passage).`);
    return { ok: true, message: `Devis ${number} envoyé à ${q.email}.`, quote: quoteView(fresh) };
  });
  // devis accepté : compte client de l'entreprise + passages planifiés, payés par carte dans son espace
  for (const [c, t] of [['planned_ids', 'TEXT'], ['planned_at', 'TEXT']]) {
    if (!db.prepare('PRAGMA table_info(quote_requests)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE quote_requests ADD COLUMN ${c} ${t}`);
  }
  const QUOTE_SERVICE = { bureaux: 'bureau', syndic: 'bureau', agence: 'grand', conciergerie: 'menage', autre: 'menage' };
  const planDates = (start, count, frequency) => {
    const out = [start];
    for (let k = 1; k < count; k++) {
      const step = frequency === 'twice' ? (k % 2 ? 3 : 4) : frequency === 'biweekly' ? 14 : frequency === 'monthly' ? 28 : 7;
      out.push(addDays(out[k - 1], step));
    }
    return out;
  };
  const planQuote = (q, body, opts = {}) => {
    const o = offerOf(q);
    const address = str(body.address, 200); const time = str(body.time, 5); const start = str(body.start, 10);
    const count = o.frequency === 'once' ? 1 : Math.round(Number(body.count));
    if (address.length < 5) throw new HttpError(400, 'Indiquez l\'adresse des passages.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Heure invalide.');
    if (!pricing.isValidDate(start) || start < pricing.todayParis(now())) throw new HttpError(400, 'Date du premier passage invalide.');
    if (!(count >= 1 && count <= 26)) throw new HttpError(400, 'Entre 1 et 26 passages à la fois.');
    const zone = pricing.zoneOf(q.cp);
    if (!zone) throw new HttpError(400, `Le code postal ${q.cp} n'est pas dans une zone desservie.`);
    // compte client de l'entreprise (créé s'il n'existe pas)
    let client = db.prepare("SELECT id, role FROM users WHERE email = ?").get(q.email);
    let welcome = null;
    if (client && client.role !== 'client') throw new HttpError(409, 'Cette adresse e-mail appartient à un compte qui n\'est pas un compte client.');
    if (!client && opts.password !== undefined && String(opts.password || '').length < 10) throw new HttpError(400, 'Choisissez un mot de passe d\'au moins 10 caractères pour votre espace.');
    if (!client && opts.password) {
      const cid = db_.createUser(db, { role: 'client', email: q.email, password: String(opts.password), name: q.name, phone: q.phone || '' });
      db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(cid);
      client = { id: cid, created: true };
    } else if (!client) {
      const cid = db_.createUser(db, { role: 'client', email: q.email, password: crypto.randomBytes(24).toString('hex'), name: q.name, phone: q.phone || '' });
      db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(cid);
      welcome = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO resets (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(welcome), cid, Date.now() + 7 * 864e5);
      client = { id: cid };
    }
    const wantsDebit = body.billing === 'prelevement' && (!opts.fromClient || o.allowTransfer);
    const sepa = wantsDebit ? db.prepare('SELECT sepa_pm FROM users WHERE id = ?').get(client.id).sepa_pm : null;
    const debitReady = Boolean(wantsDebit && sepa);
    const transfer = (body.billing === 'virement' && !opts.fromClient) || debitReady; // passages confirmés sans paiement immédiat
    const laterMode = debitReady ? 'prelevement' : 'virement';
    if (body.billing === 'virement' && !opts.fromClient) db.prepare("UPDATE users SET billing = 'virement' WHERE id = ?").run(client.id);
    if (wantsDebit) db.prepare("UPDATE users SET billing = 'prelevement' WHERE id = ?").run(client.id);
    const service = QUOTE_SERVICE[q.kind] || 'menage';
    const tasks = JSON.stringify(checklist.clean([], service));
    const dates = planDates(start, count, o.frequency);
    const ids = [];
    for (const date of dates) {
      const r = db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, checklist, photo_consent)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, 0)`).run(client.id, service, o.hours, q.cp, address, date, time, o.perVisitTTC, zone, transfer ? laterMode : stripeReady ? 'en_attente_paiement' : 'simule', tasks);
      ids.push(Number(r.lastInsertRowid));
      if (transfer) engine.assign(db, ids[ids.length - 1]);
    }
    db.prepare("UPDATE quote_requests SET status = 'planifie', planned_ids = ?, planned_at = ? WHERE id = ?").run(JSON.stringify(ids), now().toISOString(), q.id);
    db_.log(db, `Devis ${q.offer_number} planifié : ${ids.length} passage(s) pour ${q.company} (réservations n° ${ids.join(', ')}).`);
    const fmtD = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    const total = r2(o.perVisitTTC * ids.length);
    mailer.send(q.email, 'Vos passages Proprigo sont planifiés', 'Vos passages sont planifiés', [
      `Bonjour ${q.name.split(' ')[0]},`,
      `Merci pour votre confiance. Voici les passages prévus pour ${q.company}, à ${time}, ${address} :`,
      ...dates.slice(0, 12).map((d) => `• ${fmtD(d)}`), ...(dates.length > 12 ? [`… et ${dates.length - 12} autres passages.`] : []),
      `${o.perVisitTTC.toFixed(2).replace('.', ',')} € par passage, soit ${total.toFixed(2).replace('.', ',')} € pour ces ${ids.length} passage${ids.length > 1 ? 's' : ''}.`,
      ...(opts.fromClient && !transfer && !wantsDebit && stripeReady ? ['Si le paiement n\'a pas été fait juste après votre accord, réglez par carte dans votre espace Proprigo (bouton « Payer »).'] : []),
      opts.fromClient && !transfer && !wantsDebit && stripeReady ? 'Une facture est créée automatiquement après chaque paiement.' : wantsDebit ? 'Paiement par prélèvement SEPA : en fin de mois, vous recevez un relevé avec les factures des passages faits, prélevé quelques jours plus tard. Rien à payer maintenant.'
        : transfer ? 'Paiement par virement : en fin de mois, vous recevez un relevé avec les factures des passages faits, à régler sous 30 jours. Rien à payer maintenant.'
        : stripeReady ? 'Pour confirmer, réglez par carte dans votre espace Proprigo : un passage à la fois, ou tous en une fois. Une facture est créée automatiquement après chaque paiement.' : 'Vous retrouvez ces passages dans votre espace Proprigo.',
      ...(welcome ? ['Nous vous avons créé un espace client avec cette adresse e-mail. Choisissez votre mot de passe avec le bouton ci-dessous (lien valable 7 jours).'] : []),
    ], welcome ? { label: 'Créer mon mot de passe', path: `/#/nouveau-mot-de-passe?t=${welcome}` } : { label: 'Voir et payer mes passages', path: '/#/mes-reservations' });
    return { ids, clientId: client.id, welcome, transfer, dates, o, needsMandate: wantsDebit && !debitReady };
  };
  route('POST', '/api/admin/quote-requests/:id/plan', ({ user, id, body }) => {
    needStaff(user);
    const q = db.prepare('SELECT * FROM quote_requests WHERE id = ?').get(id);
    if (!q) throw new HttpError(404, 'Demande introuvable.');
    if (q.status !== 'accepte') throw new HttpError(409, q.status === 'planifie' ? 'Les passages sont déjà planifiés.' : 'Le devis doit d\'abord être accepté par le client.');
    const { ids, welcome } = planQuote(q, body);
    return { ok: true, message: `${ids.length} passage${ids.length > 1 ? 's' : ''} planifié${ids.length > 1 ? 's' : ''}. ${q.company} a reçu l'e-mail${welcome ? ' avec la création de son espace' : ''}.`, ids };
  });
  // payer plusieurs passages en une fois (entreprises, séries)
  route('POST', '/api/bookings/pay-many', async ({ user }) => {
    need(user, 'client');
    if (!stripeReady) throw new HttpError(503, 'Paiement indisponible.');
    const rows = db.prepare("SELECT * FROM bookings WHERE client_id = ? AND paid = 0 AND status <> 'annulee' AND payment_status IN ('en_attente_paiement', 'paiement_echoue') ORDER BY date, time LIMIT 30").all(user.id)
      .filter((b) => hoursBefore(b) >= 1);
    if (!rows.length) throw new HttpError(409, 'Aucun passage à payer.');
    try {
      const session = await stripePay.checkout({ db, ids: rows.map((b) => b.id), clientId: user.id, email: user.email, appUrl });
      return { checkout_url: session.url };
    } catch (e) {
      db_.log(db, `PAIEMENT GROUPÉ IMPOSSIBLE (${user.email}) : ${String(e.message).slice(0, 300)}`);
      throw new HttpError(502, 'Paiement indisponible. Réessayez dans un instant.');
    }
  });
  // ----- entreprises payées par virement : relevé de fin de mois -----
  const monthOf = (d) => String(d).slice(0, 7);
  const billView = (bill) => {
    const c = db.prepare('SELECT id, name, email, billing, sepa_last4 FROM users WHERE id = ?').get(bill.client_id) || {};
    const lines = db.prepare('SELECT b.id, b.date, b.time, b.service, b.hours, b.total, b.discount, b.cp, i.number FROM bookings b LEFT JOIN invoices i ON i.booking_id = b.id AND i.kind = \'facture\' WHERE b.bill_id = ? ORDER BY b.date, b.time').all(bill.id);
    return { ...bill, total: bill.total_cents / 100, client: c, lines, iban: company.iban || null, bic: company.bic || null, legal: legalInfo(), franchiseTVA };
  };
  route('GET', '/api/admin/transfers', ({ user }) => {
    need(user, 'admin');
    const clients = db.prepare("SELECT id, name, email, billing, sepa_last4, sepa_pm IS NOT NULL AS sepa_ready FROM users WHERE role = 'client' AND billing IN ('virement', 'prelevement') ORDER BY name").all().map((c) => ({
      ...c, toBill: db.prepare("SELECT substr(date, 1, 7) AS month, COUNT(*) AS n, ROUND(SUM(total), 2) AS total FROM bookings WHERE client_id = ? AND status = 'terminee' AND payment_status IN ('virement', 'prelevement') AND bill_id IS NULL GROUP BY month ORDER BY month").all(c.id),
    }));
    const bills = db.prepare('SELECT * FROM transfer_bills ORDER BY paid_at IS NOT NULL, issued_at DESC LIMIT 60').all().map(billView);
    return { clients, bills, ibanReady: Boolean(company.iban) };
  });
  route('POST', '/api/admin/clients/billing', ({ user, body }) => {
    need(user, 'admin');
    const email = str(body.email, 200).toLowerCase();
    const c = db.prepare("SELECT id, name, billing FROM users WHERE email = ? AND role = 'client'").get(email);
    if (!c) throw new HttpError(404, 'Aucun compte client avec cette adresse e-mail.');
    if (body.billing === 'prelevement') {
      // le client autorise lui-même le prélèvement (IBAN + mandat) sur la page Stripe
      mailer.send(email, 'Mettez en place le prélèvement Proprigo', 'Paiement par prélèvement', [`Bonjour ${c.name.split(' ')[0]},`,
        'Comme convenu, vos ménages peuvent être réglés par prélèvement SEPA en fin de mois, avec un relevé et une facture par passage.',
        'Il suffit d\'autoriser le prélèvement une fois : vous saisissez votre IBAN sur la page sécurisée de notre prestataire de paiement Stripe.'], { label: 'Autoriser le prélèvement', path: '/#/prelevement' });
      db_.log(db, `${c.name} (${email}) : invitation au prélèvement SEPA envoyée.`);
      return { ok: true, message: `Invitation envoyée à ${email}. Le prélèvement sera actif dès qu'il aura saisi son IBAN.` };
    }
    const billing = body.billing === 'virement' ? 'virement' : null;
    db.prepare('UPDATE users SET billing = ? WHERE id = ?').run(billing, c.id);
    let moved = 0;
    if (billing) {
      // les passages à venir pas encore payés passent en virement et sont confirmés
      for (const b of db.prepare("SELECT id FROM bookings WHERE client_id = ? AND paid = 0 AND status IN ('en_attente', 'proposee', 'attribuee') AND payment_status IN ('en_attente_paiement', 'paiement_echoue')").all(c.id)) {
        db.prepare("UPDATE bookings SET payment_status = 'virement' WHERE id = ?").run(b.id); engine.assign(db, b.id); moved++;
      }
    }
    db_.log(db, `${c.name} (${email}) : paiement ${billing ? 'par virement en fin de mois' : 'par carte'}.`);
    return { ok: true, message: billing ? `${c.name} paiera par virement en fin de mois.${moved ? ` ${moved} passage(s) à venir confirmé(s).` : ''}` : `${c.name} paiera de nouveau par carte.` };
  });
  const debitBill = async (billId) => {
    const bill = db.prepare('SELECT * FROM transfer_bills WHERE id = ?').get(billId);
    const c = db.prepare('SELECT id, email, name, billing, stripe_customer, sepa_pm, sepa_mandate FROM users WHERE id = ?').get(bill.client_id);
    if (!stripeReady || !c || c.billing !== 'prelevement' || !c.sepa_pm || bill.paid_at) return null;
    try {
      const pi = await stripePay.sepaCharge({ billId: bill.id, amountCents: bill.total_cents, customer: c.stripe_customer, paymentMethod: c.sepa_pm, mandate: c.sepa_mandate, description: `Proprigo ${bill.ref}` });
      db.prepare("UPDATE transfer_bills SET stripe_pi = ?, debit_status = 'en_cours' WHERE id = ?").run(pi.id, bill.id);
      return pi;
    } catch (e) {
      db.prepare("UPDATE transfer_bills SET debit_status = 'echoue' WHERE id = ?").run(bill.id);
      db_.log(db, `PRÉLÈVEMENT IMPOSSIBLE pour ${bill.ref} : ${String(e.message).slice(0, 300)}`);
      return null;
    }
  };
  route('POST', '/api/admin/transfer-bills', async ({ user, body }) => {
    need(user, 'admin');
    const clientId = Number(body.client_id); const month = str(body.month, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Mois invalide.');
    if (month >= monthOf(pricing.todayParis(now())) && !body.early) throw new HttpError(400, 'Le mois n\'est pas terminé. Facturez-le à partir du 1er du mois suivant.');
    const c = db.prepare("SELECT id, name, email, billing, sepa_pm, sepa_last4 FROM users WHERE id = ? AND role = 'client'").get(clientId);
    if (!c) throw new HttpError(404, 'Client introuvable.');
    const rows = db.prepare("SELECT id, total FROM bookings WHERE client_id = ? AND status = 'terminee' AND payment_status IN ('virement', 'prelevement') AND bill_id IS NULL AND substr(date, 1, 7) = ?").all(c.id, month);
    if (!rows.length) throw new HttpError(409, 'Aucun passage terminé à facturer pour ce mois.');
    const issued = now().toISOString();
    const due = addDays(pricing.todayParis(now()), 30);
    let billId;
    db.exec('BEGIN IMMEDIATE');
    try {
      const n = db.prepare('SELECT COUNT(*) AS n FROM transfer_bills').get().n + 1;
      billId = Number(db.prepare('INSERT INTO transfer_bills (client_id, month, total_cents, issued_at, due_date, ref) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.id, month, Math.round(rows.reduce((t, b) => t + b.total, 0) * 100), issued, due, `PROPRIGO-R${String(n).padStart(4, '0')}`).lastInsertRowid);
      for (const b of rows) db.prepare("UPDATE bookings SET payment_status = 'virement_facture', bill_id = ? WHERE id = ?").run(billId, b.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    for (const b of rows) issueInvoice(b.id);
    const debit = c.billing === 'prelevement' && c.sepa_pm;
    if (debit) await debitBill(billId);
    const v = billView(db.prepare('SELECT * FROM transfer_bills WHERE id = ?').get(billId));
    const mois = new Date(month + '-15T12:00:00Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    mailer.send(c.email, `Votre relevé Proprigo de ${mois}`, `Relevé de ${mois}`, [
      `Bonjour ${c.name.split(' ')[0]},`,
      `Voici le relevé de vos ${rows.length} passage${rows.length > 1 ? 's' : ''} de ${mois} : ${v.total.toFixed(2).replace('.', ',')} € au total, une facture par passage.`,
      ...(debit ? [`Ce montant sera prélevé sur votre compte (IBAN se terminant par ${c.sepa_last4 || '…'}) dans les prochains jours ouvrés, avec la référence ${v.ref}. Vous n'avez rien à faire.`]
        : [`À régler par virement avant le ${new Date(due + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}, avec la référence ${v.ref}.`,
          ...(company.iban ? [`IBAN : ${company.iban}${company.bic ? ` · BIC : ${company.bic}` : ''}`] : [])]),
    ], { label: 'Voir le relevé et les factures', path: `/#/releve?id=${billId}` });
    db_.log(db, `Relevé ${v.ref} (${mois}) envoyé à ${c.name} : ${v.total} €.`);
    return { ok: true, message: `Relevé ${v.ref} envoyé à ${c.email} : ${v.total.toFixed(2).replace('.', ',')} €${debit ? (v.debit_status === 'en_cours' ? ', prélèvement lancé.' : ' — le prélèvement n\'a pas pu être lancé, voir le journal.') : '.'}`, bill: v };
  });
  route('POST', '/api/admin/transfer-bills/:id/debit', async ({ user, id }) => {
    need(user, 'admin');
    const bill = db.prepare('SELECT * FROM transfer_bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, 'Relevé introuvable.');
    if (bill.paid_at) throw new HttpError(409, 'Ce relevé est déjà payé.');
    if (bill.debit_status === 'en_cours') throw new HttpError(409, 'Un prélèvement est déjà en cours.');
    const pi = await debitBill(bill.id);
    if (!pi) throw new HttpError(409, 'Prélèvement impossible : le client n\'a pas de mandat SEPA actif.');
    return { ok: true, message: `Prélèvement relancé pour ${bill.ref}.` };
  });
  route('POST', '/api/admin/transfer-bills/:id/paid', ({ user, id }) => {
    need(user, 'admin');
    const bill = db.prepare('SELECT * FROM transfer_bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, 'Relevé introuvable.');
    if (bill.paid_at) throw new HttpError(409, 'Ce relevé est déjà marqué payé.');
    db.prepare('UPDATE transfer_bills SET paid_at = ? WHERE id = ?').run(now().toISOString(), id);
    db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye_virement' WHERE bill_id = ?").run(id);
    db.prepare("UPDATE transfer_bills SET debit_status = NULL WHERE id = ? AND debit_status = 'echoue'").run(id);
    db_.log(db, `Virement reçu pour le relevé ${bill.ref} (${bill.total_cents / 100} €).`);
    return { ok: true, message: `Relevé ${bill.ref} marqué payé.` };
  });
  route('POST', '/api/me/sepa-setup', async ({ user }) => {
    need(user, 'client');
    if (!stripeReady) throw new HttpError(503, 'Prélèvement indisponible pour le moment.');
    try { return { checkout_url: (await stripePay.sepaSetup({ db, user, appUrl })).url }; }
    catch (e) { db_.log(db, `MANDAT SEPA IMPOSSIBLE (${user.email}) : ${String(e.message).slice(0, 300)}`); throw new HttpError(502, 'Prélèvement indisponible. Réessayez dans un instant.'); }
  });
  const activateMandate = async (sess) => {
    const uid = Number(sess.metadata && sess.metadata.sepa_user);
    const u = uid && db.prepare("SELECT id, email, name, stripe_customer FROM users WHERE id = ? AND role = 'client'").get(uid);
    if (!u || (sess.customer && u.stripe_customer && sess.customer !== u.stripe_customer)) return;
    const r = await stripePay.sepaSetupResult(typeof sess.setup_intent === 'string' ? sess.setup_intent : sess.setup_intent?.id);
    if (r.status !== 'succeeded' || !r.paymentMethod) return;
    db.prepare("UPDATE users SET billing = 'prelevement', sepa_pm = ?, sepa_mandate = ?, sepa_last4 = ? WHERE id = ?").run(r.paymentMethod, r.mandate, r.last4, u.id);
    let n = 0;
    for (const b of db.prepare("SELECT id FROM bookings WHERE client_id = ? AND paid = 0 AND status IN ('en_attente', 'proposee', 'attribuee') AND payment_status IN ('en_attente_paiement', 'paiement_echoue')").all(u.id)) {
      db.prepare("UPDATE bookings SET payment_status = 'prelevement' WHERE id = ?").run(b.id); engine.assign(db, b.id); n++;
    }
    db_.log(db, `Mandat SEPA actif pour ${u.name} (IBAN …${r.last4 || '?'}) : ${n} passage(s) confirmé(s).`);
    mailer.send(u.email, 'Prélèvement Proprigo activé', 'Prélèvement activé', [`Bonjour ${u.name.split(' ')[0]},`, `Votre autorisation de prélèvement est enregistrée (IBAN se terminant par ${r.last4 || '…'}).`,
      `${n ? `${n} passage(s) sont confirmés. ` : ''}En fin de mois, vous recevez le relevé avec une facture par passage, puis le montant est prélevé quelques jours plus tard.`], { label: 'Voir mes passages', path: '/#/mes-reservations' });
  };
  route('GET', '/api/transfer-bills', ({ user }) => {
    need(user, 'client');
    return db.prepare('SELECT id, month, total_cents, issued_at, due_date, paid_at, ref, debit_status FROM transfer_bills WHERE client_id = ? ORDER BY issued_at DESC').all(user.id).map((b) => ({ ...b, total: b.total_cents / 100 }));
  });
  route('GET', '/api/transfer-bills/:id', ({ user, id }) => {
    need(user);
    const bill = db.prepare('SELECT * FROM transfer_bills WHERE id = ?').get(id);
    if (!bill || !(user.role === 'admin' || bill.client_id === user.id)) throw new HttpError(404, 'Relevé introuvable.');
    return billView(bill);
  });
  const quoteByToken = (t) => {
    const token = String(t || '');
    if (!/^[a-f0-9]{48}$/.test(token)) throw new HttpError(404, 'Devis introuvable.');
    const q = db.prepare('SELECT * FROM quote_requests WHERE offer_token = ?').get(token);
    if (!q || !q.offer_json) throw new HttpError(404, 'Devis introuvable.');
    return q;
  };
  route('GET', '/api/devis', ({ query }) => {
    const q = quoteByToken(query.get('t'));
    return { number: q.offer_number, sentAt: q.offer_sent_at, status: q.status, answeredAt: q.answered_at, answerName: q.answer_name,
      client: { company: q.company, name: q.name, email: q.email, cp: q.cp, kind: QUOTE_KINDS[q.kind] }, offer: offerOf(q), franchiseTVA, legal: legalInfo(),
      hasAccount: Boolean(db.prepare("SELECT 1 FROM users WHERE email = ? AND role = 'client'").get(q.email)), cardPayment: stripeReady };
  });
  route('POST', '/api/devis/answer', async ({ body }) => {
    const q = quoteByToken(body.t);
    if (q.status !== 'envoye') throw new HttpError(409, q.status === 'accepte' ? 'Ce devis est déjà accepté. Merci !' : 'Ce devis n\'est plus ouvert. Contactez-nous pour une nouvelle proposition.');
    const o = offerOf(q);
    if (o.validUntil && o.validUntil < now().toISOString().slice(0, 10)) throw new HttpError(409, 'Ce devis a expiré. Contactez-nous pour une nouvelle proposition.');
    const accept = body.accept === true;
    const name = str(body.name, 80); const message = str(body.message, 1000);
    if (accept && name.length < 3) throw new HttpError(400, 'Écrivez votre prénom et votre nom pour accepter le devis.');
    if (accept && ['virement', 'prelevement'].includes(body.pay) && !o.allowTransfer) throw new HttpError(400, 'Le paiement en fin de mois n\'est pas proposé pour ce devis.');
    if (!accept && !message) throw new HttpError(400, 'Dites-nous ce qui ne convient pas, nous vous faisons une autre proposition.');
    db.prepare('UPDATE quote_requests SET status = ?, answered_at = ?, answer_name = ?, answer_message = ? WHERE id = ?').run(accept ? 'accepte' : 'refuse', now().toISOString(), name || null, message || null, q.id);
    if (accept) {
      // le client choisit lui-même l'adresse et les dates : passages créés, espace ouvert, paiement proposé tout de suite
      let plan;
      try { plan = planQuote({ ...q, status: 'accepte' }, { ...body, billing: body.pay === 'prelevement' ? 'prelevement' : 'carte' }, { fromClient: true, password: body.password || '' }); }
      catch (e) { db.prepare("UPDATE quote_requests SET status = 'envoye', answered_at = NULL, answer_name = NULL, answer_message = NULL WHERE id = ?").run(q.id); throw e; }
      for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").all()) {
        mailer.send(a.email, `Devis ${q.offer_number} accepté : ${q.company}`, 'Devis accepté 🎉', [`${q.company} (${q.name}, ${q.email}${q.phone ? `, ${q.phone}` : ''})`, `Bon pour accord signé en ligne par ${name}.`,
          `${plan.ids.length} passage(s) créé(s) à partir du ${plan.dates[0]}, ${plan.needsMandate || plan.transfer ? 'prélèvement SEPA en fin de mois (mandat signé sur Stripe)' : 'paiement par carte'}.`, ...(message ? [`Message : ${message}`] : [])], { label: 'Voir les réservations', path: '/#/admin' });
      }
      let checkoutUrl = null;
      if (plan.needsMandate && stripeReady) {
        // prélèvement choisi : le client signe le mandat SEPA sur la page Stripe ; ses passages sont confirmés ensuite
        try { checkoutUrl = (await stripePay.sepaSetup({ db, user: { id: plan.clientId, email: q.email, name: q.company }, appUrl })).url; }
        catch (e) { db_.log(db, `MANDAT SEPA IMPOSSIBLE (devis ${q.offer_number}) : ${String(e.message).slice(0, 300)}`); }
      } else if (!plan.transfer && stripeReady) {
        const soon = addDays(pricing.todayParis(now()), 31);
        const due = db.prepare(`SELECT id FROM bookings WHERE id IN (${plan.ids.join(',')}) AND date <= ? ORDER BY date`).all(soon).map((r) => r.id);
        try { checkoutUrl = (await stripePay.checkout({ db, ids: due.length ? due : [plan.ids[0]], clientId: plan.clientId, email: q.email, appUrl })).url; }
        catch (e) { db_.log(db, `PAIEMENT DU DEVIS ${q.offer_number} IMPOSSIBLE : ${String(e.message).slice(0, 300)}`); }
      }
      return { data: { ok: true, checkout_url: checkoutUrl, next: '/#/mes-reservations',
        message: plan.needsMandate ? (checkoutUrl ? 'Merci ! Dernière étape : l\'autorisation de prélèvement (IBAN) sur la page sécurisée Stripe.' : 'Merci ! Vos passages sont réservés. Autorisez le prélèvement depuis votre espace.')
          : plan.transfer ? 'Merci ! Vos passages sont réservés. Le relevé sera prélevé en fin de mois.' : checkoutUrl ? 'Merci ! Dernière étape : le paiement par carte.' : 'Merci ! Vos passages sont réservés. Réglez-les par carte dans votre espace.' },
        headers: { 'Set-Cookie': login(null, plan.clientId) } };
    }
    db_.log(db, `Devis ${q.offer_number} ${accept ? `accepté par ${name}` : 'refusé'} (${q.company}).`);
    for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").all()) {
      mailer.send(a.email, `Devis ${q.offer_number} ${accept ? 'accepté' : 'refusé'} : ${q.company}`, accept ? 'Devis accepté 🎉' : 'Devis refusé',
        [`${q.company} (${q.name}, ${q.email}${q.phone ? `, ${q.phone}` : ''})`, accept ? `Bon pour accord signé en ligne par ${name}.` : 'Le client a refusé le devis.', ...(message ? [`Message : ${message}`] : []), accept ? 'Prochaine étape : appelez le client pour fixer les dates, puis créez les ménages.' : 'Vous pouvez lui envoyer une nouvelle proposition depuis « Demandes de devis ».'], null);
    }
    mailer.send(q.email, accept ? `Devis ${q.offer_number} accepté` : `Devis ${q.offer_number} : votre réponse`, accept ? 'Merci, votre devis est accepté' : 'Merci pour votre réponse',
      [`Bonjour ${q.name.split(' ')[0]},`, accept ? 'Nous avons bien reçu votre accord. Nous vous appelons très vite pour fixer les dates des premiers passages.' : 'Nous avons bien noté vos remarques et revenons vers vous avec une nouvelle proposition.'], null);
    return { ok: true, message: accept ? 'Merci ! Votre devis est accepté. Nous vous appelons très vite pour fixer les dates.' : 'Merci, nous revenons vers vous avec une nouvelle proposition.' };
  });

  route('POST', '/api/account/password', ({ user, body, req }) => {
    need(user);
    const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
    if (!db_.checkPassword(String(body.current || ''), u.pass_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect.');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 10) throw new HttpError(400, 'Nouveau mot de passe : 10 caractères minimum.');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(db_.hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, cookieOf(req, 'sid') || '');
    mailer.send(user.email, 'Votre mot de passe a été changé', 'Mot de passe changé', ["Le mot de passe de votre compte Proprigo vient d'être changé.", "Si ce n'est pas vous, écrivez-nous tout de suite."], null);
    return { ok: true, message: 'Mot de passe changé. Vos autres appareils sont déconnectés.' };
  });
  // intervenantes : demande de suppression (traitée par l'équipe, car des documents doivent être gardés)
  route('POST', '/api/account/delete-request', ({ user, body }) => {
    need(user);
    if (user.role !== 'intervenante') throw new HttpError(400, 'Cette demande concerne les comptes intervenante.');
    const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
    if (!db_.checkPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(400, 'Mot de passe incorrect.');
    if (!db.prepare('INSERT OR IGNORE INTO mail_sent (key) VALUES (?)').run(`delreq-${user.id}-${new Date().toISOString().slice(0, 10)}`).changes) return { ok: true, message: 'Demande déjà envoyée aujourd\'hui. L\'équipe vous répond par e-mail.' };
    db_.log(db, `Demande de suppression du compte intervenante n° ${user.id} (${user.name}).`);
    for (const to of ownerEmails()) mailer.send(to, `Suppression de compte demandée : ${user.name}`, 'Une intervenante demande la suppression de son compte', [`${user.name} (${user.email}) demande la fermeture de son compte.`, 'À faire sous 30 jours : payer les dernières missions, retirer l\'intervenante de l\'équipe, puis effacer ses documents.'], null);
    mailer.send(user.email, 'Votre demande de suppression de compte', 'Demande bien reçue', ['Nous avons bien reçu votre demande de suppression de compte.', 'Nous la traitons sous 30 jours, après le paiement de vos dernières missions, et vous confirmons par e-mail.'], null);
    return { ok: true, message: 'Demande envoyée. L\'équipe ferme votre compte sous 30 jours et vous confirme par e-mail.' };
  });
  route('POST', '/api/account/delete', ({ user, body }) => {
    need(user);
    if (user.role !== 'client') throw new HttpError(400, "Pour fermer un compte intervenante ou administrateur, écrivez à l'équipe Proprigo : certains documents doivent être conservés.");
    const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
    if (!db_.checkPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(400, 'Mot de passe incorrect.');
    const active = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE client_id = ? AND status IN ('en_attente','proposee','attribuee','en_cours')").get(user.id).n;
    if (active) throw new HttpError(409, `Vous avez ${active} ménage(s) à venir. Annulez-les d'abord depuis « Mes réservations ».`);
    // photos supprimées ; les réservations passées restent (factures : 10 ans) mais sans nom, e-mail ni téléphone
    for (const ph of db.prepare('SELECT p.id, p.file FROM photos p JOIN bookings b ON b.id = p.booking_id WHERE b.client_id = ?').all(user.id)) {
      try { fs.unlinkSync(path.join(PHOTOS, path.basename(ph.file))); } catch { /* déjà supprimée */ }
      db.prepare('DELETE FROM photos WHERE id = ?').run(ph.id);
    }
    db.prepare('DELETE FROM favorites WHERE client_id = ?').run(user.id);
    db.prepare('UPDATE bookings SET home_id = NULL WHERE client_id = ?').run(user.id);
    db.prepare('DELETE FROM homes WHERE client_id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM resets WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM native_push WHERE user_id = ?').run(user.id);
    db.prepare("UPDATE users SET email = ?, name = 'Client supprimé', phone = NULL, pass_hash = ? WHERE id = ?").run(`supprime-${user.id}@proprigo.invalid`, 'x:' + crypto.randomBytes(16).toString('hex'), user.id);
    db_.log(db, `Compte client n° ${user.id} supprimé à sa demande (données personnelles effacées).`);
    mailer.send(user.email, 'Votre compte Proprigo est supprimé', 'Compte supprimé', ['Votre compte et vos données personnelles ont été supprimés.', 'Les factures sont conservées sans vos coordonnées, comme la loi le demande.'], null);
    return { data: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  });

  route('POST', '/api/logout', ({ req }) => {
    const t = cookieOf(req, 'sid');
    if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
    return { data: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  });

  route('POST', '/api/quote', ({ body, user }) => {
    const q = pricing.quote({ ...body, volume: volumeRate(user) }, now());
    if (q.ok && user && user.role === 'client') {
      const d = Math.min(creditOf(user.id), q.total);
      if (d > 0) { q.discount = d; q.lines = [...q.lines, { label: 'Crédit Proprigo (parrainage, carte cadeau ou pack)', amount: -d }]; q.total = Math.round((q.total - d) * 100) / 100; }
    }
    return q;
  });

  route('POST', '/api/waitlist', ({ body }) => {
    const email = str(body.email, 120).toLowerCase();
    const cp = str(body.cp, 5);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
    if (!pricing.zoneOf(cp)) throw new HttpError(400, 'Code postal invalide.');
    db.prepare('INSERT INTO waitlist (email, cp) VALUES (?, ?)').run(email, cp);
    db_.log(db, `Liste d'attente : nouvelle demande au ${cp}.`);
    return { ok: true };
  });

  // ----- client -----
  route('GET', '/api/slots', ({ query, user }) => {
    const date = query.get('date'); const cp = query.get('cp'); const hours = Number(query.get('hours'));
    const service = pricing.SERVICES.includes(query.get('service')) ? query.get('service') : 'menage';
    if (!pricing.isValidDate(date) || !pricing.zoneOf(cp) || !(hours >= 1 && hours <= 12)) return { slots: [] };
    const later = (t) => date !== pricing.todayParis(now()) || engine.toMin(t) >= engine.toMin(nowParisHM()) + MIN_LEAD_MIN;
    const slots = engine.requestSlots({ hours, service }).filter(later); // créneaux demandables, sous réserve d'attribution par l'équipe
    // client connecté avec une intervenante préférée : ses heures libres ce jour-là
    let preferred = null;
    if (user && user.role === 'client') {
      const homeId = Number(query.get('home_id')) || null;
      const asked = pastWorker(user.id, query.get('worker_id')) ? Number(query.get('worker_id')) : null;
      const pid = asked || engine.preferredIds(db, { client_id: user.id, home_id: homeId, series_id: null })[0];
      if (pid) preferred = { id: pid, name: engine.firstName(db, pid), gender: genderOf(pid), slots: engine.slotsFor(db, pid, { date, cp, hours }).filter(later) };
    }
    return { slots, preferred };
  });

  // Paiement d'une intervention future d'une série (paiement individuel).
  route('POST', '/api/bookings/:id/pay', async ({ user, id }) => {
    need(user, 'client');
    if (!stripeReady) throw new HttpError(503, 'Paiement indisponible.');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    if (b.status === 'annulee' || b.paid || b.payment_status === 'paye') throw new HttpError(409, 'Paiement impossible pour cette réservation.');
    if (hoursBefore(b) < 1) throw new HttpError(409, 'Délai dépassé : contactez PROPRIGO.');
    try {
      const session = await stripePay.checkout({ db, ids: [id], clientId: user.id, email: user.email, appUrl });
      return { checkout_url: session.url };
    } catch (e) {
      if (/already completed/.test(e.message)) throw new HttpError(409, 'Paiement déjà reçu : la confirmation arrive dans quelques secondes.');
      db_.log(db, `PAIEMENT IMPOSSIBLE pour la réservation n° ${id} (${user.email}) : ${String(e.message).slice(0, 300)}`);
      throw new HttpError(502, 'Paiement indisponible. Réessayez dans un instant.');
    }
  });
  // ---- double encaissement Stripe : remboursement automatique de ce qui a été payé en trop
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_intents_seen (payment_intent TEXT PRIMARY KEY, booking_ids TEXT NOT NULL, amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_duplicate_refunds (payment_intent TEXT PRIMARY KEY, session_id TEXT, client_id INTEGER, booking_ids TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, refund_id TEXT, status TEXT NOT NULL DEFAULT 'a_rembourser', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE TABLE IF NOT EXISTS stripe_claims (booking_id INTEGER PRIMARY KEY, payment_intent TEXT NOT NULL)');
  const euros = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
  async function refundDuplicateCharge({ paymentIntent, amountCents, sessionId, ids, clientId }) {
    if (!paymentIntent) {
      db_.log(db, `ALERTE DOUBLE PAIEMENT réservation(s) ${ids.join(', ')} : encaissement sans référence Stripe, à rembourser dans Stripe.`);
      return;
    }
    try {
      const r = await stripePay.refundDuplicate({ db, paymentIntent, amountCents, sessionId, bookingIds: ids, clientId });
      if (r.already) return;
      if (sessionId) db.prepare("UPDATE stripe_payments SET status = 'duplicate_refunded' WHERE session_id = ?").run(sessionId);
      db_.log(db, `Double paiement réservation(s) ${ids.join(', ')} : ${euros(amountCents)} remboursés automatiquement (${r.status === 'pending' ? 'en cours' : 'effectué'}).`);
      const u = clientId ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(clientId) : null;
      if (u) mailer.send(u.email, 'Paiement en double remboursé', 'Paiement en double remboursé', [
        `Bonjour ${u.name.split(' ')[0]},`,
        `Votre réservation n° ${ids.join(', ')} a été payée deux fois. Le deuxième paiement de ${euros(amountCents)} vient d'être remboursé automatiquement.`,
        "Le remboursement apparaît sur votre compte sous 5 à 10 jours selon votre banque. Votre réservation reste confirmée et payée une seule fois.",
      ], { label: 'Mes réservations', path: '/#/mes-reservations' });
    } catch (e) {
      db_.log(db, `ALERTE DOUBLE PAIEMENT réservation(s) ${ids.join(', ')} : remboursement automatique de ${euros(amountCents)} impossible (${e.message}). À rembourser dans Stripe.`);
    }
  }
  // ---- paiement en deux temps : le premier paiement autorisé est encaissé, les autres sont annulés
  const idsOf = (meta) => {
    let ids = [];
    try { ids = JSON.parse(meta?.booking_ids || '[]'); } catch { ids = []; }
    return Array.isArray(ids) ? [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))] : [];
  };
  // ---- factures et avoirs : numéro unique, qui se suit sans trou, par année (F2026-000001, A2026-000001)
  // entreprises payées par virement : relevé mensuel des factures
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'billing')) db.exec('ALTER TABLE users ADD COLUMN billing TEXT');
  if (!db.prepare('PRAGMA table_info(bookings)').all().some((c) => c.name === 'bill_id')) db.exec('ALTER TABLE bookings ADD COLUMN bill_id INTEGER');
  for (const c of ['stripe_customer', 'sepa_pm', 'sepa_mandate', 'sepa_last4']) if (!db.prepare('PRAGMA table_info(users)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS transfer_bills (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, month TEXT NOT NULL, total_cents INTEGER NOT NULL,
    issued_at TEXT NOT NULL, due_date TEXT NOT NULL, paid_at TEXT, ref TEXT NOT NULL UNIQUE)`);
  for (const c of ['stripe_pi', 'debit_status']) if (!db.prepare('PRAGMA table_info(transfer_bills)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE transfer_bills ADD COLUMN ${c} TEXT`);
  // paiement en fin de mois : 'virement' (le client vire) ou 'prelevement' (mandat SEPA actif chez Stripe)
  const laterPay = (u) => (u && u.billing === 'virement' ? 'virement' : u && u.billing === 'prelevement' && (u.sepa_ready || u.sepa_pm) ? 'prelevement' : null);
  db.exec(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('facture','avoir')), year INTEGER NOT NULL, seq INTEGER NOT NULL,
    number TEXT NOT NULL UNIQUE, booking_id INTEGER NOT NULL, client_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, tva_rate REAL NOT NULL,
    ref_invoice TEXT, refund_key TEXT UNIQUE, issued_at TEXT NOT NULL, UNIQUE(kind, year, seq))`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_facture ON invoices(booking_id) WHERE kind = 'facture'");
  const company = companyConfig || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'entreprise.json'), 'utf8')); } catch { return {}; }
  })();
  // Auto-entrepreneur (micro-entreprise) : franchise en base de TVA, pas de TVA facturée (art. 293 B du CGI).
  const franchiseTVA = String(company.regimeTVA || '').toLowerCase() === 'franchise';
  const TVA_SEUIL = 37500; const TVA_SEUIL_MAJORE = 41250; // prestations de services, seuils 2026 (CA hors taxes)
  const companyMissing = ['raisonSociale', 'adresse', 'siret'].filter((k) => !String(company[k] || '').trim());
  const tvaOf = (b) => (franchiseTVA ? 0 : pricing.PRO_SERVICES.includes(b.service) ? pricing.COSTS.tvaPro : pricing.COSTS.tvaParticulier);
  const caAnnee = (year) => { // chiffre d'affaires facturé de l'année (factures moins avoirs), en euros
    const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'facture' THEN amount_cents ELSE -amount_cents END), 0) AS c FROM invoices WHERE year = ? AND tva_rate = 0").get(year);
    return r.c / 100;
  };
  function tvaWatch() { // prévient le responsable avant de dépasser le seuil de la franchise
    if (!franchiseTVA) return;
    const year = parisYear(); const ca = caAnnee(year);
    const alert = (key, subject, lines) => { if (db.prepare('INSERT OR IGNORE INTO mail_sent (key) VALUES (?)').run(key).changes) for (const to of ownerEmails()) mailer.send(to, subject, 'Franchise de TVA', lines, null); };
    const fmt = (n) => Math.round(n).toLocaleString('fr-FR') + ' €';
    if (ca >= TVA_SEUIL_MAJORE) alert(`tva-majore-${year}`, 'TVA : seuil majoré dépassé', [`Chiffre d'affaires ${year} : ${fmt(ca)}, au-delà de ${fmt(TVA_SEUIL_MAJORE)}.`, 'La franchise de TVA est perdue dès ce mois : appelez votre expert-comptable avant de facturer à nouveau, les prix et les factures doivent passer avec TVA.']);
    else if (ca >= TVA_SEUIL) alert(`tva-seuil-${year}`, 'TVA : seuil de 37 500 € dépassé', [`Chiffre d'affaires ${year} : ${fmt(ca)}.`, `Vous gardez la franchise cette année tant que vous restez sous ${fmt(TVA_SEUIL_MAJORE)}, mais vous la perdez au 1er janvier prochain. Prévenez votre expert-comptable.`]);
    else if (ca >= TVA_SEUIL * 0.8) alert(`tva-80-${year}`, 'TVA : 80 % du seuil de franchise atteint', [`Chiffre d'affaires ${year} : ${fmt(ca)} sur ${fmt(TVA_SEUIL)}.`, 'Pensez à préparer le passage à la TVA avec votre expert-comptable.']);
  }
  const parisYear = () => Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric' }).format(now()));
  function nextNumber(kind) {
    const year = parisYear();
    const seq = (db.prepare('SELECT MAX(seq) AS m FROM invoices WHERE kind = ? AND year = ?').get(kind, year).m || 0) + 1;
    return { year, seq, number: `${kind === 'facture' ? 'F' : 'A'}${year}-${String(seq).padStart(6, '0')}` };
  }
  /** Facture d'une réservation payée : créée une seule fois, au moment du paiement. */
  function issueInvoice(bookingId) {
    const existing = db.prepare("SELECT * FROM invoices WHERE kind = 'facture' AND booking_id = ?").get(bookingId);
    if (existing) return existing;
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b || (!b.paid && b.payment_status !== 'virement_facture') || b.payment_status === 'garantie') return null; // retour gratuit : rien n'est facturé
    db.exec('BEGIN IMMEDIATE');
    try {
      const n = nextNumber('facture');
      db.prepare("INSERT INTO invoices (kind, year, seq, number, booking_id, client_id, amount_cents, tva_rate, issued_at) VALUES ('facture', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(n.year, n.seq, n.number, b.id, b.client_id, Math.round((b.total + (b.discount || 0)) * 100), tvaOf(b), now().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    try { tvaWatch(); } catch { /* l'alerte ne doit jamais bloquer une facture */ }
    return db.prepare("SELECT * FROM invoices WHERE kind = 'facture' AND booking_id = ?").get(bookingId);
  }
  /** Avoir pour un remboursement ; refundKey empêche d'en créer deux pour le même remboursement. */
  function issueCreditNote(bookingId, amountCents, refundKey) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
    const known = db.prepare('SELECT * FROM invoices WHERE refund_key = ?').get(refundKey);
    if (known) return known;
    const inv = issueInvoice(bookingId);
    if (!inv) return null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const n = nextNumber('avoir');
      db.prepare("INSERT INTO invoices (kind, year, seq, number, booking_id, client_id, amount_cents, tva_rate, ref_invoice, refund_key, issued_at) VALUES ('avoir', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(n.year, n.seq, n.number, bookingId, inv.client_id, Math.min(amountCents, inv.amount_cents), inv.tva_rate, inv.number, refundKey, now().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return db.prepare('SELECT * FROM invoices WHERE refund_key = ?').get(refundKey);
  }
  // Réservations déjà payées avant cette version : une facture chacune, dans l'ordre des réservations.
  for (const r of db.prepare("SELECT b.id FROM bookings b WHERE b.paid = 1 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.kind = 'facture' AND i.booking_id = b.id) ORDER BY b.id").all()) issueInvoice(r.id);

  // ---- après un paiement confirmé : facture, e-mail au client, e-mail à l'équipe (une seule fois chacun)
  const ownerEmails = () => db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").all().map((a) => a.email);
  const SERVICE_NAME = { menage: 'Ménage', grand: 'Grand nettoyage', airbnb: 'Ménage Airbnb', bureau: 'Nettoyage de bureaux' };
  function notifyTeamNewBooking(ids, { paidBy }) {
    const first = db.prepare('SELECT * FROM bookings WHERE id = ?').get(ids[0]);
    if (!first) return;
    const client = db.prepare('SELECT name, email, company FROM users WHERE id = ?').get(first.client_id) || {};
    const total = ids.reduce((t, id) => t + (db.prepare('SELECT total FROM bookings WHERE id = ?').get(id)?.total || 0), 0);
    for (const to of ownerEmails()) mailer.send(to, `Nouvelle réservation n° ${first.id} : ${fr(first.date)} à ${first.time}, ${first.cp}`, 'Nouvelle réservation à attribuer', [
      `${SERVICE_NAME[first.service] || 'Ménage'} ${first.hours} h, le ${fr(first.date)} à ${first.time}, ${first.cp}.`,
      `Client : ${client.company ? `${client.company} (${client.name})` : client.name || '?'}.`,
      `${ids.length > 1 ? `${ids.length} interventions, ` : ''}${paidBy} : ${String(total.toFixed(2)).replace('.', ',')} €.`,
      'Aucune intervenante n\'est encore attribuée.',
    ], { label: 'Attribuer', path: '/#/admin' }, { key: `admin-new-${first.id}` });
  }
  function afterPaid(ids) {
    const paid = ids.map((id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id)).filter((b) => b && b.paid);
    for (const b of paid) issueInvoice(b.id);
    const active = paid.filter((b) => b.status !== 'annulee');
    if (!active.length) return;
    const first = active[0];
    const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(first.client_id);
    const inv = db.prepare("SELECT number FROM invoices WHERE kind = 'facture' AND booking_id = ?").get(first.id);
    const total = active.reduce((t, b) => t + b.total, 0);
    if (u) mailer.send(u.email, `Réservation confirmée : ${fr(first.date)} à ${first.time}`, 'Paiement reçu, votre ménage est réservé', [
      `Bonjour ${u.name.split(' ')[0]},`,
      `Nous avons bien reçu votre paiement de ${String(total.toFixed(2)).replace('.', ',')} €.`,
      `${SERVICE_NAME[first.service] || 'Ménage'} le ${fr(first.date)} à ${first.time}, ${first.address} (${first.cp}).${active.length > 1 ? ` Avec ${active.length - 1} autre(s) intervention(s).` : ''}`,
      'Nous vous écrivons dès qu\'une intervenante est attribuée.',
      `Annulation gratuite jusqu'à ${FREE_CANCEL_HOURS} h avant le ménage.${inv ? ` Votre facture ${inv.number} est disponible dans « Mes réservations ».` : ''}`,
    ], { label: 'Voir ma réservation', path: '/#/mes-reservations' }, { key: `paid-confirm-${first.id}` });
    notifyTeamNewBooking(active.map((b) => b.id), { paidBy: 'payé par carte' });
  }

  function markBookingsPaid(ids, sessionId, piId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (sessionId) db.prepare("UPDATE stripe_payments SET status = 'paid', payment_intent = ? WHERE session_id = ? AND status IN ('pending', 'expired', 'failed')").run(piId, sessionId);
      for (const id of ids) {
        db.prepare('INSERT OR IGNORE INTO stripe_claims (booking_id, payment_intent) VALUES (?, ?)').run(id, piId);
        const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
        if (!b || b.paid) continue;
        if (b.status === 'annulee') db.prepare("UPDATE bookings SET paid = 1, payment_status = 'a_rembourser', refund_amount = total WHERE id = ?").run(id);
        else db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye' WHERE id = ?").run(id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    for (const id of ids) {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
      if (b && b.payment_status === 'paye' && b.status === 'en_attente') db_.log(db, `Réservation n° ${id} payée : attribution manuelle nécessaire.`);
    }
    afterPaid(ids);
  }
  async function settleIntent(piId) {
    const pi = await stripePay.getIntent(piId);
    if (pi.status !== 'requires_capture' && pi.status !== 'succeeded') return;
    const ids = idsOf(pi.metadata);
    if (!ids.length) return; // carte cadeau, pack… : pas concerné
    const clientId = Number(pi.metadata?.client_id) || null;
    const amount = pi.status === 'succeeded' ? pi.amount_received : pi.amount_capturable;
    let verdict;
    db.exec('BEGIN IMMEDIATE');
    try {
      const bookings = ids.map((id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
      const claims = ids.map((id) => db.prepare('SELECT payment_intent FROM stripe_claims WHERE booking_id = ?').get(id));
      const expected = bookings.reduce((t, b) => t + (b ? Math.round(b.total * 100) : 0), 0);
      if (claims.every((c) => c && c.payment_intent === pi.id)) verdict = 'retenu';
      else if (claims.some((c) => c && c.payment_intent !== pi.id) || bookings.some((b) => b && (b.paid || b.payment_status === 'paye'))) verdict = 'doublon';
      else if (bookings.some((b) => !b || b.status === 'annulee')) verdict = 'annulee';
      else if (pi.currency !== 'eur' || amount !== expected || (clientId && bookings.some((b) => b.client_id !== clientId))) verdict = 'incoherent';
      else {
        for (const id of ids) db.prepare('INSERT OR IGNORE INTO stripe_claims (booking_id, payment_intent) VALUES (?, ?)').run(id, pi.id);
        verdict = 'retenu';
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    if (verdict === 'retenu') {
      if (pi.status === 'requires_capture') {
        try { await stripePay.captureIntent(pi.id); }
        catch (e) {
          const now = await stripePay.getIntent(pi.id);
          if (now.status === 'canceled') { // autorisation expirée : la réservation redevient payable
            db.prepare('DELETE FROM stripe_claims WHERE payment_intent = ?').run(pi.id);
            db_.log(db, `Paiement réservation(s) ${ids.join(', ')} : autorisation expirée avant encaissement, aucun débit.`);
            return;
          }
          throw e; // Stripe réessaiera le webhook
        }
      }
      const sessionId = await stripePay.sessionForIntent(pi.id).catch(() => null)
        || db.prepare("SELECT session_id FROM stripe_payments WHERE booking_ids = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(JSON.stringify(ids))?.session_id || null;
      markBookingsPaid(ids, sessionId, pi.id);
      await stripePay.expireOtherSessions(db, ids, sessionId || '');
      await reconcileDuplicateIntents(ids);
      return;
    }
    // Paiement en trop ou impossible : on annule l'autorisation, la carte n'est pas débitée.
    const known = db.prepare('SELECT status FROM stripe_duplicate_refunds WHERE payment_intent = ?').get(pi.id);
    if (known && known.status !== 'echec') return;
    if (pi.status === 'requires_capture') {
      const r = await stripePay.cancelIntent(pi.id);
      if (r === 'canceled') {
        const sessionId = await stripePay.sessionForIntent(pi.id).catch(() => null);
        db.prepare(`INSERT INTO stripe_duplicate_refunds (payment_intent, session_id, client_id, booking_ids, amount_cents, status) VALUES (?, ?, ?, ?, ?, 'annule')
          ON CONFLICT(payment_intent) DO UPDATE SET status = 'annule'`).run(pi.id, sessionId, clientId, JSON.stringify(ids), amount);
        if (sessionId) db.prepare("UPDATE stripe_payments SET status = 'duplicate_canceled', payment_intent = ? WHERE session_id = ? AND status <> 'paid'").run(pi.id, sessionId);
        const why = verdict === 'doublon' ? 'déjà payée' : verdict === 'annulee' ? 'annulée' : 'montant incohérent';
        db_.log(db, `Paiement en double bloqué réservation(s) ${ids.join(', ')} (${why}) : ${euros(amount)} non encaissés, aucun débit.`);
        const u = clientId ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(clientId) : null;
        if (u && verdict === 'doublon') mailer.send(u.email, 'Deuxième paiement annulé', 'Deuxième paiement annulé', [
          `Bonjour ${u.name.split(' ')[0]},`,
          `Votre réservation n° ${ids.join(', ')} était déjà payée. Le deuxième paiement de ${euros(amount)} a été annulé : votre carte n'est pas débitée.`,
          'Selon votre banque, une ligne « en attente » peut apparaître quelques heures puis disparaître d\'elle-même.',
        ], { label: 'Mes réservations', path: '/#/mes-reservations' });
        return;
      }
    }
    // Déjà encaissé (ancien paiement sans blocage) : remboursement complet.
    if (verdict === 'doublon') await refundDuplicateCharge({ paymentIntent: pi.id, amountCents: amount, sessionId: null, ids, clientId });
    else db_.log(db, `ALERTE PAIEMENT réservation(s) ${ids.join(', ')} : ${euros(amount)} encaissés alors que la réservation est ${verdict === 'annulee' ? 'annulée' : 'incohérente'}. À vérifier dans Stripe.`);
  }
  async function reconcileDuplicateIntents(ids) {
    for (const seen of db.prepare("SELECT * FROM stripe_intents_seen WHERE created_at >= datetime('now', '-60 days')").all()) {
      const seenIds = JSON.parse(seen.booking_ids);
      if (!seenIds.some((id) => ids.includes(id))) continue;
      // Ce PaymentIntent est déjà rattaché à une session connue (retenue, ou doublon déjà traité).
      if (db.prepare('SELECT 1 FROM stripe_payments WHERE payment_intent = ?').get(seen.payment_intent)) continue;
      if (db.prepare('SELECT 1 FROM stripe_claims WHERE payment_intent = ?').get(seen.payment_intent)) continue;
      if (db.prepare("SELECT 1 FROM stripe_duplicate_refunds WHERE payment_intent = ? AND status <> 'echec'").get(seen.payment_intent)) continue;
      // Seulement si la réservation est déjà payée par un AUTRE encaissement identifié.
      const kept = db.prepare(`SELECT * FROM stripe_payments WHERE status = 'paid' AND payment_intent IS NOT NULL AND payment_intent <> ?
        AND EXISTS (SELECT 1 FROM json_each(booking_ids) WHERE value IN (${seenIds.map(() => '?').join(',')})) ORDER BY created_at LIMIT 1`).get(seen.payment_intent, ...seenIds);
      if (!kept) continue;
      await refundDuplicateCharge({ paymentIntent: seen.payment_intent, amountCents: seen.amount_cents, sessionId: null, ids: seenIds, clientId: kept.client_id });
    }
  }

  route('GET', '/api/payments/status', ({ user, query }) => {
    need(user, 'client');
    const id = Number(query.get('booking'));
    const b = db.prepare('SELECT id, paid, payment_status FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    return b;
  });

  // remise selon le volume du mois (comptes société) : 10 ménages → −5 %, 30 → −10 %
  const volumeRate = (u) => {
    if (!u || u.role !== 'client') return 0;
    const c = db.prepare('SELECT company FROM users WHERE id = ?').get(u.id);
    if (!c || !c.company) return 0;
    const n = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE client_id = ? AND status <> 'annulee' AND substr(date, 1, 7) = ?").get(u.id, pricing.todayParis(now()).slice(0, 7)).n;
    return n >= 30 ? 0.1 : n >= 10 ? 0.05 : 0;
  };
  const creditOf = (clientId) => {
    const got = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM credits WHERE user_id = ?').get(clientId).t;
    const used = db.prepare("SELECT COALESCE(SUM(discount), 0) AS t FROM bookings WHERE client_id = ? AND status <> 'annulee'").get(clientId).t;
    return Math.max(0, Math.round((got - used) * 100) / 100);
  };
  route('POST', '/api/bookings', async ({ user, body }) => {
    need(user, 'client');
    needVerifiedEmail(user);
    // Sécurité : en production, aucune réservation sans vrai paiement en ligne.
    if (production && !stripeReady) throw new HttpError(503, "Le paiement en ligne n'est pas encore activé : les réservations ouvriront bientôt.");
    body = { ...body, volume: volumeRate(user) }; // jamais la valeur envoyée par le navigateur
    const q = pricing.quote(body, now());
    if (!q.ok) throw new HttpError(400, q.errors.join(' '));
    if (!q.open) throw new HttpError(409, "Proprigo n'est pas encore ouvert à ce code postal. Inscrivez-vous sur la liste d'attente.");
    const address = str(body.address, 200);
    if (address.length < 5) throw new HttpError(400, 'Indiquez l\'adresse complète.');
    const time = str(body.time, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Heure invalide.');
    if (body.date === pricing.todayParis(now()) && engine.toMin(time) < engine.toMin(nowParisHM()) + MIN_LEAD_MIN) throw new HttpError(400, 'Pour aujourd\'hui, choisissez une heure au moins 1 h à l\'avance.');
    if (!engine.requestSlots({ hours: q.hours, service: q.service }).includes(time)) throw new HttpError(400, 'Choisissez un créneau proposé.');
    const every = body.repeat === '7' || body.repeat === '14' ? Number(body.repeat) : 0;
    const count = every ? Math.min(12, Math.max(2, Number(body.occurrences) || 8)) : 1;
    if (every && q.urgent) throw new HttpError(400, "L'urgence ne s'applique pas à une réservation récurrente.");
    const home = body.home_id ? db.prepare('SELECT * FROM homes WHERE id = ? AND client_id = ?').get(Number(body.home_id), user.id) : null;
    if (body.home_id && !home) throw new HttpError(404, 'Logement introuvable.');
    const payMode = every && body.payment_mode === 'per_visit' ? 'per_visit' : 'all';
    if (stripeReady && !stripePay.validBaseUrl(appUrl)) throw new HttpError(503, 'Adresse publique du site non configurée.');
    // Double clic, deux onglets, retour arrière : la même demande ne crée jamais deux réservations.
    // Même client, même prestation, même adresse, même date et heure, dans les 30 dernières minutes.
    // (Le prix n'est pas comparé : il change quand le crédit du client est utilisé.)
    {
      const existing = db.prepare(`SELECT * FROM bookings
        WHERE client_id = ? AND service = ? AND hours = ? AND cp = ? AND address = ? AND date = ? AND time = ?
          AND COALESCE(home_id, 0) = ? AND (series_id IS NULL) = ? AND status <> 'annulee'
          AND created_at >= datetime('now', '-30 minutes')
        ORDER BY id DESC LIMIT 1`).get(user.id, q.service, q.hours, body.cp, address, body.date, time, home ? home.id : 0, every ? 0 : 1);
      if (existing) {
        const group = existing.series_id
          ? db.prepare("SELECT * FROM bookings WHERE series_id = ? AND status <> 'annulee' ORDER BY date, time").all(existing.series_id)
          : [existing];
        const unpaid = group.filter((b) => !b.paid && b.total > 0);
        if (!stripeReady || !unpaid.length || existing.paid) {
          throw new HttpError(409, `Cette réservation existe déjà (n° ${existing.id}${existing.paid ? ', payée' : ''}). Retrouvez-la dans « Mes réservations ».`);
        }
        const exPayMode = existing.series_id && db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE series_id = ? AND paid = 1').get(existing.series_id).n ? 'per_visit' : payMode;
        const ids = (exPayMode === 'all' ? unpaid : [unpaid[0]]).map((b) => b.id);
        try {
          const session = await stripePay.checkout({ db, ids, clientId: user.id, email: user.email, appUrl });
          return { status: 200, data: { checkout_url: session.url, created: 0, reused: true } };
        } catch (e) {
          if (/already completed/.test(e.message)) throw new HttpError(409, 'Paiement déjà reçu : la confirmation arrive dans quelques secondes.');
          db_.log(db, `PAIEMENT IMPOSSIBLE (reprise) pour la réservation n° ${ids.join(', ')} (${user.email}) : ${String(e.message).slice(0, 300)}`);
          throw new HttpError(502, 'Impossible de reprendre le paiement. Réessayez dans un instant.');
        }
      }
    }
    const list = checklist.clean(body.checklist, q.service);
    for (const k of q.extras || []) if (!list.some((t) => t.task === pricing.EXTRAS[k].task)) list.push({ task: pricing.EXTRAS[k].task, done: false });
    const tasks = JSON.stringify(list.slice(0, 24));
    const consent = body.photoConsent ? 1 : 0;
    let seriesId = null;
    if (every) seriesId = Number(db.prepare('INSERT INTO series (client_id, every_days) VALUES (?, ?)').run(user.id, every).lastInsertRowid);
    const ids = [];
    for (let k = 0; k < count; k++) {
      const date = addDays(body.date, k * every);
      const qk0 = k === 0 ? q : pricing.quote({ ...body, date, urgent: false }, now());
      // crédit (parrainage, carte cadeau, pack d'heures) : déduit ménage après ménage, jusqu'à épuisement
      const discount = Math.min(creditOf(user.id), qk0.total);
      const qk = { ...qk0, total: Math.round((qk0.total - discount) * 100) / 100 };
      const r = db.prepare(`INSERT INTO bookings (client_id, service, size, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, series_id, checklist, photo_consent, home_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '${laterPay(user) || (stripeReady ? 'en_attente_paiement' : 'simule')}', ?, ?, ?, ?)`).run(
        user.id, q.service, q.size, q.hours, body.cp, address, date, time, k === 0 && body.urgent ? 1 : 0, body.kit ? 1 : 0, qk.total, q.zone, seriesId, tasks, consent, home ? home.id : null);
      const id = Number(r.lastInsertRowid);
      if (pastWorker(user.id, body.want_worker_id)) db.prepare('UPDATE bookings SET want_worker_id = ? WHERE id = ?').run(Number(body.want_worker_id), id);
      if (discount) db.prepare('UPDATE bookings SET discount = ? WHERE id = ?').run(discount, id);
      if (q.extras && q.extras.length) db.prepare('UPDATE bookings SET extras = ? WHERE id = ?').run(JSON.stringify(q.extras), id);
      // entièrement réglé par le crédit : rien à payer
      if (stripeReady && qk.total === 0) db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye' WHERE id = ?").run(id);
      ids.push(id);
      db_.log(db, `Réservation n° ${id} créée, paiement ${stripeReady ? 'en attente' : 'simulé'} : ${qk.total} €, ${body.cp}, ${date} ${time}.`);
      if ((!stripeReady && !production) || laterPay(user)) engine.assign(db, id); // démonstration, ou entreprise payée en fin de mois
    }
    if (laterPay(user)) {
      const f = bookingView(db.prepare('SELECT * FROM bookings WHERE id = ?').get(ids[0]));
      notifyTeamNewBooking(ids, { paidBy: laterPay(user) === 'prelevement' ? 'prélèvement SEPA en fin de mois (entreprise)' : 'virement en fin de mois (entreprise)' });
      mailer.send(user.email, `Réservation confirmée : ${fr(f.date)} à ${f.time}`, 'Votre ménage est réservé', [`${fr(f.date)} à ${f.time}, ${f.address} (${f.cp}).`,
        `Prix : ${f.total} €${ids.length > 1 ? `, puis ${ids.length - 1} autre(s) passage(s)` : ''}. ${laterPay(user) === 'prelevement' ? 'Paiement par prélèvement SEPA : relevé et prélèvement en fin de mois.' : 'Paiement par virement : vous recevez une facture récapitulative en fin de mois.'}`], { label: 'Suivre ma réservation', path: '/#/mes-reservations' });
      return { status: 201, data: { ...f, created: ids.length, paidByTransfer: true } };
    }
    if (stripeReady) {
      // Chaque intervention est enregistrée sans affectation jusqu'à confirmation Stripe.
      // En mode per_visit, seule la première intervention est encaissée maintenant.
      const chargeIds = (payMode === 'all' ? ids : [ids[0]]).filter((id) => db.prepare('SELECT total FROM bookings WHERE id = ?').get(id).total > 0);
      if (!chargeIds.length) {
        db_.log(db, `Réservation n° ${ids[0]} réglée entièrement avec le crédit du client : attribution manuelle nécessaire.`);
        const f = bookingView(db.prepare('SELECT * FROM bookings WHERE id = ?').get(ids[0]));
        for (const pid of ids) issueInvoice(pid);
        notifyTeamNewBooking(ids, { paidBy: 'réglé avec le crédit Proprigo' });
        mailer.send(user.email, `Réservation confirmée : ${fr(f.date)} à ${f.time}`, 'Votre ménage est réservé', [`${fr(f.date)} à ${f.time}, ${f.address} (${f.cp}).`, 'Réglé avec votre crédit Proprigo : rien à payer.'], { label: 'Suivre ma réservation', path: '/#/' }, { key: `paid-confirm-${ids[0]}` });
        return { status: 201, data: { ...f, created: ids.length, paidByCredit: true } };
      }
      try {
        const session = await stripePay.checkout({ db, ids: chargeIds, clientId: user.id, email: user.email, appUrl });
        return { status: 201, data: { checkout_url: session.url, created: ids.length, payment_mode: payMode } };
      } catch (e) {
        db.prepare(`UPDATE bookings SET status = 'annulee', payment_status = 'paiement_echoue' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        db_.log(db, `PAIEMENT IMPOSSIBLE pour la réservation n° ${ids.join(', ')} (${user.email}) : ${String(e.message).slice(0, 300)}`);
        throw new HttpError(502, 'Impossible de démarrer le paiement Stripe. Réessayez dans un instant.');
      }
    }
    const first = bookingView(db.prepare('SELECT * FROM bookings WHERE id = ?').get(ids[0]));
    notifyTeamNewBooking(ids, { paidBy: 'paiement simulé (démonstration)' });
    mailer.send(user.email, `Réservation confirmée : ${fr(first.date)} à ${first.time}`, 'Votre ménage est réservé',
      [`${fr(first.date)} à ${first.time}, ${first.address} (${first.cp}).`, `Prix : ${first.total} € TTC${ids.length > 1 ? `, puis ${ids.length - 1} autre(s) ménage(s) récurrent(s)` : ''}.`,
        first.worker_name ? (genderOf(first.worker_id) === 'h' ? `Votre intervenant : ${first.worker_name.split(' ')[0]}, intervenant vérifié.` : `Votre intervenante : ${first.worker_name.split(' ')[0]}, intervenante vérifiée.`) : 'Nous vous indiquerons très vite qui vient.',
        `Annulation gratuite jusqu'à ${FREE_CANCEL_HOURS} h avant le ménage.`],
      { label: 'Suivre ma réservation', path: '/#/' });
    return { status: 201, data: { ...first, created: ids.length } };
  });

  route('GET', '/api/bookings/:id/preferred-slots', ({ user, id }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    const pid = engine.preferredIds(db, b)[0];
    if (!pid) return { name: null, options: [] };
    // prochains créneaux (à partir de J+1, 14 jours) où l'intervenante préférée est libre
    const options = [];
    for (let k = 1; k <= 14 && options.length < 8; k++) {
      const date = addDays(pricing.todayParis(now()), k);
      const times = engine.slotsFor(db, pid, { id: b.id, date, cp: b.cp, hours: b.hours });
      const pick = times.includes(b.time) ? [b.time] : times.slice(0, 2);
      for (const t of pick) {
        const q = pricing.quote({ service: b.service, size: b.size, hours: b.service === 'airbnb' ? undefined : b.hours, cp: b.cp, date, kit: !!b.kit }, now());
        if (q.ok && hoursBefore({ date, time: t }) >= 24) options.push({ date, time: t, total: q.total });
      }
    }
    return { name: engine.firstName(db, pid), options: options.slice(0, 8) };
  });

  route('POST', '/api/bookings/:id/update', ({ user, id, body }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    if (!['en_attente', 'proposee', 'attribuee'].includes(b.status)) throw new HttpError(409, 'Cette réservation ne peut plus être modifiée.');
    if (hoursBefore(b) < 24) throw new HttpError(409, 'Modification possible jusqu\'à 24 h avant le ménage. Écrivez-nous dans la messagerie de la réservation.');
    const next = {
      service: b.service, size: b.size, kit: !!b.kit, urgent: false, cp: b.cp,
      date: body.date || b.date, time: str(body.time, 5) || b.time,
      hours: b.service === 'airbnb' ? undefined : (body.hours !== undefined ? Number(body.hours) : b.hours),
    };
    const address = body.address !== undefined ? str(body.address, 200) : b.address;
    if (address.length < 5) throw new HttpError(400, 'Indiquez l\'adresse complète.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time)) throw new HttpError(400, 'Heure invalide.');
    const q = pricing.quote(next, now());
    if (!q.ok) throw new HttpError(400, q.errors.join(' '));
    if (hoursBefore({ date: next.date, time: next.time }) < 24) throw new HttpError(409, 'Le nouveau créneau doit être au moins 24 h à l\'avance.');
    const probe = { id: b.id, date: next.date, cp: b.cp, time: next.time, hours: q.hours };
    const list = engine.candidates(db, probe);
    if (!engine.requestSlots({ hours: q.hours, service: q.service }).includes(next.time)) throw new HttpError(400, 'Choisissez un créneau proposé.');
    // on garde l'intervenante actuelle, sauf si la préférée du client est libre sur le nouveau créneau
    const pid = engine.preferredIds(db, b)[0];
    const preferredFree = pid && pid !== b.worker_id && list.some((w) => w.user_id === pid);
    const keep = b.worker_id && list.some((w) => w.user_id === b.worker_id) && !preferredFree;
    db.prepare('UPDATE bookings SET date = ?, time = ?, hours = ?, address = ?, total = ? WHERE id = ?').run(next.date, next.time, q.hours, address, q.total, b.id);
    const diff = q.total - b.total;
    db_.log(db, `Réservation n° ${b.id} modifiée par le client : ${next.date} ${next.time}, ${q.total} €${diff ? ` (${diff > 0 ? '+' : ''}${diff} € ${diff > 0 ? 'à encaisser' : 'à rembourser'})` : ''}.`);
    if (!keep) { db.prepare("UPDATE bookings SET worker_id = NULL, status = 'en_attente' WHERE id = ?").run(b.id); db.prepare("DELETE FROM offers WHERE booking_id = ?").run(b.id); }
    const v = bookingView(db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id));
    mailer.send(user.email, 'Réservation modifiée', 'Votre réservation est modifiée', [`Nouveau créneau : ${fr(v.date)} à ${v.time}, ${v.address}.`, `Prix : ${v.total} € TTC${diff ? ` (${diff > 0 ? '+' : ''}${diff} €)` : ''}.`, v.worker_name ? `Intervenante : ${v.worker_name.split(' ')[0]}.` : ''].filter(Boolean), { label: 'Voir ma réservation', path: '/#/' });
    if (keep && b.worker_id) mailer.send(emailOf(b.worker_id), 'Mission déplacée', 'Une de vos missions a changé', [`Nouveau créneau : ${fr(v.date)} à ${v.time}.`], { label: 'Voir mes missions', path: '/#/intervenante' });
    return { ...v, diff, message: diff ? `Réservation modifiée. Nouveau prix : ${q.total} € (${diff > 0 ? '+' : ''}${diff} €).` : 'Réservation modifiée.' };
  });

  route('POST', '/api/series/:id/stop', ({ user, id }) => {
    need(user, 'client');
    const sr = db.prepare('SELECT * FROM series WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!sr) throw new HttpError(404, 'Récurrence introuvable.');
    db.prepare('UPDATE series SET active = 0 WHERE id = ?').run(id);
    const toStop = db.prepare(`SELECT * FROM bookings WHERE series_id = ? AND status IN ('en_attente','proposee','attribuee') AND date >= ?`).all(id, pricing.todayParis(now()));
    for (const x of toStop) db.prepare("UPDATE bookings SET status = 'annulee', payment_status = 'a_rembourser', refund_amount = ? WHERE id = ?").run(refundFor(x), x.id);
    const r = { changes: toStop.length };
    db.prepare("DELETE FROM offers WHERE state = 'offered' AND booking_id IN (SELECT id FROM bookings WHERE series_id = ? AND status = 'annulee')").run(id);
    db_.log(db, `Récurrence n° ${id} arrêtée par le client : ${r.changes} réservation(s) à venir annulée(s).`);
    return { ok: true, message: `Récurrence arrêtée : ${r.changes} ménage(s) à venir annulé(s).` };
  });

  route('GET', '/api/bookings/mine', ({ user }) => {
    need(user, 'client');
    return db.prepare("SELECT * FROM bookings WHERE client_id = ? AND NOT (status = 'annulee' AND payment_status = 'paiement_echoue' AND paid = 0) ORDER BY date DESC, time DESC").all(user.id).map((b) => {
      const v = { ...bookingView(b) };
      v.worker_name = v.worker_display; // le client ne reçoit pas le nom de famille
      const pid = engine.preferredIds(db, b)[0];
      return pid ? { ...v, preferred_id: pid, preferred_name: engine.firstName(db, pid), preferred_gender: genderOf(pid) } : v;
    });
  });

  route('POST', '/api/bookings/:id/cancel', ({ user, id }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    if (!['en_attente', 'proposee', 'attribuee'].includes(b.status)) throw new HttpError(409, 'Cette réservation ne peut plus être annulée.');
    if (b.arrived_at) throw new HttpError(409, "L'intervenante est déjà chez vous : le ménage ne peut plus être annulé. Écrivez-nous dans les messages en cas de souci.");
    const refund = refundFor(b);
    db.prepare("UPDATE bookings SET status = 'annulee', refund_amount = ?, payment_status = CASE WHEN payment_status = 'paye' OR payment_status = 'simule' THEN 'a_rembourser' ELSE payment_status END WHERE id = ?").run(refund, id);
    db.prepare('DELETE FROM offers WHERE booking_id = ?').run(id);
    db_.log(db, `Réservation n° ${id} annulée par le client : ${refund} € à rembourser${refund < b.total ? ' (annulation à moins de 24 h)' : ''}.`);
    const late = refund < b.total;
    mailer.send(user.email, 'Réservation annulée', 'Votre réservation est annulée', [`Ménage du ${fr(b.date)} à ${b.time}.`, late ? `Annulation à moins de ${FREE_CANCEL_HOURS} h : ${refund} € vous seront remboursés sur ${b.total} €.` : `Vous serez remboursé de ${refund} €.`]);
    if (b.worker_id) mailer.send(emailOf(b.worker_id), 'Mission annulée', 'Une mission est annulée', [`Le ménage du ${fr(b.date)} à ${b.time} (${b.cp}) est annulé par le client.`]);
    return { ok: true, refund, message: late ? `Réservation annulée. ${refund} € vous seront remboursés (annulation à moins de ${FREE_CANCEL_HOURS} h).` : `Réservation annulée. ${refund} € vous seront remboursés.` };
  });

  // ----- avis clients réels, publiés avec leur accord -----
  // Moyenne et nombre calculés sur TOUTES les notes (pas seulement celles publiées) : rien n'est trié pour embellir.
  const placeOf = (cp) => (/^75\d{3}$/.test(cp) ? `Paris ${Number(cp.slice(3))}${Number(cp.slice(3)) === 1 ? 'er' : 'e'}` : cp ? `(${cp.slice(0, 2)})` : '');
  route('GET', '/api/reviews', () => {
    const all = db.prepare("SELECT COUNT(*) AS n, AVG(rating) AS avg FROM bookings WHERE rating IS NOT NULL").get();
    const list = db.prepare(`SELECT b.id, b.rating, b.review, b.service, b.cp, b.date, u.name FROM bookings b JOIN users u ON u.id = b.client_id
      WHERE b.review_public = 1 AND b.review_hidden = 0 AND b.review IS NOT NULL ORDER BY b.date DESC, b.id DESC LIMIT 9`).all()
      .map((r) => { const [first, ...rest] = r.name.trim().split(/\s+/); return { stars: r.rating, text: r.review, service: SERVICE_NAME[r.service] || 'Ménage', place: placeOf(r.cp),
        month: r.date.slice(0, 7), author: `${first}${rest.length ? ` ${rest[rest.length - 1][0].toUpperCase()}.` : ''}` }; });
    return { count: all.n, average: all.n ? Math.round(all.avg * 10) / 10 : null, list };
  });
  route('GET', '/api/admin/reviews', ({ user }) => {
    need(user, 'admin');
    return db.prepare(`SELECT b.id, b.rating, b.review, b.review_public, b.review_hidden, b.date, u.name FROM bookings b JOIN users u ON u.id = b.client_id
      WHERE b.review IS NOT NULL ORDER BY b.date DESC LIMIT 40`).all();
  });
  route('POST', '/api/admin/reviews/:id', ({ user, id, body }) => {
    need(user, 'admin');
    const hidden = body.hidden ? 1 : 0;
    const r = db.prepare('UPDATE bookings SET review_hidden = ? WHERE id = ? AND review IS NOT NULL').run(hidden, id);
    if (!r.changes) throw new HttpError(404, 'Avis introuvable.');
    db_.log(db, `Avis de la réservation n° ${id} ${hidden ? 'masqué' : 'de nouveau affiché'} par ${user.name}.`);
    return { ok: true, message: hidden ? 'Avis masqué du site.' : 'Avis de nouveau affiché.' };
  });

  // ----- garantie « satisfait ou on revient » -----
  // Dans les 48 h après la fin du ménage, le client signale ce qui ne va pas ; l'équipe planifie un retour gratuit.
  const GUARANTEE_HOURS = 48;
  const guaranteeOpen = (b) => {
    if (b.status !== 'terminee' || b.guarantee_at || b.payment_status === 'garantie') return false;
    const end = b.finished_at ? Date.parse(b.finished_at.replace(' ', 'T') + 'Z') : Date.parse(`${b.date}T23:59:00+01:00`);
    return now().getTime() - end <= GUARANTEE_HOURS * 3600e3;
  };
  route('POST', '/api/bookings/:id/guarantee', ({ user, id, body }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    if (b.guarantee_at) throw new HttpError(409, 'Votre demande est déjà enregistrée : l\'équipe vous recontacte.');
    if (!guaranteeOpen(b)) throw new HttpError(409, `La garantie se demande dans les ${GUARANTEE_HOURS} h qui suivent le ménage.`);
    const text = str(body.text, 800);
    if (text.length < 10) throw new HttpError(400, 'Dites-nous en quelques mots ce qui n\'allait pas (pièces, tâches oubliées…).');
    db.prepare("UPDATE bookings SET guarantee_at = datetime('now'), guarantee_text = ?, guarantee_status = 'demandee' WHERE id = ?").run(text, id);
    db.prepare("INSERT INTO incidents (booking_id, text, source) VALUES (?, ?, 'garantie')").run(id, `Garantie demandée : ${text}`);
    db_.log(db, `GARANTIE · Réservation n° ${id} : ${user.name} n'est pas satisfait(e). Retour gratuit à planifier.`);
    for (const to of ownerEmails()) mailer.send(to, `Garantie : retour gratuit à planifier (n° ${id})`, 'Un client n\'est pas satisfait', [
      `${user.name} · ${SERVICE_NAME[b.service] || 'Ménage'} du ${fr(b.date)}, ${b.cp}.`, `« ${text} »`, 'Appelez le client et planifiez le retour gratuit depuis l\'admin (À traiter).',
    ], { label: 'Planifier le retour', path: '/#/admin' });
    mailer.send(user.email, 'Nous revenons gratuitement', 'Nous revenons gratuitement', [
      `Bonjour ${user.name.split(' ')[0]},`, 'Merci de nous l\'avoir signalé. Nous revenons reprendre les points concernés, sans frais.',
      'L\'équipe vous contacte dans la journée pour fixer le créneau.',
    ], { label: 'Ma réservation', path: '/#/mes-reservations' }, { key: `guarantee-ack-${id}` });
    return { ok: true, message: 'C\'est noté. Nous revenons gratuitement : l\'équipe vous contacte dans la journée pour fixer le créneau.' };
  });
  route('POST', '/api/admin/bookings/:id/guarantee-visit', ({ user, id, body }) => {
    needStaff(user);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !b.guarantee_at) throw new HttpError(404, 'Aucune demande de garantie pour cette réservation.');
    if (b.guarantee_visit_id) throw new HttpError(409, `Retour déjà planifié (réservation n° ${b.guarantee_visit_id}).`);
    const date = str(body.date, 10); const time = str(body.time, 5);
    if (!pricing.isValidDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Date ou heure invalide.');
    if (date < pricing.todayParis(now())) throw new HttpError(400, 'Choisissez une date à venir.');
    const hours = Math.max(1, Math.min(b.hours, Number(body.hours) || Math.ceil(b.hours / 2)));
    const vid = Number(db.prepare(`INSERT INTO bookings (client_id, service, size, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, photo_consent, home_id, guarantee_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 1, 'garantie', 'en_attente', ?, ?, ?, ?)`).run(b.client_id, b.service, b.size, hours, b.cp, b.address, date, time, b.zone, b.checklist, b.photo_consent, b.home_id, b.id).lastInsertRowid);
    db.prepare("UPDATE bookings SET guarantee_status = 'planifiee', guarantee_visit_id = ? WHERE id = ?").run(vid, id);
    db.prepare("UPDATE incidents SET resolved = 1 WHERE booking_id = ? AND source = 'garantie'").run(id);
    db_.log(db, `Garantie : retour gratuit n° ${vid} planifié le ${date} à ${time} pour la réservation n° ${id} (${user.name}). Attribution nécessaire.`);
    const c = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.client_id);
    mailer.send(c.email, `Retour gratuit prévu le ${fr(date)} à ${time}`, 'Votre retour gratuit est planifié', [
      `Bonjour ${c.name.split(' ')[0]},`, `Nous revenons le ${fr(date)} à ${time} reprendre les points signalés. C'est gratuit.`, 'Vous recevrez le nom de l\'intervenante dès qu\'elle est attribuée.',
    ], { label: 'Voir la réservation', path: '/#/mes-reservations' }, { key: `guarantee-visit-${id}` });
    return { ok: true, id: vid, message: `Retour gratuit planifié (n° ${vid}). Attribuez-le comme une réservation normale.` };
  });

  route('POST', '/api/bookings/:id/rate', ({ user, id, body }) => {
    need(user, 'client');
    const stars = Number(body.stars);
    if (![1, 2, 3, 4, 5].includes(stars)) throw new HttpError(400, 'Note de 1 à 5.');
    const review = str(body.review, 500) || null;
    // Publication sur le site seulement avec l'accord explicite du client (prénom + initiale).
    const publish = body.publish === true && Boolean(review) ? 1 : 0;
    const r = db.prepare("UPDATE bookings SET rating = ?, review = ?, review_public = ? WHERE id = ? AND client_id = ? AND status = 'terminee' AND rating IS NULL").run(stars, review, publish, id, user.id);
    if (!r.changes) throw new HttpError(409, 'Cette réservation ne peut pas être notée.');
    db_.log(db, `Réservation n° ${id} : note ${stars}/5${review ? ' avec commentaire' : ''}.${stars < 4 ? ' Alerte qualité : rappeler le client.' : ''}`);
    if (stars < 4) db.prepare("INSERT INTO incidents (booking_id, text, source) VALUES (?, ?, 'note')").run(id, `Note ${stars}/5${review ? ` : ${review}` : ''}`);
    return { ok: true, message: 'Merci pour votre avis.' };
  });

  // ----- intervenante -----
  route('GET', '/api/worker/missions', ({ user }) => {
    need(user, 'intervenante');
    const w = workerProfile(user.id);
    const offers = db.prepare(`SELECT b.* FROM offers o JOIN bookings b ON b.id = o.booking_id
      WHERE o.worker_id = ? AND o.state = 'offered' AND b.status = 'proposee' ORDER BY b.date, b.time`).all(user.id);
    const missions = db.prepare(`SELECT b.*, u.name AS client_name FROM bookings b JOIN users u ON u.id = b.client_id
      WHERE b.worker_id = ? AND b.status IN ('attribuee','en_cours') ORDER BY b.date, b.time`).all(user.id);
    const done = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h FROM bookings WHERE worker_id = ? AND status = 'terminee'").get(user.id);
    // L'intervenante ne voit l'adresse exacte qu'une fois la mission acceptée.
    const safeOffers = offers.map(({ address, ...rest }) => ({ ...rest, earn: w.statut === 'I' ? Math.round(w.rate * rest.hours * 100) / 100 : null }));
    const cal = db.prepare('SELECT weekday, start, end FROM availability WHERE worker_id = ? ORDER BY weekday').all(user.id);
    const off = db.prepare('SELECT * FROM timeoff WHERE worker_id = ? AND end_date >= ? ORDER BY start_date').all(user.id, pricing.todayParis(now()));
    return { profile: { ...w, reject_reason: undefined }, steps: db_.STEPS[w.statut], active: engine.isActive(w), offers: safeOffers, missions: missions.map((m) => { const h = m.home_id ? db.prepare('SELECT name, instructions FROM homes WHERE id = ?').get(m.home_id) : null; const shared = ['attribuee', 'en_cours'].includes(m.status) ? db.prepare("SELECT text, created_at FROM admin_notes WHERE kind = 'client' AND target_id = ? AND share = 1 ORDER BY id DESC LIMIT 5").all(m.client_id) : []; return { ...bookingView(m), client_name: m.client_name, home_name: h ? h.name : null, instructions: h ? h.instructions : null, team_notes: shared }; }), done, availability: cal, timeoff: off };
  });

  const workerAction = (action) => ({ user, id }) => {
    need(user, 'intervenante');
    const w = workerProfile(user.id);
    if (!engine.isActive(w)) throw new HttpError(403, 'Votre compte n\'est pas encore activé.');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, 'Mission introuvable.');
    if (production && !b.paid) throw new HttpError(409, 'Paiement requis avant toute intervention.');
    if (action === 'accept') {
      const ok = engine.accept(db, id, user.id);
      if (ok === 'occupee') throw new HttpError(409, 'Vous avez déjà une mission à cette heure-là (trajet compris). Refusez cette proposition pour qu\'une autre intervenante la reçoive.');
      if (!ok) throw new HttpError(409, 'Cette mission n\'est plus disponible.');
      db_.log(db, `Réservation n° ${id} : acceptée par ${user.name}.`);
    } else if (action === 'refuse') {
      if (!engine.refuse(db, id, user.id)) throw new HttpError(409, 'Cette proposition n\'existe plus.');
      db_.log(db, `Réservation n° ${id} : refusée par ${user.name}, sans pénalité.`);
    } else {
      if (b.worker_id !== user.id) throw new HttpError(403, 'Mission attribuée à une autre intervenante.');
      const next = { start: ['attribuee', 'en_cours'], finish: ['en_cours', 'terminee'] }[action];
      if (b.status !== next[0]) throw new HttpError(409, 'Action impossible à ce stade.');
      if (action === 'finish' && b.photo_consent && !db.prepare("SELECT 1 FROM photos WHERE booking_id = ? AND kind = 'apres'").get(id)) {
        throw new HttpError(409, 'Ajoutez au moins une photo « après » avant de terminer : le client l\'a demandé.');
      }
      db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(next[1], id);
      db_.log(db, `Réservation n° ${id} : ${action === 'start' ? 'ménage commencé' : 'ménage terminé'} par ${user.name}.`);
      const cl = db.prepare('SELECT email FROM users WHERE id = ?').get(b.client_id);
      if (action === 'start') mailer.send(cl.email, 'Votre ménage a commencé', `${user.name.split(' ')[0]} a commencé votre ménage`, [`Ménage du ${fr(b.date)}, ${b.address}.`], { label: 'Suivre le ménage', path: '/#/' });
      if (action === 'finish') db.prepare("UPDATE bookings SET finished_at = COALESCE(finished_at, datetime('now')) WHERE id = ?").run(id);
      if (action === 'finish') rewardSponsor(b.client_id);
      if (action === 'finish') mailer.send(cl.email, 'Votre ménage est terminé', 'Votre ménage est terminé', [`${user.name.split(' ')[0]} a terminé le ménage du ${fr(b.date)}.`, 'Donnez votre avis en un clic : il nous aide à garantir la qualité. Un problème ? Signalez-le depuis la réservation.'], { label: 'Donner mon avis', path: '/#/mes-reservations' });
    }
    return { ok: true };
  };
  // parrain récompensé une seule fois, quand le premier ménage de son filleul est terminé
  function rewardSponsor(clientId) {
    const u = db.prepare('SELECT referred_by, name FROM users WHERE id = ?').get(clientId);
    if (!u || !u.referred_by) return;
    if (db.prepare("SELECT 1 FROM credits WHERE user_id = ? AND ref_user = ? AND reason = 'Parrainage : filleul servi'").get(u.referred_by, clientId)) return;
    db.prepare("INSERT INTO credits (user_id, amount, reason, ref_user) VALUES (?, ?, 'Parrainage : filleul servi', ?)").run(u.referred_by, REFERRAL_EUR, clientId);
    const sp = db.prepare('SELECT email, name FROM users WHERE id = ?').get(u.referred_by);
    if (sp) mailer.send(sp.email, `${REFERRAL_EUR} € offerts sur votre prochain ménage`, 'Merci pour votre parrainage', [`${u.name.split(' ')[0]} a fait son premier ménage avec Proprigo.`, `${REFERRAL_EUR} € sont déduits automatiquement de votre prochaine réservation.`], { label: 'Réserver', path: '/#/reserver' });
    db_.log(db, `Parrainage : ${REFERRAL_EUR} € offerts au parrain du client n° ${clientId}.`);
  }
  for (const a of ['accept', 'refuse', 'start', 'finish']) route('POST', `/api/worker/missions/:id/${a}`, workerAction(a));

  // ----- cartes cadeaux et packs d'heures prépayés -----
  const GIFT_AMOUNTS = [50, 100, 150, 200];
  const PACKS = { 10: { pay: 10, get: 11 }, 20: { pay: 20, get: 23 } }; // heures payées → heures créditées
  const PACK_RATE = () => pricing.GRID.IDF.menage;
  const giftCode = () => {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      const c = 'PG-' + Array.from({ length: 8 }, (_, i) => (i === 4 ? '-' : '') + A[crypto.randomInt(A.length)]).join('');
      if (!db.prepare('SELECT 1 FROM gift_cards WHERE code = ?').get(c)) return c;
    }
  };
  // ----- pourboires : payés par le client, reversés à 100 % à l'intervenante -----
  db.exec(`CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    client_id INTEGER NOT NULL REFERENCES users(id),
    worker_id INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 100 AND 5000),
    status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente','paye')),
    session_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT,
    payout_id INTEGER)`);
  const TIP_DAYS = 30; // on peut laisser un pourboire jusqu'à 30 jours après le ménage
  function fulfillTip(id) {
    const t = db.prepare("SELECT * FROM tips WHERE id = ? AND status = 'en_attente'").get(id);
    if (!t) return;
    db.prepare("UPDATE tips SET status = 'paye', paid_at = datetime('now') WHERE id = ?").run(id);
    const euros = (t.amount_cents / 100).toFixed(2).replace('.', ',').replace(',00', '');
    const client = db.prepare('SELECT name FROM users WHERE id = ?').get(t.client_id);
    const first = String(client && client.name || '').split(' ')[0] || 'Votre client';
    mailer.send(emailOf(t.worker_id), `Vous avez reçu un pourboire de ${euros} €`, 'Un client vous remercie 🎉', [`${first} vous a laissé un pourboire de ${euros} € pour le ménage n° ${t.booking_id}.`, 'Il vous est reversé en entier, avec votre prochain versement ou sur votre fiche de paie.'], null);
    push.notifyUser(db, t.worker_id, { title: `Pourboire de ${euros} € 🎉`, body: `${first} vous remercie pour le ménage.`, url: '/#/intervenante', tag: `tip-${id}` }, { subject: pushSubject }).catch(() => {});
    nativePush.notifyUser(db, t.worker_id, { title: `Pourboire de ${euros} € 🎉`, body: `${first} vous remercie pour le ménage.`, url: '/#/intervenante', tag: `tip-${id}` }).catch(() => {});
    db_.log(db, `Pourboire de ${euros} € pour la réservation n° ${t.booking_id}.`);
  }
  route('POST', '/api/bookings/:id/tip', async ({ user, id, body }) => {
    need(user, 'client');
    const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND client_id = ? AND status = 'terminee' AND worker_id IS NOT NULL").get(id, user.id);
    if (!b) throw new HttpError(404, 'Ménage introuvable.');
    if (b.date < addDays(pricing.todayParis(now()), -TIP_DAYS)) throw new HttpError(409, 'Ce ménage est trop ancien pour un pourboire.');
    if (db.prepare("SELECT 1 FROM tips WHERE booking_id = ? AND status = 'paye'").get(id)) throw new HttpError(409, 'Vous avez déjà laissé un pourboire pour ce ménage. Merci !');
    const euros = Math.round(Number(body.amount));
    if (!(euros >= 1 && euros <= 50)) throw new HttpError(400, 'Choisissez un montant entre 1 et 50 €.');
    db.prepare("DELETE FROM tips WHERE booking_id = ? AND status = 'en_attente'").run(id);
    const tid = Number(db.prepare('INSERT INTO tips (booking_id, client_id, worker_id, amount_cents) VALUES (?, ?, ?, ?)').run(id, user.id, b.worker_id, euros * 100).lastInsertRowid);
    if (!stripeReady) {
      if (production) throw new HttpError(503, 'Paiement indisponible.');
      fulfillTip(tid);
      return { ok: true, simulated: true, message: 'Merci ! Votre pourboire est envoyé (paiement simulé).' };
    }
    try {
      const w = db.prepare('SELECT name FROM users WHERE id = ?').get(b.worker_id);
      const r = await stripePay.checkoutTip({ db, tip: { id: tid, amount_cents: euros * 100 }, label: `Pourboire pour ${displayName(w.name)} (Proprigo)`, email: user.email, appUrl });
      return { ok: true, url: r.url };
    } catch (e) {
      console.error('PAIEMENT IMPOSSIBLE (pourboire)', e.message);
      throw new HttpError(502, 'Paiement momentanément impossible. Réessayez dans quelques minutes.');
    }
  });
  // carte payée : code créé et envoyé ; pack payé : crédit ajouté tout de suite à l'acheteur
  function fulfillGift(id) {
    const g = db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(id);
    if (!g || g.status !== 'pending') return;
    const buyer = db.prepare('SELECT email, name FROM users WHERE id = ?').get(g.buyer_id);
    if (g.kind === 'pack') {
      db.prepare("UPDATE gift_cards SET status = 'redeemed', redeemed_by = buyer_id, paid_at = datetime('now') WHERE id = ?").run(id);
      db.prepare('INSERT INTO credits (user_id, amount, reason) VALUES (?, ?, ?)').run(g.buyer_id, g.amount, `Pack ${g.hours} h`);
      mailer.send(buyer.email, `Votre pack de ${g.hours} h est actif`, 'Pack activé', [`${g.amount.toFixed(2).replace('.', ',')} € de crédit sont disponibles sur votre compte.`, 'Ils sont déduits automatiquement de vos prochaines réservations.'], { label: 'Réserver', path: '/#/reserver' });
      db_.log(db, `Pack ${g.hours} h payé par le client n° ${g.buyer_id} : ${g.amount} € de crédit.`);
      return;
    }
    const code = giftCode();
    db.prepare("UPDATE gift_cards SET status = 'paid', code = ?, paid_at = datetime('now') WHERE id = ?").run(code, id);
    const to = g.recipient_email || buyer.email;
    mailer.send(to, `${buyer.name.split(' ')[0]} vous offre un ménage Proprigo`, `Une carte cadeau de ${g.amount} €`,
      [g.recipient_name ? `Bonjour ${g.recipient_name},` : 'Bonjour,', `${buyer.name.split(' ')[0]} vous offre ${g.amount} € de ménage avec Proprigo.`, ...(g.message ? [`« ${g.message} »`] : []), `Votre code : ${code}`, 'Créez votre compte, puis saisissez ce code dans « Mon compte ». Valable 1 an.'],
      { label: 'Utiliser ma carte cadeau', path: `/#/inscription?cadeau=${code}` });
    if (g.recipient_email) mailer.send(buyer.email, 'Votre carte cadeau est envoyée', 'Merci pour votre cadeau', [`La carte de ${g.amount} € a été envoyée à ${g.recipient_email}.`, `Code, au cas où : ${code}`], null);
    db_.log(db, `Carte cadeau de ${g.amount} € payée par le client n° ${g.buyer_id}.`);
  }
  route('GET', '/api/gifts/offer', () => ({ amounts: GIFT_AMOUNTS, packs: Object.entries(PACKS).map(([h, p]) => ({ hours: Number(h), price: p.pay * PACK_RATE(), credit: p.get * PACK_RATE(), free: p.get - p.pay })) }));
  route('POST', '/api/gifts', async ({ user, body }) => {
    need(user, 'client');
    let g;
    if (body.kind === 'pack') {
      const p = PACKS[Number(body.hours)];
      if (!p) throw new HttpError(400, 'Pack inconnu.');
      g = { kind: 'pack', hours: Number(body.hours), price: p.pay * PACK_RATE(), amount: p.get * PACK_RATE() };
    } else {
      const amount = Number(body.amount);
      if (!GIFT_AMOUNTS.includes(amount)) throw new HttpError(400, 'Montant de carte cadeau inconnu.');
      const email = str(body.recipient_email, 120).toLowerCase();
      if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'E-mail du destinataire invalide.');
      g = { kind: 'gift', hours: null, price: amount, amount, recipient_name: str(body.recipient_name, 60) || null, recipient_email: email || null, message: str(body.message, 300) || null };
    }
    const id = Number(db.prepare('INSERT INTO gift_cards (kind, amount, price, hours, buyer_id, recipient_name, recipient_email, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(g.kind, g.amount, g.price, g.hours, user.id, g.recipient_name || null, g.recipient_email || null, g.message || null).lastInsertRowid);
    if (!stripeReady) {
      if (production) throw new HttpError(503, 'Paiement indisponible.');
      fulfillGift(id); // démonstration : payé tout de suite
      return { ok: true, simulated: true, message: g.kind === 'pack' ? 'Pack activé (paiement simulé).' : 'Carte cadeau envoyée (paiement simulé).' };
    }
    try {
      const session = await stripePay.checkoutGift({ db, gift: { ...g, id }, email: user.email, appUrl });
      return { checkout_url: session.url };
    } catch (e) {
      db_.log(db, `PAIEMENT IMPOSSIBLE (carte cadeau ou pack) pour ${user.email} : ${String(e.message).slice(0, 300)}`);
      throw new HttpError(502, 'Paiement indisponible. Réessayez dans un instant.');
    }
  });
  route('POST', '/api/gifts/redeem', ({ user, body }) => {
    need(user, 'client');
    const code = str(body.code, 20).toUpperCase().replace(/\s+/g, '');
    const g = db.prepare('SELECT * FROM gift_cards WHERE code = ?').get(code);
    if (!g || g.kind !== 'gift') throw new HttpError(404, 'Code inconnu. Vérifiez les lettres et les chiffres.');
    if (g.status === 'redeemed') throw new HttpError(409, 'Cette carte cadeau a déjà été utilisée.');
    if (g.status !== 'paid') throw new HttpError(409, "Cette carte cadeau n'est pas encore payée.");
    if (Date.parse(g.paid_at.replace(' ', 'T') + 'Z') < now().getTime() - 365 * 864e5) throw new HttpError(409, 'Cette carte cadeau a expiré (valable 1 an).');
    const r = db.prepare("UPDATE gift_cards SET status = 'redeemed', redeemed_by = ? WHERE id = ? AND status = 'paid'").run(user.id, g.id);
    if (!r.changes) throw new HttpError(409, 'Cette carte cadeau a déjà été utilisée.');
    db.prepare("INSERT INTO credits (user_id, amount, reason) VALUES (?, ?, 'Carte cadeau')").run(user.id, g.amount);
    db_.log(db, `Carte cadeau de ${g.amount} € utilisée par le client n° ${user.id}.`);
    return { ok: true, credit: creditOf(user.id), message: `${g.amount} € ajoutés à votre crédit. Ils seront déduits de vos prochains ménages.` };
  });
  route('GET', '/api/gifts/mine', ({ user }) => {
    need(user, 'client');
    return { credit: creditOf(user.id), gifts: db.prepare("SELECT id, kind, amount, hours, recipient_name, recipient_email, status, code, created_at FROM gift_cards WHERE buyer_id = ? AND status <> 'pending' ORDER BY id DESC LIMIT 20").all(user.id).map((g) => ({ ...g, code: g.kind === 'gift' && g.status === 'paid' ? g.code : null })) };
  });

  // ----- parrainage : code personnel et crédit disponible -----
  route('GET', '/api/referral', ({ user }) => {
    need(user, 'client');
    let code = db.prepare('SELECT ref_code FROM users WHERE id = ?').get(user.id).ref_code;
    if (!code) {
      const base = (user.name.split(' ')[0] || 'AMI').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'AMI';
      for (let i = 0; i < 20 && !code; i++) {
        const c = base + crypto.randomInt(100, 999);
        if (!db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(c)) code = c;
      }
      db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(code, user.id);
    }
    const friends = db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?').get(user.id).n;
    return { code, credit: creditOf(user.id), amount: REFERRAL_EUR, friends, link: `${appUrl.replace(/\/$/, '')}/#/inscription?ref=${code}` };
  });

  // ----- réglages publics : lien d'avis Google -----
  const reviewUrl = /^https:\/\/[^\s"<>]+$/.test(googleReviewUrl || '') ? googleReviewUrl : '';
  // identité publique de l'entreprise, pour les mentions légales (jamais l'IBAN ni le BIC)
  const LEGAL_KEYS = ['nomCommercial', 'raisonSociale', 'formeJuridique', 'capital', 'adresse', 'siret', 'rcs', 'tvaIntracom', 'president', 'emailContact', 'telephone', 'hebergeur'];
  const legalInfo = () => Object.fromEntries(LEGAL_KEYS.map((k) => [k, String(company[k] || '').trim()]).filter(([, v]) => v));
  route('GET', '/api/config', () => ({ version: VERSION, franchiseTVA, legal: legalInfo(), sap: sapOn() ? { declared: true, numero: sapSettings().numero, services: SAP_SERVICES } : { declared: false }, googleReviewUrl: reviewUrl, prices: pricing.publicPrices(), openDepts: [...pricing.OPEN_DEPTS] }));

  // ----- tarifs et zones, modifiables par le responsable -----
  // Les réservations déjà créées gardent leur prix : seules les nouvelles suivent la nouvelle grille.
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by INTEGER);
    CREATE TABLE IF NOT EXISTS pricing_history (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), by_name TEXT, changes TEXT NOT NULL)`);
  {
    let saved = null;
    try { saved = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'pricing'").get()?.value || 'null'); } catch { saved = null; }
    if (saved && pricing.validateSettings(saved).length) { db_.log(db, 'Tarifs enregistrés invalides : grille par défaut utilisée.'); saved = null; }
    pricing.applySettings(saved || pricing.DEFAULTS);
  }
  // ----- services à la personne (crédit d'impôt) -----
  // Le crédit d'impôt n'est mentionné qu'une fois la déclaration SAP faite et son numéro saisi dans l'admin.
  const SAP_SERVICES = ['menage', 'grand'];
  const sapSettings = () => {
    try { return { declared: false, numero: '', ...JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'sap'").get()?.value || '{}') }; } catch { return { declared: false, numero: '' }; }
  };
  const sapOn = () => { const st = sapSettings(); return Boolean(st.declared && /^SAP\d{9}$/.test(st.numero)); };
  route('GET', '/api/admin/tiers', ({ user }) => {
    need(user, 'admin');
    const counts = { bleu: 0, or: 0, platine: 0 };
    for (const w of db.prepare('SELECT user_id FROM workers').all()) counts[tiers.tierOf(db, w.user_id).key] += 1;
    return { ...tiers.settings(db), minRatings: tiers.MIN_RATINGS, priorityKm: tiers.PRIORITY_KM, counts };
  });
  route('POST', '/api/admin/tiers', ({ user, body }) => {
    need(user, 'admin');
    if (!isOwner(user)) throw new HttpError(403, 'Réservé au responsable.');
    let v;
    try { v = tiers.clean(body); } catch (e) { throw new HttpError(400, e.message); }
    db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('tiers', ?, datetime('now'), ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by").run(JSON.stringify(v), user.id);
    db_.log(db, `Niveaux des intervenantes modifiés par ${user.name}.`);
    return { ok: true, message: 'Niveaux enregistrés.', ...v };
  });
  route('GET', '/api/admin/sap', ({ user }) => {
    need(user, 'admin');
    return { ...sapSettings(), active: sapOn(), interested: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'client' AND wants_avance = 1").get().n };
  });
  route('POST', '/api/admin/sap', ({ user, body }) => {
    need(user, 'admin');
    const numero = str(body.numero, 20).toUpperCase().replace(/\s+/g, '');
    const declared = Boolean(body.declared);
    if (declared && !/^SAP\d{9}$/.test(numero)) throw new HttpError(400, 'Numéro de déclaration au format SAP suivi de 9 chiffres (il figure sur le récépissé de déclaration).');
    db.prepare("INSERT INTO settings (key, value, updated_by) VALUES ('sap', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by").run(JSON.stringify({ declared, numero }), user.id);
    db_.log(db, `Services à la personne : ${declared ? `déclaration ${numero} enregistrée, crédit d'impôt affiché` : 'crédit d\'impôt masqué'} (${user.name}).`);
    return { ok: true, message: declared ? 'Crédit d\'impôt affiché sur le site, les factures et les attestations.' : 'Crédit d\'impôt masqué.' };
  });
  // Avance immédiate : liste des clients intéressés, en attendant le raccordement à l'URSSAF.
  route('POST', '/api/me/lang', ({ user, body }) => {
    need(user);
    const lang = ['fr', 'en', 'pt', 'es', 'ar'].includes(body.lang) ? body.lang : null;
    if (!lang) throw new HttpError(400, 'Langue inconnue.');
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, user.id);
    return { ok: true, lang };
  });
  route('POST', '/api/me/avance', ({ user, body }) => {
    need(user, 'client');
    db.prepare('UPDATE users SET wants_avance = ? WHERE id = ?').run(body.wants ? 1 : 0, user.id);
    return { ok: true, message: body.wants ? 'C\'est noté : nous vous prévenons dès que l\'avance immédiate est disponible.' : 'C\'est noté.' };
  });
  // Pièces demandées aux candidates : liste publique (page de recrutement).
  route('GET', '/api/recruitment', () => ({ docs: { S: kindsFor('S'), I: kindsFor('I') }, rate: { min: 15, max: 40 } }));

  const describeChanges = (a, b) => {
    const out = [];
    const pct = (x) => `${Math.round(x * 1000) / 10} %`;
    const zoneName = { IDF: 'Île-de-France', FR: 'hors IDF' };
    for (const z of ['IDF', 'FR']) {
      for (const k of ['menage', 'grand', 'bureau']) if (a.grid[z][k] !== b.grid[z][k]) out.push(`${SERVICE_NAME[k]} ${zoneName[z]} : ${a.grid[z][k]} → ${b.grid[z][k]} €`);
      for (const k of Object.keys(b.grid[z].airbnb)) if (a.grid[z].airbnb[k] !== b.grid[z].airbnb[k]) out.push(`Airbnb ${pricing.SIZE_LABEL[k]} ${zoneName[z]} : ${a.grid[z].airbnb[k]} → ${b.grid[z].airbnb[k]} €`);
    }
    if (a.sunday !== b.sunday) out.push(`Dimanche et férié : ${pct(a.sunday)} → ${pct(b.sunday)}`);
    if (a.urgent !== b.urgent) out.push(`Urgence : ${pct(a.urgent)} → ${pct(b.urgent)}`);
    if (a.subscription !== b.subscription) out.push(`Abonnement : −${pct(a.subscription)} → −${pct(b.subscription)}`);
    if (a.kit !== b.kit) out.push(`Matériel : ${a.kit} → ${b.kit} €`);
    const added = b.openDepts.filter((d) => !a.openDepts.includes(d));
    const removed = a.openDepts.filter((d) => !b.openDepts.includes(d));
    if (added.length) out.push(`Départements ouverts : ${added.join(', ')}`);
    if (removed.length) out.push(`Départements fermés : ${removed.join(', ')}`);
    return out;
  };
  route('GET', '/api/admin/pricing', ({ user }) => {
    need(user, 'admin');
    return { current: pricing.settings(), defaults: pricing.DEFAULTS, idfDepts: pricing.IDF_DEPTS,
      cost: { heure: pricing.COSTS.salarieeParHeureFacturee, tvaParticulier: pricing.COSTS.tvaParticulier, tvaPro: pricing.COSTS.tvaPro },
      history: db.prepare('SELECT at, by_name, changes FROM pricing_history ORDER BY id DESC LIMIT 15').all().map((h) => ({ ...h, changes: JSON.parse(h.changes) })) };
  });
  route('POST', '/api/admin/pricing', ({ user, body }) => {
    need(user, 'admin');
    const r = (x) => Math.round(Number(x) * 100) / 100;
    const g = (z) => ({ menage: r(body?.grid?.[z]?.menage), grand: r(body?.grid?.[z]?.grand), bureau: r(body?.grid?.[z]?.bureau),
      airbnb: Object.fromEntries(Object.keys(pricing.AIRBNB_HOURS).map((k) => [k, r(body?.grid?.[z]?.airbnb?.[k])])) });
    const next = { grid: { IDF: g('IDF'), FR: g('FR') }, sunday: r(body.sunday), urgent: r(body.urgent), subscription: r(body.subscription), kit: r(body.kit),
      openDepts: Array.isArray(body.openDepts) ? [...new Set(body.openDepts.map((d) => String(d).trim()))].filter(Boolean).sort() : [] };
    const errors = pricing.validateSettings(next);
    if (errors.length) throw new HttpError(400, errors.join(' '));
    const before = pricing.settings();
    const changes = describeChanges(before, next);
    if (!changes.length) return { ok: true, message: 'Aucun changement.' };
    pricing.applySettings(next);
    db.prepare("INSERT INTO settings (key, value, updated_by) VALUES ('pricing', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by")
      .run(JSON.stringify(pricing.settings()), user.id);
    db.prepare('INSERT INTO pricing_history (by_name, changes) VALUES (?, ?)').run(user.name, JSON.stringify(changes));
    db_.log(db, `Tarifs modifiés par ${user.name} : ${changes.join(' ; ')}. Les réservations existantes gardent leur prix.`);
    return { ok: true, message: `Enregistré : ${changes.length} changement(s). Les réservations existantes gardent leur prix.` };
  });

  // ----- versements aux indépendantes, chaque semaine, avec bonus qualité -----
  // bonus de niveau (Platine par défaut : +1 € de l'heure), réglable dans l'admin
  const mondayOf = (d) => { const t = new Date(d + 'T12:00:00Z'); const wd = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - wd * 864e5).toISOString().slice(0, 10); };
  const bonusOf = (wid) => {
    const t = tiers.tierOf(db, wid);
    return { eligible: t.bonus > 0, avg: t.rating, count: t.rated, perHour: t.bonus, tier: t.key };
  };
  const paidIds = () => new Set(db.prepare('SELECT booking_ids FROM payouts').all().flatMap((p) => JSON.parse(p.booking_ids)));
  // historique des tarifs : chaque ménage est payé au tarif en vigueur le jour où il a été fait
  db.exec('CREATE TABLE IF NOT EXISTS worker_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id INTEGER NOT NULL REFERENCES users(id), rate REAL NOT NULL, since TEXT NOT NULL)');
  const rateAt = (wid, date) => {
    const r = db.prepare('SELECT rate FROM worker_rates WHERE worker_id = ? AND since <= ? ORDER BY since DESC, id DESC LIMIT 1').get(wid, date);
    if (r) return r.rate;
    const w = db.prepare('SELECT rate FROM workers WHERE user_id = ?').get(wid);
    return (w && w.rate) || 0;
  };
  const earnOf = (wid, rows) => Math.round(rows.reduce((t, b) => t + b.hours * rateAt(wid, b.date), 0) * 100) / 100;
  const owedFor = (wid) => {
    const w = workerProfile(wid);
    if (!w || w.statut !== 'I') return [];
    const done = paidIds();
    const bonus = bonusOf(wid);
    const rows = db.prepare("SELECT id, date, hours FROM bookings WHERE worker_id = ? AND status = 'terminee' ORDER BY date").all(wid).filter((b) => !done.has(b.id));
    const weeks = new Map();
    for (const b of rows) {
      const k = mondayOf(b.date);
      if (!weeks.has(k)) weeks.set(k, { week_start: k, hours: 0, ids: [], eur: 0 });
      const x = weeks.get(k); x.hours += b.hours; x.ids.push(b.id); x.eur += b.hours * rateAt(wid, b.date);
    }
    // pourboires payés pas encore versés, rangés dans la semaine de leur paiement
    for (const t of db.prepare("SELECT id, amount_cents, paid_at FROM tips WHERE worker_id = ? AND status = 'paye' AND payout_id IS NULL").all(wid)) {
      const k = mondayOf(t.paid_at.slice(0, 10));
      if (!weeks.has(k)) weeks.set(k, { week_start: k, hours: 0, ids: [], eur: 0 });
      const x = weeks.get(k); x.tips = (x.tips || 0) + t.amount_cents; (x.tipIds = x.tipIds || []).push(t.id);
    }
    return [...weeks.values()].sort((a, c) => a.week_start.localeCompare(c.week_start)).map((x) => {
      const bonusRate = bonus.eligible ? bonus.perHour : 0;
      const tips = (x.tips || 0) / 100;
      return { worker_id: wid, name: w.name, week_start: x.week_start, hours: x.hours, rate: w.rate, bonus_rate: bonusRate, tips, tip_ids: x.tipIds || [], amount: Math.round((x.eur + x.hours * bonusRate + tips) * 100) / 100, booking_ids: x.ids };
    });
  };
  // ----- IBAN des intervenantes et virement groupé SEPA (fichier à importer dans la banque) -----
  for (const [c, t] of [['iban', 'TEXT'], ['iban_name', 'TEXT']]) if (!db.prepare('PRAGMA table_info(workers)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE workers ADD COLUMN ${c} ${t}`);
  const cleanIban = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
  const ibanOk = (iban) => {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    const r = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let m = 0; for (const ch of r) m = (m * 10 + Number(ch)) % 97;
    return m === 1;
  };
  const maskIban = (iban) => (iban ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : null);
  route('POST', '/api/worker/iban', ({ user, body }) => {
    need(user, 'intervenante');
    const iban = cleanIban(body.iban);
    const name = str(body.name, 70);
    if (!ibanOk(iban)) throw new HttpError(400, 'IBAN invalide : vérifiez les chiffres (il commence par FR76 pour un compte français).');
    if (name.length < 3) throw new HttpError(400, 'Indiquez le nom du titulaire du compte.');
    db.prepare('UPDATE workers SET iban = ?, iban_name = ? WHERE user_id = ?').run(iban, name, user.id);
    db_.log(db, `${user.name} a enregistré son IBAN (${maskIban(iban)}).`);
    for (const to of ownerEmails()) mailer.send(to, `IBAN modifié : ${user.name}`, 'Coordonnées bancaires modifiées', [`${user.name} a enregistré un IBAN se terminant par ${iban.slice(-4)}.`, 'Si ce changement vous surprend, appelez-la avant le prochain virement.'], null);
    return { ok: true, message: 'IBAN enregistré.', iban: maskIban(iban) };
  });
  route('GET', '/api/worker/iban', ({ user }) => {
    need(user, 'intervenante');
    const w = db.prepare('SELECT iban, iban_name FROM workers WHERE user_id = ?').get(user.id);
    return { iban: w ? maskIban(w.iban) : null, name: w ? w.iban_name : null };
  });
  const xmlEsc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const sepaText = (t, n = 70) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 /\-?:().,'+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  route('GET', '/api/admin/payouts/sepa.xml', ({ user, res }) => {
    need(user, 'admin');
    if (!isOwner(user)) throw new HttpError(403, 'Réservé au responsable.');
    const debtorIban = cleanIban(company.iban);
    if (!ibanOk(debtorIban)) throw new HttpError(409, 'Ajoutez l\'IBAN du compte Proprigo dans config/entreprise.json (champ « iban ») pour créer le fichier de virements.');
    const today = pricing.todayParis(now());
    const items = db.prepare("SELECT w.user_id, w.iban, w.iban_name FROM workers w WHERE w.statut = 'I'").all()
      .flatMap((w) => owedFor(w.user_id).filter((o) => o.week_start < mondayOf(today)).map((o) => ({ ...o, iban: w.iban, iban_name: w.iban_name })))
      .filter((o) => o.amount > 0 && ibanOk(cleanIban(o.iban)));
    if (!items.length) throw new HttpError(409, 'Aucun versement prêt : semaines terminées, avec un IBAN enregistré.');
    const total = items.reduce((t, o) => t + Math.round(o.amount * 100), 0);
    const stamp = new Date(now()).toISOString().replace(/\.\d+Z$/, '');
    const msgId = `PROPRIGO-${stamp.replace(/\D/g, '').slice(0, 14)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<CstmrCdtTrfInitn>
<GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>${stamp}</CreDtTm><NbOfTxs>${items.length}</NbOfTxs><CtrlSum>${(total / 100).toFixed(2)}</CtrlSum><InitgPty><Nm>${xmlEsc(sepaText(company.raisonSociale || company.nomCommercial || 'Proprigo'))}</Nm></InitgPty></GrpHdr>
<PmtInf><PmtInfId>${msgId}-1</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg><NbOfTxs>${items.length}</NbOfTxs><CtrlSum>${(total / 100).toFixed(2)}</CtrlSum>
<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf><ReqdExctnDt>${today}</ReqdExctnDt>
<Dbtr><Nm>${xmlEsc(sepaText(company.raisonSociale || company.nomCommercial || 'Proprigo'))}</Nm></Dbtr><DbtrAcct><Id><IBAN>${debtorIban}</IBAN></Id></DbtrAcct><DbtrAgt><FinInstnId>${company.bic ? `<BIC>${xmlEsc(String(company.bic).trim())}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId></DbtrAgt><ChrgBr>SLEV</ChrgBr>
${items.map((o, i) => `<CdtTrfTxInf><PmtId><EndToEndId>${msgId.slice(-12)}-${i + 1}</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${o.amount.toFixed(2)}</InstdAmt></Amt><Cdtr><Nm>${xmlEsc(sepaText(o.iban_name || o.name))}</Nm></Cdtr><CdtrAcct><Id><IBAN>${cleanIban(o.iban)}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>${xmlEsc(sepaText(`Proprigo semaine du ${fr(o.week_start)}`, 140))}</Ustrd></RmtInf></CdtTrfTxInf>`).join('\n')}
</PmtInf>
</CstmrCdtTrfInitn>
</Document>`;
    db_.log(db, `Fichier de virements groupés ${msgId} créé par ${user.name} : ${items.length} virement(s), ${(total / 100).toFixed(2)} €.`);
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${msgId}.xml"`, 'Cache-Control': 'no-store', 'X-Proprigo-Reference': msgId });
    res.end(xml);
    return { streamed: true };
  });
  route('GET', '/api/admin/payouts', ({ user }) => {
    need(user, 'admin');
    const ind = db.prepare("SELECT user_id FROM workers WHERE statut = 'I'").all();
    const today = pricing.todayParis(now());
    const ibanOf = (wid) => (db.prepare('SELECT iban FROM workers WHERE user_id = ?').get(wid) || {}).iban;
    const owed = ind.flatMap((w) => owedFor(w.user_id)).map((o) => ({ ...o, weekOver: o.week_start < mondayOf(today), iban: maskIban(ibanOf(o.worker_id)) }));
    const history = db.prepare('SELECT p.*, u.name FROM payouts p JOIN users u ON u.id = p.worker_id ORDER BY p.id DESC LIMIT 20').all();
    return { owed, history, total: Math.round(owed.reduce((t, o) => t + o.amount, 0) * 100) / 100 };
  });
  route('POST', '/api/admin/payouts', ({ user, body }) => {
    need(user, 'admin');
    const wid = Number(body.worker_id);
    const week = String(body.week_start || '');
    const o = owedFor(wid).find((x) => x.week_start === week);
    if (!o) throw new HttpError(409, 'Rien à verser pour cette semaine.');
    const reference = str(body.reference, 60) || null;
    const payoutId = () => db.prepare('SELECT MAX(id) AS id FROM payouts').get().id;
    db.prepare('INSERT INTO payouts (worker_id, week_start, hours, rate, bonus_rate, amount, booking_ids, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(wid, week, o.hours, o.rate, o.bonus_rate, o.amount, JSON.stringify(o.booking_ids), reference, user.id);
    if (o.tip_ids.length) db.prepare(`UPDATE tips SET payout_id = ? WHERE id IN (${o.tip_ids.map(() => '?').join(',')})`).run(payoutId(), ...o.tip_ids);
    mailer.send(emailOf(wid), `Versement de ${o.amount.toFixed(2).replace('.', ',')} €`, 'Votre versement Proprigo', [`Semaine du ${fr(week)} : ${String(o.hours).replace('.', ',')} h × ${o.rate} €${o.bonus_rate ? ` + bonus Platine ${o.bonus_rate} €/h` : ''}${o.tips ? ` + pourboires ${o.tips.toFixed(2).replace('.', ',')} €` : ''}.`, `Montant : ${o.amount.toFixed(2).replace('.', ',')} €${reference ? ` (référence ${reference})` : ''}.`], { label: 'Voir mes gains', path: '/#/intervenante' });
    db_.log(db, `Versement de ${o.amount} € à ${o.name} pour la semaine du ${week}.`);
    return { ok: true, message: `${o.amount.toFixed(2).replace('.', ',')} € marqués comme versés à ${o.name.split(' ')[0]}.` };
  });

  // ----- intervenante : mes gains -----
  // ----- intervenante : sa semaine (missions, propositions, disponibilités, congés) -----
  route('GET', '/api/worker/week', ({ user, query }) => {
    need(user, 'intervenante');
    const today = pricing.todayParis(now());
    const ask = pricing.isValidDate(query.get('start') || '') ? query.get('start') : today;
    const d0 = new Date(`${ask}T12:00:00Z`);
    d0.setUTCDate(d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7)); // lundi
    const days = [];
    const avail = db.prepare('SELECT start, end FROM availability WHERE worker_id = ? AND weekday = ?');
    const off = db.prepare('SELECT 1 FROM timeoff WHERE worker_id = ? AND start_date <= ? AND end_date >= ?');
    const missions = db.prepare("SELECT id, date, time, hours, cp, service, status, on_way_at, arrived_at FROM bookings WHERE worker_id = ? AND date = ? AND status IN ('attribuee','en_cours','terminee') ORDER BY time");
    const offers = db.prepare("SELECT b.id, b.date, b.time, b.hours, b.cp, b.service FROM offers o JOIN bookings b ON b.id = o.booking_id WHERE o.worker_id = ? AND o.state = 'offered' AND b.status = 'proposee' AND b.date = ? ORDER BY b.time");
    for (let i = 0; i < 7; i++) {
      const d = new Date(d0); d.setUTCDate(d0.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      const a = avail.get(user.id, d.getUTCDay());
      days.push({ date, today: date === today, off: Boolean(off.get(user.id, date, date)), avail: a || null,
        items: [...missions.all(user.id, date).map((m) => ({ ...m, kind: 'mission', key: m.service, service: SERVICE_NAME[m.service] || m.service })),
          ...offers.all(user.id, date).map((o) => ({ ...o, kind: 'offre', key: o.service, service: SERVICE_NAME[o.service] || o.service }))].sort((x, y) => x.time.localeCompare(y.time)) });
    }
    const shift = (n) => { const d = new Date(d0); d.setUTCDate(d0.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    return { start: shift(0), prev: shift(-7), next: shift(7), days, hours: days.reduce((t, d) => t + d.items.filter((x) => x.kind === 'mission').reduce((u, x) => u + x.hours, 0), 0) };
  });

  route('GET', '/api/worker/earnings', ({ user }) => {
    need(user, 'intervenante');
    const w = workerProfile(user.id);
    const m0 = pricing.todayParis(now()).slice(0, 7);
    const prev = new Date(Date.parse(m0 + '-15T12:00:00Z') - 30 * 864e5).toISOString().slice(0, 7);
    const sum = (where, ...args) => db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h FROM bookings WHERE worker_id = ? AND ${where}`).get(user.id, ...args);
    const rowsOf = (where, ...args) => db.prepare(`SELECT date, hours FROM bookings WHERE worker_id = ? AND ${where}`).all(user.id, ...args);
    const pack = (r, where, ...args) => ({ n: r.n, h: r.h, eur: w.statut === 'I' ? (where ? earnOf(user.id, rowsOf(where, ...args)) : Math.round(r.h * (w.rate || 0) * 100) / 100) : null });
    const months = db.prepare("SELECT substr(date, 1, 7) AS m, COUNT(*) AS n, SUM(hours) AS h FROM bookings WHERE worker_id = ? AND status = 'terminee' GROUP BY m ORDER BY m DESC LIMIT 12").all(user.id);
    const paidByMonth = w.statut === 'I' ? Object.fromEntries(db.prepare("SELECT substr(paid_at, 1, 7) AS m, SUM(amount) AS s FROM payouts WHERE worker_id = ? AND paid_at IS NOT NULL GROUP BY m").all(user.id).map((r) => [r.m, Math.round(r.s * 100) / 100])) : {};
    return {
      statut: w.statut, rate: w.rate, tier: tiers.tierOf(db, user.id),
      tipsMonth: db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM tips WHERE worker_id = ? AND status = 'paye' AND substr(paid_at, 1, 7) = ?").get(user.id, m0).c / 100,
      month: pack(sum("status = 'terminee' AND substr(date, 1, 7) = ?", m0), "status = 'terminee' AND substr(date, 1, 7) = ?", m0),
      lastMonth: pack(sum("status = 'terminee' AND substr(date, 1, 7) = ?", prev), "status = 'terminee' AND substr(date, 1, 7) = ?", prev),
      upcoming: pack(sum("status IN ('attribuee','en_cours') AND date >= ?", pricing.todayParis(now()))),
      history: months.map((r) => ({ month: r.m, ...pack(r, "status = 'terminee' AND substr(date, 1, 7) = ?", r.m), paid: paidByMonth[r.m] ?? null })),
      ...(w.statut === 'I' ? {
        bonus: bonusOf(user.id),
        pending: Math.round(owedFor(user.id).reduce((t, o) => t + o.amount, 0) * 100) / 100,
        paid: db.prepare('SELECT week_start, amount, paid_at FROM payouts WHERE worker_id = ? ORDER BY id DESC LIMIT 5').all(user.id),
      } : {}),
    };
  });

  // ----- intervenante : problème sur place -----
  const PROBLEMS = { acces: "Je n'arrive pas à entrer (clé, code, personne)", casse: "Un objet a été cassé ou abîmé", etat: "Le logement est bien plus sale que prévu", securite: 'Je ne me sens pas en sécurité', autre: 'Autre problème' };
  route('POST', '/api/worker/missions/:id/problem', ({ user, id, body }) => {
    need(user, 'intervenante');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND worker_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Mission introuvable.');
    if (!['attribuee', 'en_cours'].includes(b.status)) throw new HttpError(409, 'Signalement possible pendant la mission.');
    const kind = Object.hasOwn(PROBLEMS, body.kind) ? body.kind : null;
    if (!kind) throw new HttpError(400, 'Choisissez le type de problème.');
    const text = str(body.text, 600);
    db.prepare("UPDATE bookings SET problem = ?, problem_at = datetime('now') WHERE id = ?").run(kind, id);
    db.prepare("INSERT INTO incidents (booking_id, text, source) VALUES (?, ?, 'intervenante')").run(id, `${PROBLEMS[kind]}${text ? ` : ${text}` : ''}`);
    db.prepare('INSERT INTO messages (booking_id, sender_id, text) VALUES (?, ?, ?)').run(id, user.id, `Problème signalé à l'équipe : ${PROBLEMS[kind]}.`);
    db_.log(db, `URGENT · Réservation n° ${id} : ${user.name} signale « ${PROBLEMS[kind]} ».`);
    for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin'").all()) mailer.send(a.email, `Urgent : problème sur place (n° ${id})`, 'Problème signalé par une intervenante', [`${user.name} · ${b.address}, ${b.cp} · ${fr(b.date)} ${b.time}`, `${PROBLEMS[kind]}${text ? ` : ${text}` : ''}`], { label: 'Ouvrir le tableau de bord', path: '/#/admin' });
    return { ok: true, message: "L'équipe est prévenue et vous rappelle. Si vous êtes en danger, appelez le 17." };
  });

  // ----- client : attestation annuelle (crédit d'impôt) -----
  route('GET', '/api/me/attestation', ({ user, query, res }) => {
    need(user, 'client');
    const year = /^\d{4}$/.test(query.get('year') || '') ? query.get('year') : pricing.todayParis(now()).slice(0, 4);
    const rows = db.prepare("SELECT * FROM bookings WHERE client_id = ? AND status = 'terminee' AND service IN ('menage','grand') AND substr(date, 1, 4) = ? AND (paid = 1 OR ? = 0) ORDER BY date").all(user.id, year, production ? 1 : 0);
    const total = Math.round(rows.reduce((t, b) => t + b.total, 0) * 100) / 100;
    const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Attestation ${year}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:30px auto;padding:0 20px;color:#0f1a4a}h1{font-size:24px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border-bottom:1px solid #dfe5f3;padding:7px;text-align:left}td.n,th.n{text-align:right}.warn{background:#fff1e6;border:1px solid #ffb999;padding:12px;border-radius:10px}@media print{.noprint{display:none}}</style>
${sapOn() ? '' : `<p class="warn"><b>Document provisoire.</b> Cette attestation ne vaut pour le crédit d'impôt qu'une fois Proprigo déclaré « services à la personne » (n° [À COMPLÉTER]). Les ménages de logements de location courte durée et le nettoyage de bureaux n'y ouvrent pas droit et ne sont pas listés.</p>`}
<h1>Attestation fiscale annuelle ${year}</h1>
<p>${e(company.raisonSociale || 'Proprigo [RAISON SOCIALE]')}, ${e(company.adresse || '[ADRESSE]')}, SIRET ${e(company.siret || '[SIRET]')}${sapOn() ? `, déclaré organisme de services à la personne sous le n° ${e(sapSettings().numero)},` : ''} atteste que <b>${e(user.name)}</b> a bénéficié des prestations de ménage à domicile suivantes, réglées en ${year} :</p>
<table><tr><th>Date</th><th>Prestation</th><th>Adresse</th><th class="n">Heures</th><th class="n">Montant TTC</th></tr>
${rows.map((b) => `<tr><td>${e(b.date.split('-').reverse().join('/'))}</td><td>${b.service === 'grand' ? 'Grand nettoyage' : 'Ménage'}</td><td>${e(b.address)}, ${e(b.cp)}</td><td class="n">${String(b.hours).replace('.', ',')}</td><td class="n">${b.total.toFixed(2).replace('.', ',')} €</td></tr>`).join('') || '<tr><td colspan="5">Aucune prestation éligible cette année.</td></tr>'}
<tr><th colspan="4">Total réglé</th><th class="n">${total.toFixed(2).replace('.', ',')} €</th></tr></table>
<p>Montant ouvrant droit au crédit d'impôt, selon les conditions en vigueur : ${total.toFixed(2).replace('.', ',')} €.</p>
<p class="noprint"><button onclick="print()">Imprimer ou enregistrer en PDF</button></p></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'Cache-Control': 'no-store' });
    res.end(html);
    return { streamed: true };
  });

  // ----- fiches client et intervenante, notes internes de l'équipe -----
  route('GET', '/api/admin/clients/:id', ({ user, id }) => {
    needStaff(user);
    const c = db.prepare("SELECT id, name, email, phone, created_at, referred_by FROM users WHERE id = ? AND role = 'client'").get(id);
    if (!c) throw new HttpError(404, 'Client introuvable.');
    const bookings = db.prepare('SELECT id, date, time, service, size, hours, cp, status, total, rating, review, worker_id FROM bookings WHERE client_id = ? ORDER BY date DESC LIMIT 50').all(id);
    const homes = db.prepare('SELECT id, name, cp FROM homes WHERE client_id = ?').all(id);
    const owner = isOwner(user);
    return {
      client: { ...c, email: owner ? c.email : '', phone: owner ? c.phone : '' },
      stats: { menages: bookings.filter((b) => b.status === 'terminee').length, annules: bookings.filter((b) => b.status === 'annulee').length, depense: owner ? Math.round(bookings.filter((b) => b.status === 'terminee').reduce((t, b) => t + b.total, 0)) : null, credit: owner ? creditOf(id) : null },
      bookings: bookings.map((b) => ({ ...b, total: owner ? b.total : null })), homes,
      notes: db.prepare("SELECT n.id, n.text, n.created_at, n.share, u.name AS author FROM admin_notes n JOIN users u ON u.id = n.author_id WHERE kind = 'client' AND target_id = ? ORDER BY n.id DESC").all(id),
    };
  });
  route('GET', '/api/admin/workers/:id/file', ({ user, id }) => {
    needStaff(user);
    const w = workerProfile(id);
    if (!w) throw new HttpError(404, 'Intervenante introuvable.');
    const st = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h, AVG(rating) AS avg, COUNT(rating) AS rated FROM bookings WHERE worker_id = ? AND status = 'terminee'").get(id);
    const refused = db.prepare("SELECT COUNT(*) AS n FROM offers WHERE worker_id = ? AND state = 'refused'").get(id).n;
    const problems = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE worker_id = ? AND problem IS NOT NULL").get(id).n;
    const low = db.prepare("SELECT id, date, rating, review FROM bookings WHERE worker_id = ? AND rating IS NOT NULL AND rating < 4 ORDER BY date DESC LIMIT 5").all(id);
    return {
      worker: { user_id: w.user_id, name: w.name, statut: w.statut, cp: w.cp, rate: w.rate, step: w.step, steps: db_.STEPS[w.statut], absent: w.absent, bio: w.bio, languages: w.languages, email: isOwner(user) ? w.email : '', phone: isOwner(user) ? w.phone : '' },
      stats: { missions: st.n, heures: st.h, note: st.rated ? Math.round(st.avg * 10) / 10 : null, avis: st.rated, refus: refused, problemes: problems },
      lowRatings: low,
      upcoming: db.prepare("SELECT id, date, time, cp, hours FROM bookings WHERE worker_id = ? AND status IN ('attribuee','en_cours') ORDER BY date, time LIMIT 10").all(id),
      notes: db.prepare("SELECT n.id, n.text, n.created_at, u.name AS author FROM admin_notes n JOIN users u ON u.id = n.author_id WHERE kind = 'worker' AND target_id = ? ORDER BY n.id DESC").all(id),
      // Pièces justificatives : visibles du responsable seulement.
      documents: isOwner(user) ? docsOf(id) : null,
      rejected: w.rejected_at ? { at: w.rejected_at, reason: isOwner(user) ? w.reject_reason : null } : null,
    };
  });
  if (!db.prepare('PRAGMA table_info(admin_notes)').all().some((x) => x.name === 'share')) db.exec('ALTER TABLE admin_notes ADD COLUMN share INTEGER NOT NULL DEFAULT 0');
  route('POST', '/api/admin/notes/:id/share', ({ user, id, body }) => {
    needStaff(user);
    const r = db.prepare("UPDATE admin_notes SET share = ? WHERE id = ? AND kind = 'client'").run(body.share ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, 'Note introuvable.');
    return { ok: true, message: body.share ? 'Visible par l\'intervenante.' : 'Réservée à l\'équipe.' };
  });
  route('POST', '/api/admin/notes', ({ user, body }) => {
    needStaff(user);
    const kind = body.kind === 'worker' ? 'worker' : body.kind === 'client' ? 'client' : null;
    const target = Number(body.target_id);
    const text = str(body.text, 1000);
    if (!kind || !target || text.length < 2) throw new HttpError(400, 'Note vide.');
    // une note sur un client peut être montrée à l'intervenante de ses ménages (jamais au client)
    const share = kind === 'client' && body.share ? 1 : 0;
    db.prepare('INSERT INTO admin_notes (kind, target_id, author_id, text, share) VALUES (?, ?, ?, ?, ?)').run(kind, target, user.id, text, share);
    return { ok: true, message: share ? 'Note enregistrée : l\'intervenante la verra sur ses missions chez ce client.' : 'Note enregistrée (équipe seulement).' };
  });

  // ----- comptes de l'équipe : accès « planning » sans argent ni remboursements -----
  route('GET', '/api/admin/staff', ({ user }) => {
    need(user, 'admin');
    return db.prepare("SELECT id, name, email, COALESCE(staff_level, 'owner') AS level, created_at FROM users WHERE role = 'admin' ORDER BY id").all();
  });
  route('POST', '/api/admin/staff', ({ user, body }) => {
    need(user, 'admin');
    const email = str(body.email, 120).toLowerCase();
    const name = str(body.name, 80);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || !EMAIL_RE.test(email)) throw new HttpError(400, 'Nom et e-mail valides requis.');
    if (password.length < 12) throw new HttpError(400, 'Mot de passe provisoire : 12 caractères minimum.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail.');
    const id = db_.createUser(db, { role: 'admin', email, password, name, phone: '' });
    db.prepare("UPDATE users SET staff_level = 'planning' WHERE id = ?").run(id);
    db_.log(db, `Compte « planning » créé pour ${name}.`);
    return { status: 201, data: { ok: true, message: `Compte planning créé pour ${name}. Demandez-lui de changer son mot de passe dans « Mon compte ».` } };
  });
  for (const step of ['onway', 'arrived']) route('POST', `/api/worker/missions/:id/${step}`, ({ user, id, body }) => {
    need(user, 'intervenante');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND worker_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Mission introuvable.');
    if (b.status !== 'attribuee') throw new HttpError(409, 'Cette mission a déjà commencé ou est terminée.');
    if (b.date !== pricing.todayParis(now())) throw new HttpError(409, 'Ce bouton sert le jour de la mission.');
    const first = user.name.split(' ')[0];
    if (step === 'onway') {
      // Heure d'arrivée estimée : choisie par l'intervenante (5 à 90 minutes), modifiable tant qu'elle n'est pas arrivée.
      const mins = [5, 10, 15, 20, 30, 45, 60, 90].includes(Number(body.eta)) ? Number(body.eta) : null;
      const eta = mins ? new Date(now().getTime() + mins * 60e3) : null;
      const hhmm = eta ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(eta) : null;
      if (b.on_way_at && !mins) return { ok: true, message: 'Le client sait déjà que vous êtes en route.' };
      db.prepare("UPDATE bookings SET on_way_at = COALESCE(on_way_at, datetime('now')), eta_at = ? WHERE id = ?").run(eta ? eta.toISOString() : null, id);
      engine.notify(db, id, b.on_way_at ? `${first} a mis à jour son heure d'arrivée : vers ${hhmm}.` : `${first} est en route vers votre logement${hhmm ? ` : arrivée estimée vers ${hhmm}` : ''}.`);
      return { ok: true, message: hhmm ? `Le client est prévenu : arrivée vers ${hhmm}.` : 'Le client est prévenu que vous êtes en route.' };
    }
    if (b.arrived_at) return { ok: true, message: 'Arrivée déjà signalée.' };
    db.prepare("UPDATE bookings SET arrived_at = datetime('now'), on_way_at = COALESCE(on_way_at, datetime('now')) WHERE id = ?").run(id);
    engine.notify(db, id, `${first} est arrivée.`);
    return { ok: true, message: 'Arrivée signalée au client.' };
  });

  // ----- fiche de l'intervenante, visible par ses clients -----
  route('GET', '/api/workers/:id/card', ({ user, id }) => {
    need(user);
    const allowed = user.role === 'admin' || user.id === id || db.prepare("SELECT 1 FROM bookings WHERE client_id = ? AND worker_id = ? AND status IN ('attribuee','en_cours','terminee')").get(user.id, id);
    if (!allowed) throw new HttpError(404, 'Fiche introuvable.');
    const w = db.prepare('SELECT w.user_id, w.bio, w.languages, u.name, u.created_at FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(id);
    if (!w) throw new HttpError(404, 'Fiche introuvable.');
    const st = db.prepare("SELECT COUNT(*) AS n, AVG(rating) AS avg, COUNT(rating) AS rated FROM bookings WHERE worker_id = ? AND status = 'terminee'").get(id);
    const reviews = db.prepare("SELECT rating, review, date FROM bookings WHERE worker_id = ? AND status = 'terminee' AND review IS NOT NULL AND rating >= 4 ORDER BY date DESC LIMIT 3").all(id);
    const tier = tiers.tierOf(db, id);
    const own = user.id === id || user.role === 'admin';
    return { id, photo: hasAvatar(id), gender: genderOf(id), ...(own ? { avatar_status: db.prepare('SELECT avatar_status FROM workers WHERE user_id = ?').get(id).avatar_status || null } : {}), displayName: displayName(w.name), tier: { key: tier.key, label: tier.label, icon: tier.icon }, firstName: w.name.split(' ')[0], since: w.created_at.slice(0, 7), missions: st.n, rating: st.rated ? Math.round(st.avg * 10) / 10 : null, ratings: st.rated, languages: w.languages || '', bio: w.bio || '', reviews };
  });
  // ----- photo de profil des intervenantes (validée par l'équipe avant d'être montrée aux clients) -----
  const AVATARS = path.join(PHOTOS, 'avatars');
  fs.mkdirSync(AVATARS, { recursive: true });
  const dropAvatarFile = (f) => { if (f) try { fs.unlinkSync(path.join(AVATARS, path.basename(f))); } catch { /* déjà supprimée */ } };
  route('POST', '/api/worker/avatar', ({ user, body }) => {
    need(user, 'intervenante');
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpError(400, 'Photo invalide (JPEG ou PNG).');
    const buf = Buffer.from(m[2], 'base64');
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!(isJpeg || isPng) || buf.length > 1_500_000) throw new HttpError(400, 'Photo invalide ou trop lourde.');
    const old = db.prepare('SELECT avatar FROM workers WHERE user_id = ?').get(user.id);
    if (!old) throw new HttpError(404, 'Profil introuvable.');
    const file = `${user.id}-${crypto.randomBytes(8).toString('hex')}.${isJpeg ? 'jpg' : 'png'}`;
    fs.writeFileSync(path.join(AVATARS, file), buf);
    db.prepare("UPDATE workers SET avatar = ?, avatar_status = 'a_verifier', avatar_at = datetime('now') WHERE user_id = ?").run(file, user.id);
    dropAvatarFile(old.avatar);
    db_.log(db, `Nouvelle photo de profil à vérifier : ${user.name}.`);
    for (const to of ownerEmails()) mailer.send(to, `Photo de profil à vérifier : ${user.name}`, 'Une photo de profil attend votre accord', [`${user.name} a envoyé une photo de profil.`, 'Vérifiez-la dans l\'admin, onglet Équipe : visage bien visible, photo nette et correcte. Elle ne sera montrée aux clients qu\'après votre accord.'], null);
    return { ok: true, message: 'Photo envoyée. Elle sera visible des clients après vérification par l\'équipe.' };
  });
  route('POST', '/api/worker/avatar/remove', ({ user }) => {
    need(user, 'intervenante');
    const old = db.prepare('SELECT avatar FROM workers WHERE user_id = ?').get(user.id);
    db.prepare('UPDATE workers SET avatar = NULL, avatar_status = NULL, avatar_at = NULL WHERE user_id = ?').run(user.id);
    if (old) dropAvatarFile(old.avatar);
    return { ok: true, message: 'Photo supprimée.' };
  });
  route('GET', '/api/workers/:id/avatar', ({ user, id, res }) => {
    need(user);
    const w = db.prepare('SELECT avatar, avatar_status FROM workers WHERE user_id = ?').get(id);
    const self = user.id === id || user.role === 'admin';
    const client = w && w.avatar_status === 'valide' && db.prepare("SELECT 1 FROM bookings WHERE client_id = ? AND worker_id = ? AND status IN ('attribuee','en_cours','terminee')").get(user.id, id);
    if (!w || !w.avatar || !(self || client)) throw new HttpError(404, 'Photo introuvable.');
    res.writeHead(200, { 'Content-Type': w.avatar.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=300' });
    fs.createReadStream(path.join(AVATARS, path.basename(w.avatar))).on('error', () => res.end()).pipe(res);
    return { streamed: true };
  });
  // tarif d'une indépendante : modifié par le responsable, avec son accord ; s'applique aux ménages faits à partir d'aujourd'hui
  route('POST', '/api/admin/workers/:id/gender', ({ user, id, body }) => {
    needStaff(user);
    const r = db.prepare('UPDATE workers SET gender = ? WHERE user_id = ?').run(body.gender === 'h' ? 'h' : 'f', id);
    if (!r.changes) throw new HttpError(404, 'Intervenant(e) introuvable.');
    return { ok: true, message: body.gender === 'h' ? 'Enregistré : homme (« intervenant »).' : 'Enregistré : femme (« intervenante »).' };
  });
  route('POST', '/api/admin/workers/:id/rate', ({ user, id, body }) => {
    need(user, 'admin');
    if (!isOwner(user)) throw new HttpError(403, 'Réservé au responsable.');
    const w = db.prepare("SELECT w.rate, w.statut, u.name, u.email FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?").get(id);
    if (!w || w.statut !== 'I') throw new HttpError(404, 'Indépendante introuvable.');
    const rate = Math.round(Number(body.rate) * 2) / 2;
    if (!(rate >= 15 && rate <= 40)) throw new HttpError(400, 'Tarif entre 15 et 40 € de l\'heure.');
    if (rate === w.rate) return { ok: true, message: 'Tarif inchangé.' };
    const today = pricing.todayParis(now());
    if (!db.prepare('SELECT 1 FROM worker_rates WHERE worker_id = ?').get(id)) db.prepare("INSERT INTO worker_rates (worker_id, rate, since) VALUES (?, ?, '0000-01-01')").run(id, w.rate);
    db.prepare('INSERT INTO worker_rates (worker_id, rate, since) VALUES (?, ?, ?)').run(id, rate, today);
    db.prepare('UPDATE workers SET rate = ? WHERE user_id = ?').run(rate, id);
    db_.log(db, `Tarif de ${w.name} : ${w.rate} € → ${rate} € de l'heure (par ${user.name}).`);
    mailer.send(w.email, 'Votre tarif horaire', 'Votre tarif a changé', [`Comme convenu avec l'équipe, votre tarif passe de ${String(w.rate).replace('.', ',')} € à ${String(rate).replace('.', ',')} € de l'heure.`, 'Il s\'applique aux ménages faits à partir d\'aujourd\'hui. Si vous n\'étiez pas d\'accord, répondez à cet e-mail.'], null);
    return { ok: true, message: `Tarif passé à ${String(rate).replace('.', ',')} € de l'heure. Elle est prévenue par e-mail.` };
  });
  route('POST', '/api/admin/workers/:id/avatar', ({ user, id, body }) => {
    needStaff(user);
    const w = db.prepare('SELECT w.avatar, u.name, u.email FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(id);
    if (!w || !w.avatar) throw new HttpError(404, 'Pas de photo à vérifier.');
    if (body.ok) {
      db.prepare("UPDATE workers SET avatar_status = 'valide' WHERE user_id = ?").run(id);
      db_.log(db, `Photo de profil de ${w.name} acceptée par ${user.name}.`);
      return { ok: true, message: 'Photo acceptée : les clients la verront.' };
    }
    db.prepare('UPDATE workers SET avatar = NULL, avatar_status = NULL WHERE user_id = ?').run(id);
    dropAvatarFile(w.avatar);
    mailer.send(w.email, 'Votre photo de profil', 'Merci d\'envoyer une autre photo', ['Votre photo de profil n\'a pas pu être acceptée.', 'Envoyez une photo nette de votre visage, de face, sans lunettes de soleil, depuis « Compte », rubrique « Ma présentation aux clients ».'], null);
    db_.log(db, `Photo de profil de ${w.name} refusée par ${user.name}.`);
    return { ok: true, message: 'Photo refusée : l\'intervenante est invitée à en envoyer une autre.' };
  });
  route('POST', '/api/worker/profile', ({ user, body }) => {
    need(user, 'intervenante');
    const bio = str(body.bio, 300);
    const languages = str(body.languages, 120);
    db.prepare('UPDATE workers SET bio = ?, languages = ? WHERE user_id = ?').run(bio || null, languages || null, user.id);
    return { ok: true, message: 'Votre présentation est enregistrée.' };
  });

  // ----- espace propriétaires : logements -----
  const homeView = (h) => {
    const pw = h.preferred_worker_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(h.preferred_worker_id) : null;
    let list = [];
    try { list = JSON.parse(h.checklist || '[]'); } catch { list = []; }
    const next = db.prepare("SELECT date, time, status FROM bookings WHERE home_id = ? AND status IN ('en_attente','proposee','attribuee','en_cours') ORDER BY date, time LIMIT 5").all(h.id);
    return { ...h, checklist: list, preferred_name: pw ? pw.name : null, upcoming: next };
  };
  const homeInput = (body, old = {}) => {
    const name = str(body.name ?? old.name, 60);
    const address = str(body.address ?? old.address, 200);
    const cp = str(body.cp ?? old.cp, 5);
    const service = pricing.SERVICES.includes(body.service) ? body.service : old.service || 'airbnb';
    if (name.length < 2) throw new HttpError(400, 'Donnez un nom au logement (ex. : Studio Montmartre).');
    if (address.length < 5) throw new HttpError(400, 'Indiquez l\'adresse complète.');
    if (!pricing.zoneOf(cp)) throw new HttpError(400, 'Code postal invalide.');
    const size = service === 'airbnb' ? (pricing.AIRBNB_HOURS[body.size] ? body.size : old.size || 'T2') : null;
    const hours = service === 'airbnb' ? null : Math.min(8, Math.max(2, Number(body.hours ?? old.hours) || 3));
    const time = str(body.checkout_time ?? old.checkout_time ?? '11:00', 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Heure de départ invalide.');
    const icalUrl = str(body.ical_url ?? old.ical_url ?? '', 500) || null;
    const tasks = JSON.stringify(checklist.clean(body.checklist ?? (old.checklist ? JSON.parse(old.checklist).map((t) => t.task) : null), service));
    return { name, address, cp, service, size, hours, time, icalUrl, tasks, instructions: str(body.instructions ?? old.instructions ?? '', 1000), consent: (body.photo_consent ?? old.photo_consent) ? 1 : 0 };
  };

  route('GET', '/api/homes', ({ user }) => {
    need(user, 'client');
    return db.prepare('SELECT * FROM homes WHERE client_id = ? ORDER BY name').all(user.id).map(homeView);
  });

  route('POST', '/api/homes', ({ user, body }) => {
    need(user, 'client');
    if (db.prepare('SELECT COUNT(*) AS n FROM homes WHERE client_id = ?').get(user.id).n >= 50) throw new HttpError(409, '50 logements maximum.');
    const h = homeInput(body);
    const r = db.prepare(`INSERT INTO homes (client_id, name, address, cp, service, size, hours, instructions, checklist, photo_consent, ical_url, checkout_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, h.name, h.address, h.cp, h.service, h.size, h.hours, h.instructions, h.tasks, h.consent, h.icalUrl, h.time);
    db_.log(db, `Nouveau logement « ${h.name} » (${h.cp}) ajouté par un client.`);
    return { status: 201, data: homeView(db.prepare('SELECT * FROM homes WHERE id = ?').get(Number(r.lastInsertRowid))) };
  });

  route('POST', '/api/homes/:id', ({ user, id, body }) => {
    need(user, 'client');
    const old = db.prepare('SELECT * FROM homes WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!old) throw new HttpError(404, 'Logement introuvable.');
    const h = homeInput(body, old);
    let pref = old.preferred_worker_id;
    if (body.preferred_worker_id !== undefined) {
      pref = body.preferred_worker_id ? Number(body.preferred_worker_id) : null;
      if (pref && !db.prepare("SELECT 1 FROM bookings WHERE client_id = ? AND worker_id = ? AND status = 'terminee'").get(user.id, pref)) {
        throw new HttpError(400, 'Choisissez une intervenante qui a déjà fait un ménage chez vous.');
      }
    }
    db.prepare(`UPDATE homes SET name = ?, address = ?, cp = ?, service = ?, size = ?, hours = ?, instructions = ?, checklist = ?, photo_consent = ?, ical_url = ?, checkout_time = ?, preferred_worker_id = ? WHERE id = ?`)
      .run(h.name, h.address, h.cp, h.service, h.size, h.hours, h.instructions, h.tasks, h.consent, h.icalUrl, h.time, pref, id);
    return { ...homeView(db.prepare('SELECT * FROM homes WHERE id = ?').get(id)), message: 'Logement enregistré.' };
  });

  route('POST', '/api/homes/:id/delete', ({ user, id }) => {
    need(user, 'client');
    const h = db.prepare('SELECT * FROM homes WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!h) throw new HttpError(404, 'Logement introuvable.');
    if (db.prepare("SELECT 1 FROM bookings WHERE home_id = ? AND status IN ('en_attente','proposee','attribuee','en_cours')").get(id)) {
      throw new HttpError(409, 'Ce logement a des ménages à venir : annulez-les d\'abord.');
    }
    db.prepare('UPDATE bookings SET home_id = NULL WHERE home_id = ?').run(id);
    db.prepare('DELETE FROM homes WHERE id = ?').run(id);
    return { ok: true, message: 'Logement supprimé.' };
  });

  // Synchronisation Airbnb. En production, chaque ménage détecté attend le paiement du client :
  // il reçoit un message et un e-mail avec le bouton « Payer », et l'attribution n'a lieu qu'après paiement.
  const syncOptions = () => ({
    now: now(), allowAny: icalAllowAny, fetchText: icalFetch, prepay: production,
    onPrepay: (id, home, total) => {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
      engine.notify(db, id, `Nouveau départ de voyageurs détecté pour « ${home.name} » le ${fr(b.date)}. Le ménage est prêt : payez-le depuis « Mes réservations » pour qu'une intervenante soit attribuée.`);
      mailer.send(emailOf(home.client_id), `Ménage à confirmer : ${home.name}, ${fr(b.date)}`, 'Un ménage à confirmer', [
        `Le calendrier de « ${home.name} » indique un départ de voyageurs le ${fr(b.date)}.`,
        `Nous avons préparé le ménage (${String(total).replace('.', ',')} €). Payez-le pour qu'une intervenante soit attribuée.`,
        "Sans paiement, aucune intervenante ne viendra. Si vous n'en avez pas besoin, annulez-le simplement.",
      ], { label: 'Payer ce ménage', path: '/#/mes-reservations' });
    },
  });
  route('POST', '/api/homes/:id/sync', async ({ user, id }) => {
    need(user, 'client');
    const h = db.prepare('SELECT * FROM homes WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!h) throw new HttpError(404, 'Logement introuvable.');
    if (production && !stripeReady) throw new HttpError(503, 'Réservations Airbnb automatiques indisponibles tant que le paiement en ligne n’est pas activé.');
    const lastAsk = syncAsks.get(id) || 0;
    if (now().getTime() - lastAsk < 120e3) throw new HttpError(429, 'Calendrier déjà synchronisé il y a moins de 2 minutes.');
    syncAsks.set(id, now().getTime());
    try {
      return await ical.syncHome(db, h, syncOptions());
    } catch (e) {
      db.prepare("UPDATE homes SET last_sync = datetime('now'), last_sync_result = ? WHERE id = ?").run('Erreur : ' + e.message, id);
      throw new HttpError(400, e.message);
    }
  });

  // ----- intervenante préférée -----
  route('GET', '/api/my-workers', ({ user }) => {
    need(user, 'client');
    const fav = db.prepare('SELECT worker_id FROM favorites WHERE client_id = ?').get(user.id);
    const list = db.prepare(`SELECT u.id, u.name, COUNT(*) AS n, ROUND(AVG(b.rating), 1) AS note FROM bookings b JOIN users u ON u.id = b.worker_id
      WHERE b.client_id = ? AND b.status = 'terminee' GROUP BY u.id ORDER BY n DESC`).all(user.id)
      .map((w) => ({ ...w, name: displayName(w.name), photo: hasAvatar(w.id) }));
    return { favorite: fav ? fav.worker_id : null, list };
  });

  route('POST', '/api/favorite', ({ user, body }) => {
    need(user, 'client');
    if (!body.worker_id) {
      db.prepare('DELETE FROM favorites WHERE client_id = ?').run(user.id);
      return { ok: true, message: 'Plus d\'intervenante préférée.' };
    }
    const wid = Number(body.worker_id);
    const w = db.prepare("SELECT u.name FROM bookings b JOIN users u ON u.id = b.worker_id WHERE b.client_id = ? AND b.worker_id = ? AND b.status = 'terminee'").get(user.id, wid);
    if (!w) throw new HttpError(400, 'Choisissez une intervenante qui a déjà fait un ménage chez vous.');
    db.prepare('INSERT OR REPLACE INTO favorites (client_id, worker_id) VALUES (?, ?)').run(user.id, wid);
    // les ménages à venir encore sans intervenante lui sont proposés en priorité
    // Les commandes payées restent en attente jusqu'à l'attribution par l'administrateur.
    return { ok: true, message: `${w.name.split(' ')[0]} est votre intervenante préférée : elle sera choisie en priorité quand elle est libre.` };
  });

  // ----- disponibilités de l'intervenante -----
  route('POST', '/api/worker/availability', ({ user, body }) => {
    need(user, 'intervenante');
    const days = Array.isArray(body.days) ? body.days : [];
    const ok = [];
    for (const d of days) {
      const wd = Number(d.weekday); const st = str(d.start, 5); const en = str(d.end, 5);
      if (!(wd >= 0 && wd <= 6) || !/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(en) || en <= st) throw new HttpError(400, 'Horaires invalides : la fin doit être après le début.');
      if (ok.some((x) => x.weekday === wd)) throw new HttpError(400, 'Un seul créneau par jour.');
      ok.push({ weekday: wd, start: st, end: en });
    }
    db_.setAvailability(db, user.id, ok);
    db_.log(db, `${user.name} a mis à jour ses disponibilités.`);
    engine.retryPending(db);
    return { ok: true, message: 'Disponibilités enregistrées.' };
  });

  route('POST', '/api/worker/timeoff', ({ user, body }) => {
    need(user, 'intervenante');
    const a = str(body.start_date, 10); const z = str(body.end_date, 10);
    if (!pricing.isValidDate(a) || !pricing.isValidDate(z) || z < a) throw new HttpError(400, 'Dates de congé invalides.');
    db.prepare('INSERT INTO timeoff (worker_id, start_date, end_date) VALUES (?, ?, ?)').run(user.id, a, z);
    db_.log(db, `${user.name} : congé du ${a} au ${z}.`);
    // ses missions pendant ce congé sont confiées à une autre intervenante
    const hit = db.prepare("SELECT id FROM bookings WHERE worker_id = ? AND status = 'attribuee' AND date BETWEEN ? AND ?").all(user.id, a, z);
    for (const h of hit) { db.prepare("UPDATE bookings SET worker_id = NULL, status = 'en_attente' WHERE id = ?").run(h.id); db.prepare("DELETE FROM offers WHERE booking_id = ?").run(h.id); }
    return { ok: true, message: hit.length ? `Congé enregistré. ${hit.length} mission(s) confiée(s) à une autre intervenante.` : 'Congé enregistré.' };
  });

  route('POST', '/api/worker/timeoff/:id/delete', ({ user, id }) => {
    need(user, 'intervenante');
    db.prepare('DELETE FROM timeoff WHERE id = ? AND worker_id = ?').run(id, user.id);
    return { ok: true };
  });

  // ----- checklist -----
  route('POST', '/api/worker/missions/:id/checklist', ({ user, id, body }) => {
    need(user, 'intervenante');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND worker_id = ?').get(id, user.id);
    if (!b || !['attribuee', 'en_cours'].includes(b.status)) throw new HttpError(409, 'Mission non modifiable.');
    const list = JSON.parse(b.checklist || '[]');
    const i = Number(body.index);
    if (!list[i]) throw new HttpError(400, 'Tâche inconnue.');
    list[i].done = !!body.done;
    db.prepare('UPDATE bookings SET checklist = ? WHERE id = ?').run(JSON.stringify(list), id);
    return { ok: true };
  });

  // ----- photos avant / après (avec consentement du client) -----
  route('POST', '/api/bookings/:id/photos', ({ user, id, body }) => {
    need(user, 'intervenante');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND worker_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Mission introuvable.');
    if (!b.photo_consent) throw new HttpError(403, 'Le client n\'a pas accepté les photos pour ce ménage.');
    if (b.status !== 'en_cours') throw new HttpError(409, 'Les photos se prennent pendant le ménage.');
    const kind = body.kind === 'avant' ? 'avant' : 'apres';
    if (db.prepare('SELECT COUNT(*) AS n FROM photos WHERE booking_id = ?').get(id).n >= 12) throw new HttpError(409, '12 photos maximum par ménage.');
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpError(400, 'Photo invalide (JPEG ou PNG).');
    const buf = Buffer.from(m[2], 'base64');
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!(isJpeg || isPng) || buf.length > 3_000_000) throw new HttpError(400, 'Photo invalide ou trop lourde (3 Mo maximum).');
    const file = `${id}-${crypto.randomBytes(8).toString('hex')}.${isJpeg ? 'jpg' : 'png'}`;
    fs.writeFileSync(path.join(PHOTOS, file), buf);
    db.prepare('INSERT INTO photos (booking_id, kind, file, uploaded_by) VALUES (?, ?, ?, ?)').run(id, kind, file, user.id);
    return { ok: true };
  });

  // ----- notifications sur téléphone (Web Push) -----
  push.ensureTable(db);
  const pushSubject = `mailto:${String(mailer.cfg.from || 'contact@proprigo.fr').replace(/^.*<|>.*$/g, '').trim()}`;
  nativePush.ensureTable(db);
  const pushAll = async (d, userId, msg) => (await push.notifyUser(d, userId, msg, { subject: pushSubject })) + (await nativePush.notifyUser(d, userId, msg));
  engine.setPushHook(pushAll);
  // applis Android / iPhone : le téléphone donne son jeton de notification
  route('POST', '/api/push/native', ({ user, body }) => {
    need(user);
    const platform = String(body.platform || ''); const token = String(body.token || '').trim();
    if (!['ios', 'android'].includes(platform) || !nativePush.validToken(platform, token)) throw new HttpError(400, 'Jeton de notification invalide.');
    if (db.prepare('SELECT COUNT(*) AS n FROM native_push WHERE user_id = ?').get(user.id).n >= 10) db.prepare('DELETE FROM native_push WHERE id = (SELECT id FROM native_push WHERE user_id = ? ORDER BY id LIMIT 1)').run(user.id);
    db.prepare(`INSERT INTO native_push (user_id, platform, token) VALUES (?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, fails = 0`).run(user.id, platform, token);
    return { ok: true, message: 'Notifications activées sur ce téléphone.' };
  });
  route('POST', '/api/push/native/remove', ({ user, body }) => {
    need(user);
    db.prepare('DELETE FROM native_push WHERE user_id = ? AND token = ?').run(user.id, String(body.token || ''));
    return { ok: true };
  });
  route('GET', '/api/push/key', ({ user }) => {
    need(user);
    return { publicKey: push.vapidKeys(db).publicKey, subscribed: db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(user.id).n, native: db.prepare('SELECT COUNT(*) AS n FROM native_push WHERE user_id = ?').get(user.id).n };
  });
  route('POST', '/api/push/subscribe', ({ user, body }) => {
    need(user);
    const endpoint = String(body.endpoint || '');
    const p256dh = String(body.keys?.p256dh || ''); const auth = String(body.keys?.auth || '');
    if (!push.validEndpoint(endpoint)) throw new HttpError(400, 'Service de notification non reconnu.');
    if (push.fromB64u(p256dh).length !== 65 || push.fromB64u(auth).length < 16) throw new HttpError(400, 'Abonnement invalide.');
    if (db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(user.id).n >= 10) db.prepare('DELETE FROM push_subs WHERE id = (SELECT id FROM push_subs WHERE user_id = ? ORDER BY id LIMIT 1)').run(user.id);
    db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, fails = 0`).run(user.id, endpoint, p256dh, auth);
    return { ok: true, message: 'Notifications activées sur cet appareil.' };
  });
  route('POST', '/api/push/unsubscribe', ({ user, body }) => {
    need(user);
    db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(user.id, String(body.endpoint || ''));
    return { ok: true, message: 'Notifications désactivées sur cet appareil.' };
  });
  route('POST', '/api/push/test', async ({ user }) => {
    need(user);
    const n = await pushAll(db, user.id, { title: 'Proprigo', body: 'Les notifications fonctionnent sur cet appareil.', url: '/#/', tag: 'test' });
    return { ok: true, sent: n, message: n ? 'Notification envoyée : elle doit apparaître dans quelques secondes.' : 'Aucun appareil n\'a pu être prévenu. Réactivez les notifications.' };
  });

  // ----- documents des intervenantes : déposés par elles, vérifiés par le responsable -----
  // Fichiers privés, hors du dossier public, jamais servis à un client. Lisibles par l'intervenante et le responsable seulement.
  const DOCS = dbFile === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-docs-')) : path.join(path.dirname(dbFile), 'documents');
  fs.mkdirSync(DOCS, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS worker_docs (id INTEGER PRIMARY KEY, worker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    file TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'a_verifier' CHECK (status IN ('a_verifier','valide','refuse')),
    note TEXT, uploaded_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_by INTEGER, reviewed_at TEXT)`);
  for (const [c, t] of [['rejected_at', 'TEXT'], ['reject_reason', 'TEXT'], ['docs_expired', 'INTEGER NOT NULL DEFAULT 0']]) if (!db.prepare('PRAGMA table_info(workers)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE workers ADD COLUMN ${c} ${t}`);
  if (!db.prepare('PRAGMA table_info(worker_docs)').all().some((x) => x.name === 'expires_on')) db.exec('ALTER TABLE worker_docs ADD COLUMN expires_on TEXT');
  // pièces qui expirent : titre de séjour, attestation URSSAF (6 mois), assurance
  const EXPIRING_KINDS = new Set(['identite', 'urssaf', 'assurance']);
  const URSSAF_MONTHS = 6;
  const plusMonths = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  const daysUntil = (date) => Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(pricing.todayParis(now()) + 'T12:00:00Z')) / 864e5);
  // Pièces demandées selon le statut. required : nécessaire pour activer l'intervenante.
  const DOC_KINDS = {
    identite: { label: "Pièce d'identité ou titre de séjour en cours de validité", for: ['S', 'I'], required: true },
    secu: { label: 'Attestation de sécurité sociale (ou carte Vitale)', for: ['S'], required: true },
    rib: { label: 'RIB à votre nom', for: ['S', 'I'], required: true },
    siret: { label: 'Avis de situation SIRENE (INSEE) ou extrait Kbis', for: ['I'], required: true },
    urssaf: { label: "Attestation de vigilance URSSAF de moins de 6 mois", for: ['I'], required: true },
    assurance: { label: 'Attestation d\'assurance responsabilité civile professionnelle', for: ['I'], required: true },
    casier: { label: 'Extrait de casier judiciaire (bulletin n° 3)', for: ['S', 'I'], required: false },
  };
  // La liste des pièces se modifie dans l'admin (Équipe › Pièces demandées). DOC_KINDS = liste d'origine.
  const DOC_DEFAULTS = Object.entries(DOC_KINDS).map(([kind, v]) => ({ kind, label: v.label, for: [...v.for], required: v.required }));
  const docList = () => {
    try {
      const saved = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'worker_docs'").get()?.value || 'null');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* liste d'origine */ }
    return DOC_DEFAULTS;
  };
  const docLabel = (kind) => (docList().find((d) => d.kind === kind) || DOC_DEFAULTS.find((d) => d.kind === kind) || { label: kind }).label;
  const kindsFor = (statut) => docList().filter((d) => d.for.includes(statut)).map((d) => ({ kind: d.kind, label: d.label, required: d.required }));
  function docsOf(workerId) {
    const w = db.prepare('SELECT statut FROM workers WHERE user_id = ?').get(workerId);
    if (!w) return null;
    const rows = db.prepare('SELECT id, kind, mime, size, status, note, uploaded_at, reviewed_at, expires_on FROM worker_docs WHERE worker_id = ? ORDER BY id DESC').all(workerId);
    const list = kindsFor(w.statut).map((k) => {
      const valid = rows.find((r) => r.kind === k.kind && r.status === 'valide') || null;
      const left = valid && valid.expires_on ? daysUntil(valid.expires_on) : null;
      return { ...k, expiring: EXPIRING_KINDS.has(k.kind), latest: rows.find((r) => r.kind === k.kind) || null, valid_until: valid ? valid.expires_on : null, days_left: left,
        expired: left !== null && left < 0, soon: left !== null && left >= 0 && left <= 30 };
    });
    const missing = list.filter((k) => k.required && (!k.latest || k.latest.status !== 'valide') && !(k.valid_until && !k.expired)).map((k) => k.label);
    const expired = list.filter((k) => k.required && k.expired && !(k.latest && k.latest.status === 'valide' && k.latest.expires_on && daysUntil(k.latest.expires_on) >= 0)).map((k) => k.label);
    return { list, missing, expired, complete: missing.length === 0 && expired.length === 0 };
  }
  // une pièce obligatoire expirée : plus de nouvelles missions jusqu'à la nouvelle version validée
  function refreshExpiry(workerId) {
    const st = docsOf(workerId);
    if (!st) return;
    db.prepare('UPDATE workers SET docs_expired = ? WHERE user_id = ?').run(st.expired.length ? 1 : 0, workerId);
  }
  function runDocExpiry() {
    let sent = 0;
    for (const w of db.prepare("SELECT w.user_id, u.name, u.email FROM workers w JOIN users u ON u.id = w.user_id WHERE w.rejected_at IS NULL").all()) {
      const st = docsOf(w.user_id);
      if (!st) continue;
      for (const k of st.list.filter((x) => x.valid_until)) {
        const step = k.days_left < 0 ? 0 : k.days_left <= 7 ? 7 : k.days_left <= 30 ? 30 : null;
        if (step === null) continue;
        if (k.latest && k.latest.status === 'a_verifier' && step !== 0) continue; // nouvelle version déjà envoyée
        if (!db.prepare('INSERT OR IGNORE INTO mail_sent (key) VALUES (?)').run(`docexp-${w.user_id}-${k.kind}-${k.valid_until}-${step}`).changes) continue;
        const first = w.name.split(' ')[0];
        const when = step === 0 ? `a expiré le ${fr(k.valid_until)}` : `expire le ${fr(k.valid_until)}, dans ${k.days_left} jour${k.days_left > 1 ? 's' : ''}`;
        mailer.send(w.email, step === 0 ? `Document expiré : ${k.label}` : `Document à renouveler : ${k.label}`, step === 0 ? 'Un document a expiré' : 'Un document arrive à expiration',
          [`Bonjour ${first},`, `Votre document « ${k.label} » ${when}.`, step === 0 && k.required ? 'Vous ne recevez plus de nouvelles missions tant que la nouvelle version n\'est pas validée.' : 'Envoyez la nouvelle version depuis votre espace, rubrique « Mes documents ».'],
          { label: 'Mes documents', path: '/#/intervenante' });
        pushAll(db, w.user_id, { title: step === 0 ? '⚠️ Document expiré' : '📄 Document à renouveler', body: `${k.label} ${when}.`, url: '/#/intervenante', tag: `docexp-${k.kind}` }).catch(() => {});
        for (const to of ownerEmails()) mailer.send(to, `${w.name} : ${k.label} ${step === 0 ? 'expiré' : 'à renouveler'}`, 'Document d\'une intervenante', [`${w.name} : « ${k.label} » ${when}.`, step === 0 && k.required ? 'Elle ne reçoit plus de nouvelles missions. Vérifiez aussi ses missions déjà prévues.' : 'Elle a été prévenue.'], null);
        sent += 1;
      }
      refreshExpiry(w.user_id);
    }
    return sent;
  }
  route('GET', '/api/admin/worker-docs', ({ user }) => {
    need(user, 'admin');
    return { list: docList(), defaults: DOC_DEFAULTS };
  });
  route('POST', '/api/admin/worker-docs', ({ user, body }) => {
    need(user, 'admin');
    const items = Array.isArray(body.list) ? body.list : [];
    if (!items.length || items.length > 20) throw new HttpError(400, 'Entre 1 et 20 pièces.');
    const used = new Set();
    const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'piece';
    const list = items.map((it, i) => {
      const label = str(it && it.label, 140);
      if (label.length < 3) throw new HttpError(400, `Pièce n° ${i + 1} : indiquez son nom.`);
      const forr = ['S', 'I'].filter((x) => Array.isArray(it.for) && it.for.includes(x));
      if (!forr.length) throw new HttpError(400, `« ${label} » : cochez salariée, indépendante ou les deux.`);
      let kind = typeof it.kind === 'string' && /^[a-z0-9_]{2,30}$/.test(it.kind) ? it.kind : slug(label);
      while (used.has(kind)) kind = `${kind.slice(0, 27)}_${used.size}`;
      used.add(kind);
      return { kind, label, for: forr, required: Boolean(it.required) };
    });
    if (!list.some((d) => d.required && d.for.includes('S')) || !list.some((d) => d.required && d.for.includes('I'))) {
      throw new HttpError(400, 'Gardez au moins une pièce obligatoire pour les salariées et une pour les indépendantes (la pièce d\'identité, au minimum).');
    }
    db.prepare("INSERT INTO settings (key, value, updated_by) VALUES ('worker_docs', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by").run(JSON.stringify(list), user.id);
    db_.log(db, `Liste des pièces demandées aux intervenantes modifiée par ${user.name} : ${list.map((d) => `${d.label}${d.required ? '' : ' (facultatif)'} [${d.for.map((x) => (x === 'S' ? 'salariée' : 'indépendante')).join(', ')}]`).join(' ; ')}.`);
    return { ok: true, message: 'Liste des pièces enregistrée. Les pièces déjà validées restent valables.', list };
  });
  route('GET', '/api/worker/documents', ({ user }) => {
    need(user, 'intervenante');
    return docsOf(user.id);
  });
  route('POST', '/api/worker/documents', ({ user, body }) => {
    need(user, 'intervenante');
    const w = db.prepare('SELECT statut, rejected_at FROM workers WHERE user_id = ?').get(user.id);
    if (!w) throw new HttpError(404, 'Profil introuvable.');
    if (w.rejected_at) throw new HttpError(409, 'Votre candidature est close.');
    const kind = String(body.kind || '');
    if (!kindsFor(w.statut).some((d) => d.kind === kind)) throw new HttpError(400, 'Type de document inconnu.');
    const m = /^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw new HttpError(400, 'Envoyez un PDF, une photo JPEG ou PNG.');
    const buf = Buffer.from(m[2], 'base64');
    const sig = buf.subarray(0, 8);
    const mime = sig.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : sig[0] === 0xff && sig[1] === 0xd8 ? 'image/jpeg'
      : sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : null;
    if (!mime) throw new HttpError(400, 'Fichier illisible : envoyez un PDF, une photo JPEG ou PNG.');
    if (buf.length > 5_000_000) throw new HttpError(400, 'Fichier trop lourd (5 Mo maximum).');
    if (db.prepare("SELECT COUNT(*) AS n FROM worker_docs WHERE worker_id = ? AND uploaded_at >= datetime('now', '-1 day')").get(user.id).n >= 30) throw new HttpError(429, 'Trop d\'envois aujourd\'hui. Réessayez demain.');
    const file = `${user.id}-${kind}-${crypto.randomBytes(12).toString('hex')}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(DOCS, file), buf, { mode: 0o600 });
    // Un nouveau dépôt remplace le précédent du même type, s'il n'était pas encore validé.
    for (const old of db.prepare("SELECT id, file FROM worker_docs WHERE worker_id = ? AND kind = ? AND status <> 'valide'").all(user.id, kind)) {
      try { fs.unlinkSync(path.join(DOCS, path.basename(old.file))); } catch { /* déjà supprimé */ }
      db.prepare('DELETE FROM worker_docs WHERE id = ?').run(old.id);
    }
    let expires = pricing.isValidDate(String(body.expires_on || '')) ? String(body.expires_on) : null;
    if (expires && daysUntil(expires) < 0) throw new HttpError(400, 'Ce document est déjà expiré : envoyez la version à jour.');
    if (!expires && kind === 'urssaf') expires = plusMonths(pricing.todayParis(now()), URSSAF_MONTHS);
    db.prepare('INSERT INTO worker_docs (worker_id, kind, file, mime, size, expires_on) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, kind, file, mime, buf.length, expires);
    db_.log(db, `${user.name} a déposé : ${docLabel(kind)}. À vérifier.`);
    return { ok: true, message: 'Document reçu. L\'équipe le vérifie rapidement.', ...docsOf(user.id) };
  });
  route('GET', '/api/documents/:id', ({ user, id, res }) => {
    const d = db.prepare('SELECT * FROM worker_docs WHERE id = ?').get(id);
    if (!d || !user || !(d.worker_id === user.id || isOwner(user))) throw new HttpError(404, 'Document introuvable.');
    const f = path.join(DOCS, path.basename(d.file));
    if (!fs.existsSync(f)) throw new HttpError(404, 'Fichier introuvable.');
    if (isOwner(user) && d.worker_id !== user.id) db_.log(db, `Document n° ${d.id} (${docLabel(d.kind)}) consulté par ${user.name}.`);
    res.writeHead(200, { 'Content-Type': d.mime, 'Content-Disposition': `inline; filename="document-${d.id}.${d.mime === 'application/pdf' ? 'pdf' : d.mime === 'image/png' ? 'png' : 'jpg'}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    fs.createReadStream(f).pipe(res);
    return { streamed: true };
  });
  route('POST', '/api/admin/documents/:id/review', ({ user, id, body }) => {
    need(user, 'admin');
    const d = db.prepare('SELECT * FROM worker_docs WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'Document introuvable.');
    const decision = body.decision === 'valide' ? 'valide' : body.decision === 'refuse' ? 'refuse' : null;
    if (!decision) throw new HttpError(400, 'Choisissez : valider ou refuser.');
    const note = str(body.note, 300);
    if (decision === 'refuse' && note.length < 5) throw new HttpError(400, 'Indiquez la raison du refus : l\'intervenante la recevra (ex. « photo floue », « attestation de plus de 6 mois »).');
    db.prepare("UPDATE worker_docs SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(decision, note || null, user.id, id);
    if (pricing.isValidDate(String(body.expires_on || ''))) db.prepare('UPDATE worker_docs SET expires_on = ? WHERE id = ?').run(String(body.expires_on), id);
    // une nouvelle version validée remplace l'ancienne pièce validée du même type
    if (decision === 'valide') for (const old of db.prepare("SELECT id, file FROM worker_docs WHERE worker_id = ? AND kind = ? AND status = 'valide' AND id <> ?").all(d.worker_id, d.kind, id)) {
      try { fs.unlinkSync(path.join(DOCS, path.basename(old.file))); } catch { /* déjà supprimé */ }
      db.prepare('DELETE FROM worker_docs WHERE id = ?').run(old.id);
    }
    refreshExpiry(d.worker_id);
    const w = workerProfile(d.worker_id);
    const label = docLabel(d.kind);
    db_.log(db, `Document de ${w.name} (${label}) ${decision === 'valide' ? 'validé' : `refusé : ${note}`} par ${user.name}.`);
    if (decision === 'refuse') mailer.send(w.email, 'Un document est à renvoyer', 'Un document est à renvoyer', [
      `Bonjour ${w.name.split(' ')[0]},`, `Nous n'avons pas pu valider : ${label}.`, `Raison : ${note}`, 'Déposez une nouvelle version depuis votre espace, rubrique « Mes documents ».',
    ], { label: 'Mes documents', path: '/#/intervenante' });
    const st = docsOf(d.worker_id);
    if (decision === 'valide' && st.complete) db_.log(db, `${w.name} : toutes les pièces obligatoires sont validées.`);
    return { ok: true, message: decision === 'valide' ? 'Document validé.' : 'Document refusé : l\'intervenante est prévenue par e-mail.', ...st };
  });
  // Refuser une candidature (pas une intervenante déjà active : pour elle, « Marquer absente »).
  route('POST', '/api/admin/workers/:id/reject', ({ user, id, body }) => {
    need(user, 'admin');
    const w = workerProfile(id);
    if (!w) throw new HttpError(404, 'Intervenante introuvable.');
    if (engine.isActive(w)) throw new HttpError(409, 'Elle est déjà active : marquez-la absente plutôt que de refuser la candidature.');
    if (w.rejected_at) throw new HttpError(409, 'Candidature déjà refusée.');
    const reason = str(body.reason, 300);
    if (reason.length < 5) throw new HttpError(400, 'Indiquez la raison (elle reste interne, le message envoyé à la candidate est neutre).');
    db.prepare("UPDATE workers SET rejected_at = datetime('now'), reject_reason = ?, absent = 1 WHERE user_id = ?").run(reason, id);
    db.prepare("DELETE FROM offers WHERE worker_id = ? AND state = 'offered'").run(id);
    db_.log(db, `Candidature de ${w.name} refusée par ${user.name} : ${reason}. Documents supprimés dans 30 jours.`);
    mailer.send(w.email, 'Votre candidature Proprigo', 'Votre candidature', [
      `Bonjour ${w.name.split(' ')[0]},`, 'Merci pour l\'intérêt que vous portez à Proprigo. Après étude, nous ne donnons pas suite à votre candidature pour le moment.',
      'Vos documents seront supprimés dans 30 jours. Vous pouvez nous écrire si vous avez une question.',
    ], null);
    return { ok: true, message: `Candidature de ${w.name} refusée. Elle est prévenue par e-mail.` };
  });
  // RGPD : documents d'une candidature refusée supprimés 30 jours après le refus.
  const purgeRejectedDocs = () => {
    let n = 0;
    for (const d of db.prepare("SELECT d.id, d.file FROM worker_docs d JOIN workers w ON w.user_id = d.worker_id WHERE w.rejected_at IS NOT NULL AND w.rejected_at < datetime('now', '-30 days')").all()) {
      try { fs.unlinkSync(path.join(DOCS, path.basename(d.file))); } catch { /* déjà supprimé */ }
      db.prepare('DELETE FROM worker_docs WHERE id = ?').run(d.id);
      n += 1;
    }
    if (n) db_.log(db, `Documents de candidatures refusées supprimés : ${n}.`);
    return n;
  };
  purgeRejectedDocs();

  route('GET', '/api/photos/:id', ({ user, id, res }) => {
    const ph = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    const b = ph && db.prepare('SELECT * FROM bookings WHERE id = ?').get(ph.booking_id);
    if (!b || !canSee(user, b)) throw new HttpError(404, 'Photo introuvable.');
    res.writeHead(200, { 'Content-Type': ph.file.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, no-store' });
    fs.createReadStream(path.join(PHOTOS, ph.file)).pipe(res);
    return { streamed: true };
  });

  // ----- signaler un problème -----
  route('POST', '/api/bookings/:id/report', ({ user, id, body }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b || !['en_cours', 'terminee'].includes(b.status)) throw new HttpError(409, 'Signalement possible pendant ou après le ménage.');
    const text = str(body.text, 1000);
    if (text.length < 5) throw new HttpError(400, 'Décrivez le problème en quelques mots.');
    db.prepare('INSERT INTO incidents (booking_id, text) VALUES (?, ?)').run(id, text);
    db_.log(db, `Réservation n° ${id} : problème signalé par le client. À traiter.`);
    return { ok: true, message: 'Merci, notre équipe qualité vous recontacte rapidement.' };
  });

  // ----- messagerie de la réservation (sans numéros ni e-mails personnels) -----
  const mask = (t) => t
    .replace(/(?:\+33|0033|0)\s*[1-9](?:[\s.-]*\d{2}){4}/g, '[numéro masqué]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[e-mail masqué]');
  route('GET', '/api/bookings/:id/messages', ({ user, id }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !canSee(user, b)) throw new HttpError(404, 'Réservation introuvable.');
    return db.prepare(`SELECT m.id, m.text, m.created_at, u.name, u.role, m.sender_id = ? AS mine FROM messages m
      JOIN users u ON u.id = m.sender_id WHERE m.booking_id = ? ORDER BY m.id`).all(user.id, id)
      .map((m) => ({ ...m, name: m.role === 'admin' ? 'Équipe Proprigo' : m.role === 'client' ? 'Client' : m.name.split(' ')[0] }));
  });
  route('POST', '/api/bookings/:id/messages', ({ user, id, body }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !canSee(user, b)) throw new HttpError(404, 'Réservation introuvable.');
    const text = mask(str(body.text, 1000));
    if (!text) throw new HttpError(400, 'Message vide.');
    db.prepare('INSERT INTO messages (booking_id, sender_id, text) VALUES (?, ?, ?)').run(id, user.id, text);
    return { ok: true };
  });

  // ----- reçu imprimable -----
  // ----- contestations bancaires (litiges Stripe) -----
  // Le client conteste un paiement auprès de sa banque : Stripe retire la somme et ouvre un litige.
  // On a une date limite pour répondre (dans le tableau de bord Stripe) avec des preuves.
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_disputes (id INTEGER PRIMARY KEY, dispute_id TEXT NOT NULL UNIQUE, payment_intent TEXT, charge TEXT,
    amount_cents INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL, due_by INTEGER, booking_ids TEXT NOT NULL DEFAULT '[]', client_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const DISPUTE_REASON = { fraudulent: 'paiement non reconnu (fraude)', duplicate: 'paiement en double', product_not_received: 'prestation non reçue',
    product_unacceptable: 'prestation jugée insatisfaisante', subscription_canceled: 'abonnement annulé', unrecognized: 'paiement non reconnu',
    credit_not_processed: 'remboursement non reçu', general: 'autre motif', customer_initiated: 'demande du client' };
  const DISPUTE_STATUS = { warning_needs_response: 'à traiter (alerte)', needs_response: 'réponse à envoyer', under_review: 'en cours d\'examen par la banque',
    warning_under_review: 'en cours d\'examen', won: 'gagné', lost: 'perdu', warning_closed: 'clos', charge_refunded: 'remboursé' };
  const bookingsOfIntent = (pi) => {
    if (!pi) return [];
    const ids = new Set(db.prepare('SELECT booking_id FROM stripe_claims WHERE payment_intent = ?').all(pi).map((r) => r.booking_id));
    for (const p2 of db.prepare('SELECT booking_ids FROM stripe_payments WHERE payment_intent = ?').all(pi)) for (const id of JSON.parse(p2.booking_ids)) ids.add(id);
    return [...ids].sort((a, b) => a - b);
  };
  function onDispute(type, dp) {
    if (!dp || typeof dp.id !== 'string' || !/^d[up]_[A-Za-z0-9]+$/.test(dp.id)) return;
    const pi = typeof dp.payment_intent === 'string' ? dp.payment_intent : dp.payment_intent?.id || null;
    const ids = bookingsOfIntent(pi);
    const clientId = ids.length ? db.prepare('SELECT client_id FROM bookings WHERE id = ?').get(ids[0])?.client_id || null : null;
    const due = Number(dp.evidence_details?.due_by) || null;
    const amount = Number.isSafeInteger(dp.amount) ? dp.amount : 0;
    const known = db.prepare('SELECT * FROM stripe_disputes WHERE dispute_id = ?').get(dp.id);
    if (!known) {
      db.prepare('INSERT INTO stripe_disputes (dispute_id, payment_intent, charge, amount_cents, reason, status, due_by, booking_ids, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(dp.id, pi, typeof dp.charge === 'string' ? dp.charge : null, amount, String(dp.reason || 'general'), String(dp.status || 'needs_response'), due, JSON.stringify(ids), clientId);
    } else {
      db.prepare("UPDATE stripe_disputes SET status = ?, due_by = COALESCE(?, due_by), amount_cents = ?, updated_at = datetime('now') WHERE dispute_id = ?").run(String(dp.status || known.status), due, amount || known.amount_cents, dp.id);
    }
    const row = db.prepare('SELECT * FROM stripe_disputes WHERE dispute_id = ?').get(dp.id);
    const money = `${(row.amount_cents / 100).toFixed(2).replace('.', ',')} €`;
    const dueTxt = row.due_by ? new Date(row.due_by * 1000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }) : null;
    const what = ids.length ? `réservation(s) n° ${ids.join(', ')}` : 'paiement sans réservation retrouvée';
    if (!known) {
      db_.log(db, `ALERTE CONTESTATION : ${money} contestés par la banque du client (${DISPUTE_REASON[row.reason] || row.reason}), ${what}.${dueTxt ? ` Réponse avant le ${dueTxt}.` : ''}`);
      for (const id of ids) db.prepare("INSERT INTO incidents (booking_id, text, source) VALUES (?, ?, 'litige')").run(id, `Contestation bancaire de ${money} : ${DISPUTE_REASON[row.reason] || row.reason}.`);
      for (const to of ownerEmails()) mailer.send(to, `Contestation bancaire : ${money}${dueTxt ? `, réponse avant le ${dueTxt}` : ''}`, 'Un paiement est contesté', [
        `La banque du client conteste ${money} (${DISPUTE_REASON[row.reason] || row.reason}) : ${what}.`,
        'Stripe a retiré la somme de votre solde en attendant la décision de la banque, avec des frais de litige.',
        `${dueTxt ? `Vous avez jusqu'au ${dueTxt} pour répondre` : 'Répondez rapidement'} dans le tableau de bord Stripe, avec le dossier de preuve préparé dans l'admin (Paiements › Contestations).`,
      ], { label: 'Voir la contestation', path: '/#/admin?tab=paiements' }, { key: `dispute-new-${dp.id}` });
    }
    if (type === 'charge.dispute.closed' && ['won', 'lost', 'warning_closed', 'charge_refunded'].includes(row.status)) {
      db_.log(db, `Contestation ${what} close : ${DISPUTE_STATUS[row.status] || row.status} (${money}).`);
      for (const to of ownerEmails()) mailer.send(to, `Contestation ${row.status === 'won' ? 'gagnée' : row.status === 'lost' ? 'perdue' : 'close'} : ${money}`,
        row.status === 'won' ? 'Contestation gagnée' : row.status === 'lost' ? 'Contestation perdue' : 'Contestation close', [
          row.status === 'won' ? `La banque vous a donné raison : ${money} sont reversés sur votre solde Stripe.` : row.status === 'lost' ? `La banque a donné raison au client : ${money} ne vous seront pas reversés.` : `La contestation de ${money} est close.`,
          `Concerne : ${what}.`,
        ], { label: 'Ouvrir l\'admin', path: '/#/admin?tab=paiements' }, { key: `dispute-closed-${dp.id}` });
    }
  }

  // ----- tous les paiements et remboursements (pour vous et pour le comptable) -----
  const monthOk = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
  function movements(month) {
    const [y, mo] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, mo - 1, 1) - 2 * 3600e3).toISOString(); // marge fuseau Paris
    const to = new Date(Date.UTC(y, mo, 1) + 2 * 3600e3).toISOString();
    const inMonth = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date(iso)).slice(0, 7) === month;
    const name = (cid) => { const u = db.prepare('SELECT name, company FROM users WHERE id = ?').get(cid); return u ? (u.company ? `${u.company} (${u.name})` : u.name) : '?'; };
    const piOf = (bid) => db.prepare('SELECT payment_intent FROM stripe_claims WHERE booking_id = ?').get(bid)?.payment_intent || null;
    const rows = [];
    for (const i of db.prepare('SELECT * FROM invoices WHERE issued_at >= ? AND issued_at < ? ORDER BY issued_at, id').all(from, to)) {
      if (!inMonth(i.issued_at)) continue;
      const b = db.prepare('SELECT discount, total, service FROM bookings WHERE id = ?').get(i.booking_id) || {};
      const credit = i.kind === 'facture' ? Math.round((b.discount || 0) * 100) : 0;
      rows.push({ at: i.issued_at, type: i.kind === 'facture' ? 'Paiement' : 'Remboursement', client: name(i.client_id), booking: i.booking_id,
        amount_cents: i.kind === 'facture' ? i.amount_cents : -i.amount_cents, card_cents: i.kind === 'facture' ? i.amount_cents - credit : -i.amount_cents, credit_cents: credit,
        tva_rate: i.tva_rate, ref: i.number, stripe: piOf(i.booking_id), status: i.kind === 'facture' ? 'encaissé' : 'remboursé' });
    }
    for (const d of db.prepare('SELECT * FROM stripe_duplicate_refunds WHERE created_at >= ? AND created_at < ?').all(from.slice(0, 19).replace('T', ' '), to.slice(0, 19).replace('T', ' '))) {
      rows.push({ at: d.created_at.replace(' ', 'T') + 'Z', type: d.status === 'annule' ? 'Doublon bloqué' : 'Doublon remboursé', client: d.client_id ? name(d.client_id) : '?', booking: JSON.parse(d.booking_ids)[0] || null,
        amount_cents: 0, card_cents: 0, credit_cents: 0, tva_rate: null, ref: null, stripe: d.payment_intent,
        status: d.status === 'annule' ? `${(d.amount_cents / 100).toFixed(2).replace('.', ',')} € non encaissés` : `${(d.amount_cents / 100).toFixed(2).replace('.', ',')} € rendus` });
    }
    for (const d of db.prepare('SELECT * FROM stripe_disputes WHERE created_at >= ? AND created_at < ?').all(from.slice(0, 19).replace('T', ' '), to.slice(0, 19).replace('T', ' '))) {
      rows.push({ at: d.created_at.replace(' ', 'T') + 'Z', type: 'Contestation', client: d.client_id ? name(d.client_id) : '?', booking: JSON.parse(d.booking_ids)[0] || null,
        amount_cents: 0, card_cents: 0, credit_cents: 0, tva_rate: null, ref: null, stripe: d.payment_intent, status: `${(d.amount_cents / 100).toFixed(2).replace('.', ',')} € · ${DISPUTE_STATUS[d.status] || d.status}` });
    }
    rows.sort((a, b) => a.at.localeCompare(b.at));
    const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
    const encaisse = sum((r) => (r.type === 'Paiement' ? r.card_cents : 0));
    const credit = sum((r) => (r.type === 'Paiement' ? r.credit_cents : 0));
    const rembourse = -sum((r) => (r.type === 'Remboursement' ? r.amount_cents : 0));
    const tvaNet = sum((r) => (r.tva_rate ? r.amount_cents - r.amount_cents / (1 + r.tva_rate) : 0));
    return { month, rows, totals: { encaisse, credit, rembourse, net: encaisse - rembourse, chiffreTTC: sum((r) => (r.tva_rate ? r.amount_cents : 0)), tva: Math.round(tvaNet) } };
  }
  // ----- statistiques par mois (heure de Paris) -----
  route('GET', '/api/admin/stats', ({ user, query }) => {
    need(user, 'admin');
    const n = Math.min(24, Math.max(3, Number(query.get('months')) || 12));
    const ym = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
    const cur = ym(now());
    const months = [];
    { let [y, m] = cur.split('-').map(Number); for (let i = 0; i < n; i++) { months.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (!m) { m = 12; y -= 1; } } }
    const blank = () => ({ caTTC: 0, rembourse: 0, netHT: 0, factures: 0, prestations: 0, heures: 0, annulees: 0, reservations: 0, nouveauxClients: 0, clientsActifs: new Set() });
    const by = Object.fromEntries(months.map((m) => [m, blank()]));
    const hasInvoices = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n > 0;
    const theoretical = !hasInvoices && !stripeReady;
    const services = {};
    if (!theoretical) {
      for (const i of db.prepare('SELECT i.*, b.service FROM invoices i JOIN bookings b ON b.id = i.booking_id').all()) {
        const m = by[ym(new Date(i.issued_at))];
        if (!m) continue;
        const ht = i.amount_cents / (1 + i.tva_rate);
        if (i.kind === 'facture') { m.caTTC += i.amount_cents; m.netHT += ht; m.factures += 1; services[i.service] = (services[i.service] || 0) + i.amount_cents; }
        else { m.rembourse += i.amount_cents; m.netHT -= ht; services[i.service] = (services[i.service] || 0) - i.amount_cents; }
      }
    }
    for (const b of db.prepare("SELECT * FROM bookings WHERE NOT (status = 'annulee' AND paid = 0 AND payment_status IN ('paiement_echoue', 'en_attente_paiement'))").all()) {
      const m = by[b.date.slice(0, 7)];
      if (!m) continue;
      m.reservations += 1;
      if (b.status === 'annulee') m.annulees += 1;
      else m.clientsActifs.add(b.client_id);
      if (b.status === 'terminee') {
        m.prestations += 1; m.heures += b.hours;
        if (theoretical) {
          const cents = Math.round(b.total * 100);
          m.caTTC += cents; m.factures += 1; m.netHT += cents / (1 + tvaOf(b)); services[b.service] = (services[b.service] || 0) + cents;
        }
      }
    }
    for (const u of db.prepare("SELECT created_at FROM users WHERE role = 'client'").all()) {
      const m = by[ym(new Date(u.created_at.replace(' ', 'T') + 'Z'))];
      if (m) m.nouveauxClients += 1;
    }
    const rows = months.map((m) => {
      const x = by[m];
      return { month: m, caTTC: x.caTTC, rembourse: x.rembourse, netTTC: x.caTTC - x.rembourse, netHT: Math.round(x.netHT), panierMoyen: x.factures ? Math.round(x.caTTC / x.factures) : null,
        prestations: x.prestations, heures: x.heures, reservations: x.reservations, annulees: x.annulees,
        tauxAnnulation: x.reservations ? Math.round((x.annulees / x.reservations) * 1000) / 10 : null, nouveauxClients: x.nouveauxClients, clientsActifs: x.clientsActifs.size };
    });
    const total = rows.reduce((t, r) => ({ netTTC: t.netTTC + r.netTTC, netHT: t.netHT + r.netHT, prestations: t.prestations + r.prestations, reservations: t.reservations + r.reservations, annulees: t.annulees + r.annulees }),
      { netTTC: 0, netHT: 0, prestations: 0, reservations: 0, annulees: 0 });
    total.tauxAnnulation = total.reservations ? Math.round((total.annulees / total.reservations) * 1000) / 10 : null;
    return { theoretical, rows, total, services: Object.entries(services).map(([k, v]) => ({ service: k, label: SERVICE_NAME[k] || k, cents: v })).sort((a, b) => b.cents - a.cents) };
  });

  route('GET', '/api/admin/payments', ({ user, query }) => {
    need(user, 'admin');
    const month = monthOk(query.get('month')) ? query.get('month') : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(now()).slice(0, 7);
    const disputes = db.prepare("SELECT * FROM stripe_disputes ORDER BY CASE WHEN status IN ('needs_response','warning_needs_response') THEN 0 ELSE 1 END, created_at DESC LIMIT 30").all()
      .map((d) => ({ id: d.id, dispute_id: d.dispute_id, amount_cents: d.amount_cents, reason: DISPUTE_REASON[d.reason] || d.reason, status: d.status, statusLabel: DISPUTE_STATUS[d.status] || d.status,
        open: ['needs_response', 'warning_needs_response'].includes(d.status), due_by: d.due_by ? new Date(d.due_by * 1000).toISOString() : null,
        bookings: JSON.parse(d.booking_ids), client: d.client_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(d.client_id)?.name : null,
        stripeUrl: `https://dashboard.stripe.com/${String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? 'test/' : ''}disputes/${d.dispute_id}` }));
    return { ...movements(month), disputes };
  });
  route('GET', '/api/admin/payments.csv', ({ user, query, res }) => {
    need(user, 'admin');
    if (!monthOk(query.get('month'))) throw new HttpError(400, 'Mois invalide (AAAA-MM).');
    const m = movements(query.get('month'));
    const cell = (v) => { const t = String(v ?? ''); if (/^-?\d+(,\d+)?$/.test(t)) return t; return /[;"\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; }; // un nombre (même négatif) reste un nombre ; un texte qui commence par = + - @ est neutralisé
    const eurx = (c) => (c / 100).toFixed(2).replace('.', ',');
    const lines = [['Date', 'Type', 'Pièce', 'Client', 'Réservation', 'Montant TTC', 'Dont carte', 'Dont crédit Proprigo', 'Taux TVA', 'Statut', 'Référence Stripe'].join(';')];
    for (const r of m.rows) lines.push([new Date(r.at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), r.type, r.ref, r.client, r.booking, eurx(r.amount_cents), eurx(r.card_cents), eurx(r.credit_cents),
      r.tva_rate === null ? '' : `${Math.round(r.tva_rate * 1000) / 10} %`, r.status, r.stripe].map(cell).join(';'));
    db_.log(db, `Export des paiements de ${m.month} par ${user.name}.`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="proprigo-paiements-${m.month}.csv"`, 'Cache-Control': 'no-store' });
    res.end('﻿' + lines.join('\r\n'));
    return { streamed: true };
  });
  // Dossier de preuve d'une contestation : tout ce qui montre que la prestation a eu lieu.
  route('GET', '/api/admin/disputes/:id/evidence', ({ user, id, res }) => {
    need(user, 'admin');
    const d = db.prepare('SELECT * FROM stripe_disputes WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'Contestation introuvable.');
    const e = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const when = (iso) => (iso ? new Date(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '—');
    const parts = JSON.parse(d.booking_ids).map((bid) => {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bid);
      if (!b) return '';
      const c = db.prepare('SELECT name, email, phone, created_at FROM users WHERE id = ?').get(b.client_id) || {};
      const w = b.worker_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(b.worker_id) : null;
      const inv = db.prepare("SELECT number, issued_at, amount_cents FROM invoices WHERE kind = 'facture' AND booking_id = ?").get(bid);
      let list = []; try { list = JSON.parse(b.checklist || '[]'); } catch { list = []; }
      const photos = db.prepare('SELECT kind, COUNT(*) AS n FROM photos WHERE booking_id = ? GROUP BY kind').all(bid);
      const msgs = db.prepare('SELECT m.text, m.created_at, u.role FROM messages m JOIN users u ON u.id = m.sender_id WHERE booking_id = ? ORDER BY m.id').all(bid);
      const log = db.prepare("SELECT at, text FROM events WHERE text LIKE ? ORDER BY id").all(`%n° ${bid}%`);
      return `<h2>Réservation n° ${b.id}</h2>
<table><tr><th>Prestation</th><td>${e(SERVICE_NAME[b.service] || b.service)} ${String(b.hours).replace('.', ',')} h, le ${e(fr(b.date))} à ${e(b.time)}</td></tr>
<tr><th>Adresse</th><td>${e(b.address)}, ${e(b.cp)}</td></tr>
<tr><th>Client</th><td>${e(c.name)} · ${e(c.email)}${c.phone ? ` · ${e(c.phone)}` : ''} · compte créé le ${e(when(c.created_at))}</td></tr>
<tr><th>Réservation passée le</th><td>${e(when(b.created_at))}, conditions générales de vente acceptées à la réservation</td></tr>
<tr><th>Paiement</th><td>${inv ? `${(inv.amount_cents / 100).toFixed(2).replace('.', ',')} € TTC, facture ${e(inv.number)} du ${e(when(inv.issued_at))}` : 'aucune facture'}</td></tr>
<tr><th>Intervenante</th><td>${w ? e(w.name) : 'non attribuée'}</td></tr>
<tr><th>En route / arrivée</th><td>${e(when(b.on_way_at))} / ${e(when(b.arrived_at))}</td></tr>
<tr><th>Statut</th><td>${e(b.status)}${b.rating ? ` · note du client ${b.rating}/5${b.review ? ` : « ${e(b.review)} »` : ''}` : ''}</td></tr>
<tr><th>Liste des tâches</th><td>${list.length ? `${list.filter((t) => t.done).length}/${list.length} cochées : ${list.map((t) => `${t.done ? '✓' : '✗'} ${e(t.task)}`).join(' · ')}` : '—'}</td></tr>
<tr><th>Photos</th><td>${photos.length ? photos.map((p2) => `${p2.n} ${p2.kind === 'avant' ? 'avant' : 'après'}`).join(', ') : 'aucune'} (consultables dans l'admin)</td></tr></table>
${msgs.length ? `<h3>Messages</h3><ul>${msgs.map((m2) => `<li>${e(when(m2.created_at))} · ${m2.role === 'client' ? 'client' : m2.role === 'admin' ? 'équipe' : 'intervenante'} : ${e(m2.text)}</li>`).join('')}</ul>` : ''}
${log.length ? `<h3>Historique</h3><ul>${log.map((l) => `<li>${e(when(l.at))} · ${e(l.text)}</li>`).join('')}</ul>` : ''}`;
    }).join('');
    db_.log(db, `Dossier de preuve de la contestation ${d.dispute_id} ouvert par ${user.name}.`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dossier de preuve ${e(d.dispute_id)}</title>
<style>body{font:15px/1.5 Arial,sans-serif;color:#0f1430;max-width:820px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #dce3f7}th{width:190px;color:#596181;font-weight:600}.muted{color:#596181}@media print{.noprint{display:none}}</style></head><body>
<h1>Dossier de preuve</h1><p class="muted">Contestation ${e(d.dispute_id)} · ${(d.amount_cents / 100).toFixed(2).replace('.', ',')} € · motif : ${e(DISPUTE_REASON[d.reason] || d.reason)} · ${e(DISPUTE_STATUS[d.status] || d.status)}${d.due_by ? ` · réponse avant le ${e(new Date(d.due_by * 1000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }))}` : ''}</p>
<p class="noprint muted">Enregistrez cette page en PDF (Ctrl + P) et joignez-la à votre réponse dans Stripe, avec la facture et, si possible, les photos après le ménage. Ajoutez une phrase simple : la prestation a eu lieu, à telle date, et le client l'a acceptée.</p>
${parts || '<p>Aucune réservation retrouvée pour ce paiement : vérifiez dans Stripe.</p>'}
</body></html>`);
    return { streamed: true };
  });

  // Rendu d'une facture ou d'un avoir (page seule, ou impression groupée pour le comptable).
  const INVOICE_CSS = `body{font:15px/1.5 Arial,sans-serif;color:#0f1430;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:24px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px;border-bottom:1px solid #dce3f7;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}.muted{color:#596181;font-size:13px}.todo{background:#fff1c2}.test{background:#fff1c2;padding:10px;border-radius:8px;font-weight:700}.box{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-top:12px}tfoot td{font-weight:700}@media print{.noprint{display:none}}`;
  function invoiceBody(doc, b, { isTest = false, avoirs = [], forPrint = false } = {}) {
    const c = db.prepare('SELECT name, email, company, siret, vat_number, billing_address FROM users WHERE id = ?').get(b.client_id);
    const e = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const eur = (cents) => (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const day = (iso) => new Date(iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
    const todo = (k, label) => (String(company[k] || '').trim() ? e(company[k]) : `<span class="todo">[${label} à compléter]</span>`);
    const isPro = pricing.PRO_SERVICES.includes(b.service) || Boolean(c.company);
    const label = b.service === 'airbnb' ? `Ménage Airbnb ${pricing.SIZE_LABEL[b.size] || ''} (ménage + linge)` : `${SERVICE_NAME[b.service] || 'Ménage'} ${String(b.hours).replace('.', ',')} h`;
    const ttc = doc.amount_cents;
    const ht = Math.round(ttc / (1 + doc.tva_rate));
    const isAvoir = doc.kind === 'avoir';
    const title = isAvoir ? `Avoir ${doc.number}` : `Facture ${doc.number}`;
    const credit = Math.round((b.discount || 0) * 100);
    const noTva = Number(doc.tva_rate) === 0;
    const table = noTva
      ? `<table><thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">Prix unitaire</th><th class="n">Total</th></tr></thead>
<tbody><tr><td>${isAvoir ? 'Remboursement : ' : ''}${e(label)}<br><span class="muted">Prestation du ${e(fr(b.date))} à ${e(b.time)}</span></td><td class="n">1</td><td class="n">${eur(ttc)}</td><td class="n">${eur(ttc)}</td></tr></tbody>
<tfoot><tr><td colspan="3">${isAvoir ? 'Total remboursé' : 'Total à payer'}</td><td class="n">${eur(ttc)}</td></tr></tfoot></table>
<p><b>TVA non applicable, art. 293 B du CGI.</b></p>`
      : `<table><thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">Prix HT</th><th class="n">TVA</th><th class="n">Total TTC</th></tr></thead>
<tbody><tr><td>${isAvoir ? 'Remboursement : ' : ''}${e(label)}<br><span class="muted">Prestation du ${e(fr(b.date))} à ${e(b.time)}</span></td><td class="n">1</td><td class="n">${eur(ht)}</td><td class="n">${Math.round(doc.tva_rate * 1000) / 10} %</td><td class="n">${eur(ttc)}</td></tr></tbody>
<tfoot><tr><td colspan="4">Total HT</td><td class="n">${eur(ht)}</td></tr><tr><td colspan="4">TVA ${Math.round(doc.tva_rate * 1000) / 10} %</td><td class="n">${eur(ttc - ht)}</td></tr><tr><td colspan="4">${isAvoir ? 'Total remboursé TTC' : 'Total TTC'}</td><td class="n">${eur(ttc)}</td></tr></tfoot></table>`;
    const body = `${isTest ? '<p class="test">DOCUMENT DE TEST : paiement simulé, aucune somme encaissée. Aucune valeur comptable.</p>' : ''}
<div class="box"><div><h1>${e(title)}</h1><p class="muted">Date d'émission : ${e(day(doc.issued_at))}${isAvoir ? `<br>Avoir sur la facture ${e(doc.ref_invoice)}` : ''}</p></div>
<div><b>${e(company.nomCommercial || 'Proprigo')}</b><br>${todo('raisonSociale', 'raison sociale')}${company.formeJuridique ? `, ${e(company.formeJuridique)}` : ''}${company.capital ? ` au capital de ${e(company.capital)}` : ''}<br>${todo('adresse', 'adresse du siège')}<br>SIRET : ${todo('siret', 'SIRET')}${company.rcs ? `<br>RCS ${e(company.rcs)}` : ''}${noTva ? '' : `<br>TVA intracommunautaire : ${todo('tvaIntracom', 'n° de TVA')}`}</div></div>
<div class="box"><div><b>${isPro ? 'Facturé à' : 'Client'}</b><br>${c.company ? `${e(c.company)}<br>` : ''}${e(c.name)}<br>${c.billing_address ? e(c.billing_address) : `${e(b.address)}, ${e(b.cp)}`}${c.siret ? `<br>SIRET : ${e(c.siret)}` : ''}${c.vat_number ? `<br>TVA intracommunautaire : ${e(c.vat_number)}` : ''}</div>
<div><b>Lieu de la prestation</b><br>${e(b.address)}, ${e(b.cp)}<br>Réservation n° ${b.id}</div></div>
${table}
${isAvoir ? `<p>Remboursé sur le moyen de paiement d'origine.</p>`
    : ['virement_facture', 'paye_virement'].includes(b.payment_status) ? (() => {
      const bill = b.bill_id ? db.prepare('SELECT * FROM transfer_bills WHERE id = ?').get(b.bill_id) : null;
      return bill && bill.paid_at ? `<p>Facture acquittée par virement le ${e(day(bill.paid_at))}.</p>`
        : `<p>Paiement par virement à réception, au plus tard le ${bill ? e(day(bill.due_date + 'T12:00:00Z')) : '30 jours après la facture'}${bill ? `, référence <b>${e(bill.ref)}</b>` : ''}.${company.iban ? ` IBAN : ${e(company.iban)}${company.bic ? ` · BIC : ${e(company.bic)}` : ''}.` : ''}</p>`;
    })()
    : `<p>Facture acquittée${isTest ? '' : ` le ${e(day(doc.issued_at))}`} : ${credit > 0 ? `${eur(ttc - credit)} par carte bancaire et ${eur(credit)} avec le crédit Proprigo (parrainage, carte cadeau ou pack).` : 'réglée par carte bancaire.'}</p>`}
${isPro ? "<p class=\"muted\">Prestation à un professionnel. Escompte pour paiement anticipé : néant. En cas de retard de paiement : pénalités au taux de 3 fois le taux d'intérêt légal et indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 du Code de commerce).</p>"
    : sapOn() && SAP_SERVICES.includes(b.service) ? `<p class="muted">Prestation de services à la personne (déclaration n° ${e(sapSettings().numero)}), ouvrant droit au crédit d'impôt de l'article 199 sexdecies du Code général des impôts, dans les conditions en vigueur. L'attestation fiscale annuelle est disponible dans votre espace.</p>`
    : "<p class=\"muted\">Service à la personne : l'attestation fiscale annuelle pour le crédit d'impôt sera disponible dès la déclaration de l'entreprise (à confirmer par l'expert-comptable).</p>"}
${!isAvoir && avoirs.length ? `<p class="noprint"><b>Avoirs liés :</b> ${avoirs.map((a) => `<a href="?doc=${encodeURIComponent(a.number)}">${e(a.number)}</a> (${eur(a.amount_cents)})`).join(', ')}</p>` : ''}
${isAvoir ? `<p class="noprint"><a href="?">Voir la facture ${e(doc.ref_invoice)}</a></p>` : ''}
<p class="noprint muted">Pour l'enregistrer en PDF : Ctrl + P sur ordinateur, ou Partager › Imprimer sur téléphone.</p>
`;
    return { title, body: forPrint ? body.replace(/<p class="noprint[\s\S]*?<\/p>\n?/g, '') : body };
  }

  route('GET', '/api/bookings/:id/receipt', ({ user, id, res, query }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !user || !(user.role === 'admin' || b.client_id === user.id)) throw new HttpError(404, 'Réservation introuvable.');
    const isTest = !b.paid && b.payment_status !== 'virement_facture';
    if (isTest && (production || b.status !== 'terminee')) throw new HttpError(409, b.payment_status === 'virement' ? 'La facture sera créée avec le relevé de fin de mois.' : 'La facture est disponible dès que la réservation est payée.');
    const facture = isTest ? null : issueInvoice(b.id);
    const avoirs = isTest ? [] : db.prepare("SELECT * FROM invoices WHERE kind = 'avoir' AND booking_id = ? ORDER BY seq").all(b.id);
    const wanted = String(query.get('doc') || '');
    const doc = isTest ? { kind: 'facture', number: `TEST-${b.id}`, amount_cents: Math.round((b.total + (b.discount || 0)) * 100), tva_rate: tvaOf(b), issued_at: now().toISOString() }
      : avoirs.find((a) => a.number === wanted) || facture;
    const { title, body } = invoiceBody(doc, b, { isTest, avoirs });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<>&"]/g, '')}</title>
<style>${INVOICE_CSS}</style></head><body>
${body}</body></html>`);
    return { streamed: true };
  });

  // ----- relances des clients qui ne reviennent pas -----
  // Clients existants, pour un service qu'ils ont déjà acheté : autorisé sans accord préalable (« soft opt-in »),
  // à condition d'offrir la désinscription en un clic dans chaque e-mail. Une relance au plus tous les 120 jours.
  const nudgeSettings = () => {
    try { return { enabled: true, days: 45, ...JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'nudges'").get()?.value || '{}') }; } catch { return { enabled: true, days: 45 }; }
  };
  const unsubSecret = (() => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'unsub_secret'").get();
    if (row) return row.value;
    const v = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('unsub_secret', ?)").run(v);
    return v;
  })();
  const unsubToken = (uid) => crypto.createHmac('sha256', unsubSecret).update(`unsub:${uid}`).digest('hex').slice(0, 32);
  const unsubUrl = (uid) => `${appUrl.replace(/\/$/, '')}/desinscription?u=${uid}&t=${unsubToken(uid)}`;
  function nudgeCandidates() {
    const st = nudgeSettings();
    const today = pricing.todayParis(now());
    const back = (n) => new Date(Date.parse(today + 'T12:00:00Z') - n * 864e5).toISOString().slice(0, 10);
    return db.prepare(`SELECT u.id, u.name, u.email, MAX(b.date) AS last FROM users u JOIN bookings b ON b.client_id = u.id AND b.status = 'terminee'
      WHERE u.role = 'client' AND u.marketing_optout = 0 AND (u.last_nudge_at IS NULL OR u.last_nudge_at < datetime('now', '-120 days'))
        AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.client_id = u.id AND x.status IN ('en_attente','proposee','attribuee','en_cours'))
      GROUP BY u.id HAVING MAX(b.date) <= ? AND MAX(b.date) >= ? ORDER BY last`).all(back(st.days), back(st.days + 60));
  }
  function runNudges({ force = false } = {}) {
    const st = nudgeSettings();
    if (!st.enabled && !force) return 0;
    let n = 0;
    for (const c of nudgeCandidates()) {
      const last = db.prepare("SELECT * FROM bookings WHERE client_id = ? AND status = 'terminee' ORDER BY date DESC, id DESC LIMIT 1").get(c.id);
      db.prepare("UPDATE users SET last_nudge_at = datetime('now') WHERE id = ?").run(c.id);
      const url = unsubUrl(c.id);
      mailer.send(c.email, 'On repasse faire briller chez vous ?', `Bonjour ${c.name.split(' ')[0]}`, [
        `Votre dernier ménage avec Proprigo date du ${fr(last.date)}.`,
        'On revient ? Réservez le même ménage en une minute : même adresse, mêmes consignes, et votre intervenante préférée si elle est libre.',
        `Vous ne souhaitez plus recevoir ces rappels ? Désinscription : ${url}`,
      ], { label: 'Réserver le même ménage', path: `/#/reserver?again=${last.id}` }, { key: `nudge-${c.id}-${last.date}`, headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
      n += 1;
    }
    if (n) db_.log(db, `Relances envoyées à ${n} client(s) sans ménage depuis ${st.days} jours.`);
    return n;
  }
  route('GET', '/api/admin/nudges', ({ user }) => {
    need(user, 'admin');
    return { settings: nudgeSettings(), preview: nudgeCandidates().map((c) => ({ name: c.name, last: c.last })),
      optouts: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'client' AND marketing_optout = 1").get().n,
      sent30: db.prepare("SELECT COUNT(*) AS n FROM users WHERE last_nudge_at >= datetime('now', '-30 days')").get().n };
  });
  route('POST', '/api/admin/nudges', ({ user, body }) => {
    need(user, 'admin');
    const days = [30, 45, 60, 90].includes(Number(body.days)) ? Number(body.days) : 45;
    const st = { enabled: Boolean(body.enabled), days };
    db.prepare("INSERT INTO settings (key, value, updated_by) VALUES ('nudges', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by").run(JSON.stringify(st), user.id);
    db_.log(db, `Relances ${st.enabled ? `activées (après ${days} jours sans ménage)` : 'désactivées'} par ${user.name}.`);
    return { ok: true, message: st.enabled ? `Relances activées : après ${days} jours sans ménage.` : 'Relances désactivées.' };
  });
  route('POST', '/api/admin/nudges/run', ({ user }) => {
    need(user, 'admin');
    const n = runNudges({ force: true });
    return { ok: true, sent: n, message: n ? `${n} relance(s) envoyée(s).` : 'Personne à relancer aujourd\'hui.' };
  });

  // ----- export des factures pour le comptable -----
  const invoicesOfMonth = (month) => db.prepare('SELECT * FROM invoices ORDER BY kind DESC, year, seq').all()
    .filter((i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date(i.issued_at)).slice(0, 7) === month);
  route('GET', '/api/admin/invoices.csv', ({ user, query, res }) => {
    need(user, 'admin');
    if (!monthOk(query.get('month'))) throw new HttpError(400, 'Mois invalide (AAAA-MM).');
    const cell = (v) => { const t = String(v ?? ''); if (/^-?\d+(,\d+)?$/.test(t)) return t; return /[;"\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; }; // un nombre (même négatif) reste un nombre ; un texte qui commence par = + - @ est neutralisé
    const eurx = (c) => (c / 100).toFixed(2).replace('.', ',');
    const lines = [['Numéro', 'Type', 'Date', 'Client', 'SIRET client', 'Réservation', 'Prestation', 'Montant HT', 'Taux TVA', 'TVA', 'Montant TTC', 'Facture d\'origine'].join(';')];
    let ht = 0; let tva = 0; let ttc = 0;
    for (const i of invoicesOfMonth(query.get('month'))) {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(i.booking_id) || {};
      const c = db.prepare('SELECT name, company, siret FROM users WHERE id = ?').get(i.client_id) || {};
      const sign = i.kind === 'avoir' ? -1 : 1;
      const h = Math.round(i.amount_cents / (1 + i.tva_rate));
      ht += sign * h; tva += sign * (i.amount_cents - h); ttc += sign * i.amount_cents;
      lines.push([i.number, i.kind === 'avoir' ? 'Avoir' : 'Facture', new Date(i.issued_at).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }), c.company || c.name, c.siret || '', b.id || '',
        `${SERVICE_NAME[b.service] || 'Ménage'} du ${b.date ? fr(b.date) : '?'}`, eurx(sign * h), i.tva_rate ? `${Math.round(i.tva_rate * 1000) / 10} %` : 'Non applicable (293 B)', eurx(sign * (i.amount_cents - h)), eurx(sign * i.amount_cents), i.ref_invoice || ''].map(cell).join(';'));
    }
    lines.push(['TOTAL', '', '', '', '', '', '', eurx(ht), '', eurx(tva), eurx(ttc), ''].join(';'));
    db_.log(db, `Export des factures de ${query.get('month')} par ${user.name}.`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="proprigo-factures-${query.get('month')}.csv"`, 'Cache-Control': 'no-store' });
    res.end('﻿' + lines.join('\r\n'));
    return { streamed: true };
  });
  // export de paie des salariées : heures, prime Platine, pourboires, absences, pour le comptable
  route('GET', '/api/admin/payroll.csv', ({ user, query, res }) => {
    need(user, 'admin');
    if (!isOwner(user)) throw new HttpError(403, 'Réservé au responsable.');
    const month = query.get('month');
    if (!monthOk(month)) throw new HttpError(400, 'Mois invalide (AAAA-MM).');
    const cell = (v) => { const t = String(v ?? ''); if (/^-?\d+(,\d+)?$/.test(t)) return t; return /[;"\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; };
    const n2 = (x) => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');
    const lines = [['Salariée', 'E-mail', 'Ménages', 'Heures', 'Dont dimanches et jours fériés (h)', 'Niveau', 'Prime Platine (€/h)', 'Prime Platine (€)', 'Pourboires (€)', 'Absences non prévenues', 'Congés posés (jours)'].join(';')];
    const holidays = pricing.holidays(Number(month.slice(0, 4))); // jours fériés de l'année
    for (const w of db.prepare("SELECT w.user_id, u.name, u.email FROM workers w JOIN users u ON u.id = w.user_id WHERE w.statut = 'S' AND w.rejected_at IS NULL ORDER BY u.name").all()) {
      const rows = db.prepare("SELECT date, hours FROM bookings WHERE worker_id = ? AND status = 'terminee' AND substr(date, 1, 7) = ?").all(w.user_id, month);
      const hours = rows.reduce((t, r) => t + r.hours, 0);
      const special = rows.filter((r) => new Date(r.date + 'T12:00:00Z').getUTCDay() === 0 || holidays.has(r.date)).reduce((t, r) => t + r.hours, 0);
      const t = tiers.tierOf(db, w.user_id);
      const tips = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM tips WHERE worker_id = ? AND status = 'paye' AND substr(paid_at, 1, 7) = ?").get(w.user_id, month).c / 100;
      const absences = db.prepare('SELECT COUNT(*) AS n FROM worker_absences a JOIN bookings b ON b.id = a.booking_id WHERE a.worker_id = ? AND substr(b.date, 1, 7) = ?').get(w.user_id, month).n;
      const offDays = db.prepare('SELECT start_date, end_date FROM timeoff WHERE worker_id = ?').all(w.user_id).reduce((tot, o) => {
        let k = 0; for (let d = o.start_date; d <= o.end_date; d = addDays(d, 1)) if (d.slice(0, 7) === month) k += 1; return tot + k;
      }, 0);
      lines.push([w.name, w.email, rows.length, n2(hours), n2(special), t.label, n2(t.bonus), n2(hours * t.bonus), n2(tips), absences, offDays].map(cell).join(';'));
    }
    db_.log(db, `Export de paie de ${month} par ${user.name}.`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="proprigo-paie-${month}.csv"`, 'Cache-Control': 'no-store' });
    res.end('\ufeff' + lines.join('\r\n'));
    return { streamed: true };
  });
  // Toutes les factures et avoirs du mois sur une page, une pièce par feuille : « Imprimer › Enregistrer en PDF ».
  // relevé mensuel de l'intervenante (imprimable en PDF) : missions, heures, bonus, pourboires, versements reçus
  route('GET', '/api/worker/statement', ({ user, query, res }) => {
    need(user);
    const month = query.get('month');
    if (!monthOk(month)) throw new HttpError(400, 'Mois invalide (AAAA-MM).');
    const wid = user.role === 'intervenante' ? user.id : isOwner(user) && query.get('worker') ? Number(query.get('worker')) : null;
    const w = wid ? workerProfile(wid) : null;
    if (!w) throw new HttpError(404, 'Relevé introuvable.');
    const ind = w.statut === 'I';
    const e2 = (n) => `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} €`;
    const h2 = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
    const esc2 = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = db.prepare("SELECT id, date, time, service, cp, hours FROM bookings WHERE worker_id = ? AND status = 'terminee' AND substr(date, 1, 7) = ? ORDER BY date, time").all(wid, month);
    const hours = rows.reduce((t, r) => t + r.hours, 0);
    const bonus = bonusOf(wid);
    const bonusRate = bonus.eligible ? bonus.perHour : 0;
    const tips = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM tips WHERE worker_id = ? AND status = 'paye' AND substr(paid_at, 1, 7) = ?").get(wid, month).c / 100;
    const base = ind ? earnOf(wid, rows) : 0;
    const paid = ind ? db.prepare('SELECT week_start, amount, reference, paid_at FROM payouts WHERE worker_id = ? AND paid_at IS NOT NULL AND substr(paid_at, 1, 7) = ? ORDER BY paid_at').all(wid, month) : [];
    const received = paid.reduce((t, p) => t + p.amount, 0);
    const label = new Date(month + '-15T12:00:00Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relevé ${month} – ${esc2(w.name)}</title><style>${INVOICE_CSS} td.n,th.n{text-align:right} .tot td{font-weight:700;border-top:2px solid #0f1430} .box{background:#f2f5ff;border-radius:12px;padding:12px 16px;margin:16px 0}</style></head><body>
<p class="noprint muted">Pour un PDF : Ctrl + P (ou Partager › Imprimer sur téléphone), puis « Enregistrer au format PDF ».</p>
<h1>Relevé de ${esc2(label)}</h1>
<p><b>${esc2(w.name)}</b> · ${ind ? 'Intervenante indépendante' : 'Intervenante salariée'}${ind && w.rate ? ` · ${e2(w.rate)} de l'heure` : ''}<br>Proprigo${company.raisonSociale ? ` (${esc2(company.raisonSociale)})` : ''}</p>
<table><thead><tr><th>Date</th><th>Mission</th><th>Prestation</th><th>Secteur</th><th class="n">Heures</th>${ind ? '<th class="n">Montant</th>' : ''}</tr></thead><tbody>
${rows.map((r) => `<tr><td>${fr(r.date)} ${esc2(r.time)}</td><td>n° ${r.id}</td><td>${esc2(SERVICE_NAME[r.service] || r.service)}</td><td>${esc2(r.cp)}</td><td class="n">${h2(r.hours)}</td>${ind ? `<td class="n">${e2(r.hours * rateAt(wid, r.date))}</td>` : ''}</tr>`).join('') || `<tr><td colspan="${ind ? 6 : 5}">Aucune mission terminée ce mois-ci.</td></tr>`}
<tr class="tot"><td colspan="4">${rows.length} mission${rows.length > 1 ? 's' : ''}</td><td class="n">${h2(hours)} h</td>${ind ? `<td class="n">${e2(base)}</td>` : ''}</tr></tbody></table>
${bonusRate ? `<p>💎 Bonus Platine : ${e2(bonusRate)} de l'heure, soit ${e2(hours * bonusRate)} ce mois-ci.</p>` : ''}
${tips ? `<p>💝 Pourboires reçus ce mois-ci : ${e2(tips)}.</p>` : ''}
${ind ? `<div class="box"><b>Total des prestations du mois : ${e2(base + hours * bonusRate + tips)}</b><br>
Versements reçus ce mois-ci : <b>${e2(received)}</b>${paid.length ? ` (${paid.map((p) => `${e2(p.amount)} le ${fr(p.paid_at.slice(0, 10))}${p.reference ? `, réf. ${esc2(p.reference)}` : ''}`).join(' ; ')})` : ''}.<br>
<span class="muted">En micro-entreprise, on déclare à l'URSSAF les sommes <b>encaissées</b> dans la période : c'est en général le montant « versements reçus ». En cas de doute, demandez à l'URSSAF ou à votre comptable.</span></div>`
    : `<div class="box"><b>${h2(hours)} heures réalisées</b>${bonusRate ? ` · prime Platine ${e2(hours * bonusRate)}` : ''}${tips ? ` · pourboires ${e2(tips)}` : ''}<br><span class="muted">Document d'information : seule votre fiche de paie fait foi.</span></div>`}
<p class="muted">Relevé édité le ${fr(pricing.todayParis(now()))}.</p>
</body></html>`);
    return { streamed: true };
  });
  route('GET', '/api/admin/invoices/print', ({ user, query, res }) => {
    need(user, 'admin');
    if (!monthOk(query.get('month'))) throw new HttpError(400, 'Mois invalide (AAAA-MM).');
    const list = invoicesOfMonth(query.get('month'));
    const docs = list.map((i) => { const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(i.booking_id); return b ? invoiceBody(i, b, { forPrint: true }).body : ''; });
    db_.log(db, `Impression groupée des factures de ${query.get('month')} par ${user.name} (${list.length} pièce(s)).`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Factures ${query.get('month')}</title>
<style>${INVOICE_CSS} .doc{page-break-after:always;break-after:page;padding-bottom:24px;border-bottom:2px dashed #dce3f7;margin-bottom:24px}.doc:last-child{page-break-after:auto;border:0}@media print{.doc{border:0}}</style></head><body>
<p class="noprint muted">${list.length} pièce(s) pour ${query.get('month')}. Pour un PDF unique : Ctrl + P, puis « Enregistrer au format PDF ».</p>
${docs.map((d) => `<section class="doc">${d}</section>`).join('\n') || '<p>Aucune facture ce mois-ci.</p>'}
</body></html>`);
    return { streamed: true };
  });

  // ----- e-mails envoyés (mode local) -----
  route('GET', '/api/admin/outbox', ({ user }) => {
    need(user, 'admin');
    return { provider: mailer.cfg.provider || null, list: mailer.outbox(), queue: mailer.queueState() };
  });
  route('GET', '/api/admin/outbox/[\\w.-]+', ({ user, req, res }) => {
    need(user, 'admin');
    const body = mailer.readOutbox(decodeURIComponent(req.url.split('/').pop()));
    if (!body) throw new HttpError(404, 'E-mail introuvable.');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(body);
    return { streamed: true };
  });

  // ----- administrateur -----
  // vrais chiffres : argent réellement encaissé dans Stripe, clients qui reviennent, zones
  const metrics = () => {
    const m0 = pricing.todayParis(now()).slice(0, 7);
    const paidRows = db.prepare("SELECT amount_cents, refunded_cents, substr(created_at, 1, 7) AS m FROM stripe_payments WHERE status = 'paid'").all();
    const sum = (rows) => rows.reduce((t, r) => t + (r.amount_cents - (r.refunded_cents || 0)), 0) / 100;
    const prev = new Date(Date.parse(m0 + '-15T12:00:00Z') - 30 * 864e5).toISOString().slice(0, 7);
    const clientsWith = db.prepare("SELECT client_id, COUNT(*) AS n FROM bookings WHERE status = 'terminee' GROUP BY client_id").all();
    const zones = db.prepare("SELECT cp, COUNT(*) AS n FROM bookings WHERE status <> 'annulee' GROUP BY cp ORDER BY n DESC LIMIT 5").all();
    const cancels = db.prepare("SELECT COUNT(*) AS n, SUM(status = 'annulee') AS a FROM bookings WHERE NOT (payment_status = 'paiement_echoue')").get();
    return {
      encaisseTotal: Math.round(sum(paidRows) * 100) / 100,
      encaisseMois: Math.round(sum(paidRows.filter((r) => r.m === m0)) * 100) / 100,
      encaisseMoisPrecedent: Math.round(sum(paidRows.filter((r) => r.m === prev)) * 100) / 100,
      clientsActifs: clientsWith.length,
      clientsFideles: clientsWith.filter((c) => c.n >= 2).length,
      tauxAnnulation: cancels.n ? Math.round((cancels.a / cancels.n) * 100) : 0,
      zones,
      parrainages: db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by IS NOT NULL').get().n,
    };
  };
  route('GET', '/api/admin/overview', ({ user }) => {
    needStaff(user);
    const bookings = db.prepare('SELECT * FROM bookings ORDER BY date DESC, time DESC LIMIT 200').all().map(bookingView);
    const icalFlagged = db.prepare("SELECT b.id, b.date, b.time, b.cp, h.name AS home_name FROM bookings b LEFT JOIN homes h ON h.id = b.home_id WHERE b.ical_flagged = 1 AND b.status IN ('en_attente','proposee','attribuee') ORDER BY b.date").all();
    const done = db.prepare("SELECT * FROM bookings WHERE status = 'terminee'").all(); // toutes, pas seulement les 200 dernières
    const totals = db.prepare("SELECT COUNT(*) AS n, AVG(rating) AS note, COUNT(rating) AS avis FROM bookings").get();
    const refund = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(refund_amount, total)), 0) AS montant FROM bookings WHERE payment_status = 'a_rembourser'").get();
    const workers = db.prepare('SELECT w.*, u.name, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id ORDER BY u.name').all()
      .map((w) => {
        const d = docsOf(w.user_id);
        const toCheck = db.prepare("SELECT COUNT(*) AS n FROM worker_docs WHERE worker_id = ? AND status = 'a_verifier'").get(w.user_id).n;
        const t = tiers.tierOf(db, w.user_id);
        return { ...w, tier: { key: t.key, label: t.label, icon: t.icon }, steps: db_.STEPS[w.statut], active: engine.isActive(w), rejected: Boolean(w.rejected_at),
          docs: d ? { required: d.list.filter((k) => k.required).length, valid: d.list.filter((k) => k.required && k.latest?.status === 'valide').length, toCheck } : null };
      });
    let ca = 0; let marge = 0;
    for (const b of done) {
      const m = pricing.estimateMargin(b, workers.find((w) => w.user_id === b.worker_id));
      ca += m.ht; marge += m.marge;
    }
    const wl = db.prepare("SELECT substr(cp, 1, 2) AS dept, COUNT(*) AS n FROM waitlist GROUP BY dept ORDER BY n DESC").all();
    const events = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 300').all();
    const incidents = db.prepare('SELECT i.*, b.date, b.time, b.cp FROM incidents i JOIN bookings b ON b.id = i.booking_id WHERE i.resolved = 0 ORDER BY i.id DESC').all();
    const clients = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'client'").get().n;
    if (!isOwner(user)) {
      return { kpis: { reservations: totals.n, noteMoyenne: totals.avis ? Math.round(totals.note * 10) / 10 : null, clients, terminees: done.length, caHT: 0, marge: 0, aRembourser: { n: 0, montant: 0 } },
        couts: null, paymentsEnabled, bookings: bookings.map((b) => ({ ...b, total: null })), icalFlagged, workers: workers.map((w) => ({ ...w, email: '', phone: '' })), waitlist: [], events: [], incidents, metrics: null, staff: 'planning' };
    }
    return {
      kpis: {
        reservations: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE NOT (paid = 0 AND payment_status = 'paiement_echoue' AND status = 'annulee')").get().n, terminees: done.length, caHT: Math.round(ca), marge: Math.round(marge),
        noteMoyenne: totals.avis ? Math.round(totals.note * 10) / 10 : null, clients,
        aRembourser: { n: refund.n, montant: refund.montant },
      },
      couts: pricing.COSTS, paymentsEnabled,
      bookings, icalFlagged, workers, waitlist: wl, events, incidents,
      metrics: metrics(),
      quoteRequests: db.prepare("SELECT COUNT(*) AS n FROM quote_requests WHERE status IN ('nouveau', 'accepte', 'refuse')").get().n,
      staff: isOwner(user) ? 'owner' : 'planning',
    };
  });

  // Création contrôlée d'intervenantes par l'administrateur. Aucun profil n'est actif sans validation.
  route('POST', '/api/admin/workers', ({ user, body }) => {
    need(user, 'admin');
    const email = str(body.email, 120).toLowerCase();
    const name = str(body.name, 80);
    const cp = str(body.cp, 5);
    const statut = body.statut === 'I' ? 'I' : 'S';
    const password = typeof body.password === 'string' ? body.password : '';
    const rate = statut === 'I' ? Number(body.rate) : null;
    if (!name || !EMAIL_RE.test(email)) throw new HttpError(400, 'Nom ou e-mail invalide.');
    if (!pricing.zoneOf(cp)) throw new HttpError(400, 'Code postal invalide.');
    if (password.length < 10) throw new HttpError(400, 'Mot de passe : 10 caractères minimum.');
    if (statut === 'I' && !(rate >= 15 && rate <= 40)) throw new HttpError(400, 'Tarif horaire entre 15 et 40 €.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Adresse déjà utilisée.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const id = db_.createUser(db, { role: 'intervenante', email, name, password, phone: str(body.phone, 20) });
      db.prepare('INSERT INTO workers (user_id, statut, cp, rate, step, gender) VALUES (?, ?, ?, ?, 0, ?)').run(id, statut, cp, rate, body.gender === 'h' ? 'h' : 'f');
      db_.setAvailability(db, id, db_.NEW_WORKER_WEEK);
      db.exec('COMMIT');
      db_.log(db, `Intervenante créée par administration : ${name} (validation nécessaire).`);
      // Elle est prévenue : lien pour confirmer son adresse (obligatoire avant l'activation), puis connexion.
      // Le mot de passe provisoire n'est jamais envoyé par e-mail : vous le lui donnez de vive voix ou par SMS.
      mailer.send(email, 'Votre espace intervenante Proprigo est prêt', `Bienvenue, ${name.split(' ')[0]}`, [
        `L'équipe Proprigo vous a créé un espace intervenante avec l'adresse ${email}.`,
        '1. Confirmez votre adresse avec le bouton ci-dessous (lien valable 7 jours).',
        "2. Connectez-vous avec le mot de passe provisoire que l'équipe vous a donné, puis changez-le dans « Mon compte ».",
        '3. Déposez vos pièces justificatives dans « Mes documents ».',
      ], { label: 'Confirmer mon adresse', path: verificationLink(id) });
      return { status: 201, data: { ok: true, id, message: `Compte créé. ${name.split(' ')[0]} reçoit un e-mail pour confirmer son adresse. Donnez-lui le mot de passe provisoire de vive voix ou par SMS.` } };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  // Comptes fictifs, exclusivement pour tester l'interface. Jamais actifs automatiquement.
  route('POST', '/api/admin/workers/demo', ({ user }) => {
    need(user, 'admin');
    if (production && process.env.ALLOW_DEMO_WORKERS !== 'true') throw new HttpError(403, 'Profils fictifs désactivés en production. Activez ALLOW_DEMO_WORKERS=true temporairement pour les essais.');
    const examples = [
      ['fatima@proprigo.test', 'Fatima K. (TEST)', 'S', '75011', null],
      ['aissata@proprigo.test', 'Aïssata D. (TEST)', 'S', '75018', null],
      ['ines@proprigo.test', 'Inès M. (TEST)', 'I', '75020', 24],
      ['lucia@proprigo.test', 'Lucia P. (TEST)', 'I', '92100', 24],
      ['mariam@proprigo.test', 'Mariam S. (TEST)', 'S', '93200', null],
    ];
    let created = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [email, name, statut, cp, rate] of examples) {
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) continue;
        const id = db_.createUser(db, { role: 'intervenante', email, name, password: crypto.randomBytes(32).toString('hex') });
        db.prepare('INSERT INTO workers (user_id, statut, cp, rate, step, absent) VALUES (?, ?, ?, ?, 0, 1)').run(id, statut, cp, rate);
        db_.setAvailability(db, id, db_.NEW_WORKER_WEEK);
        created++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db_.log(db, `${created} profils fictifs ajoutés (inactifs et absents).`);
    return { created, message: `${created} profil(s) fictif(s) ajouté(s). Ils ne sont pas disponibles pour les réservations.` };
  });

  route('POST', '/api/admin/workers/:id/advance', ({ user, id }) => {
    need(user, 'admin');
    const w = workerProfile(id);
    if (!w) throw new HttpError(404, 'Intervenante introuvable.');
    if (w.email.endsWith('@proprigo.test') && w.name.includes('(TEST)')) throw new HttpError(403, 'Profil fictif : activation interdite.');
    if (production && !db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(id)?.email_verified_at) throw new HttpError(409, "Cette personne doit d'abord confirmer son adresse e-mail (lien reçu à l'inscription).");
    if (w.rejected_at) throw new HttpError(409, 'Candidature refusée.');
    const steps = db_.STEPS[w.statut];
    const docState = docsOf(id);
    if (production && w.step === steps.length - 2 && !docState.complete) throw new HttpError(409, `Activation impossible : pièces non validées (${docState.missing.join(' ; ')}).`);
    if (w.step >= steps.length - 1) throw new HttpError(409, 'Déjà active.');
    db.prepare('UPDATE workers SET step = step + 1 WHERE user_id = ?').run(id);
    db_.log(db, `${w.name} : étape « ${steps[w.step + 1]} » validée.${w.step + 1 === steps.length - 1 ? ' Compte activé.' : ''}`);
    if (w.step + 1 === steps.length - 1) {
      engine.retryPending(db);
      mailer.send(w.email, 'Votre candidature est acceptée', `Bienvenue dans l'équipe, ${w.name.split(' ')[0]}`, [
        'Votre candidature est acceptée : vous pouvez maintenant recevoir des missions.',
        'Première chose à faire : indiquez vos disponibilités et vos congés dans votre espace. Vous ne recevez des missions que pendant ces horaires.',
      ], { label: 'Régler mes disponibilités', path: '/#/intervenante' }, { key: `worker-active-${id}` });
    }
    return { ok: true };
  });

  route('POST', '/api/admin/workers/:id/absent', ({ user, id }) => {
    needStaff(user);
    const w = workerProfile(id);
    if (!w) throw new HttpError(404, 'Intervenante introuvable.');
    const absent = w.absent ? 0 : 1;
    db.prepare('UPDATE workers SET absent = ? WHERE user_id = ?').run(absent, id);
    db_.log(db, `${w.name} marquée ${absent ? 'absente' : 'présente'}.`);
    if (absent) {
      const toMove = db.prepare("SELECT id FROM bookings WHERE worker_id = ? AND status = 'attribuee'").all(id);
      for (const b of toMove) {
        db.prepare("UPDATE bookings SET worker_id = NULL, status = 'en_attente' WHERE id = ?").run(b.id); // nouvelle attribution par l'administrateur
      }
      db.prepare("DELETE FROM offers WHERE worker_id = ? AND state = 'offered'").run(id);
    } else {
      engine.retryPending(db);
    }
    return { ok: true };
  });

  route('POST', '/api/admin/incidents/:id/resolve', ({ user, id }) => {
    needStaff(user);
    const r = db.prepare('UPDATE incidents SET resolved = 1 WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Signalement introuvable.');
    db_.log(db, `Signalement n° ${id} traité.`);
    return { ok: true, message: 'Signalement marqué comme traité.' };
  });

  // ----- séjours disparus du calendrier : décision humaine -----
  const keepIcal = (b, who) => {
    db.prepare('UPDATE bookings SET ical_keep = 1, ical_flagged = 0, ical_missing_since = NULL WHERE id = ?').run(b.id);
    db_.log(db, `Ménage n° ${b.id} maintenu par ${who} malgré l'absence du séjour dans le calendrier.`);
    return { ok: true, message: 'Le ménage est maintenu.' };
  };
  route('POST', '/api/bookings/:id/ical-keep', ({ user, id }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ? AND ical_flagged = 1').get(id, user.id);
    if (!b) throw new HttpError(404, 'Rien à vérifier pour ce ménage.');
    return keepIcal(b, 'le client');
  });
  route('POST', '/api/admin/bookings/:id/ical-keep', ({ user, id }) => {
    needStaff(user);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND ical_flagged = 1').get(id);
    if (!b) throw new HttpError(404, 'Rien à vérifier pour ce ménage.');
    return keepIcal(b, "l'équipe");
  });
  route('POST', '/api/admin/bookings/:id/cancel', ({ user, id }) => {
    need(user, 'admin');
    const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND status IN ('en_attente','proposee','attribuee')").get(id);
    if (!b) throw new HttpError(409, 'Ce ménage ne peut plus être annulé.');
    // annulation décidée par l'équipe (séjour annulé chez la plateforme, confirmé avec le client) : remboursement complet
    db.prepare("UPDATE bookings SET status = 'annulee', payment_status = CASE WHEN paid = 1 OR payment_status IN ('paye','simule') THEN 'a_rembourser' ELSE payment_status END, refund_amount = CASE WHEN paid = 1 OR payment_status IN ('paye','simule') THEN total ELSE 0 END, ical_flagged = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM offers WHERE booking_id = ? AND state = 'offered'").run(id);
    engine.notify(db, id, b.paid ? `Le ménage du ${fr(b.date)} est annulé par l'équipe Proprigo. Un remboursement intégral de ${b.total} € est à effectuer.` : `Le ménage du ${fr(b.date)} est annulé par l'équipe Proprigo. Aucun paiement encaissé.`);
    if (b.worker_id) mailer.send(emailOf(b.worker_id), `Mission annulée le ${fr(b.date)}`, 'Mission annulée', [`La mission du ${fr(b.date)} à ${b.time} (${b.cp}) est annulée.`], { label: 'Voir mes missions', path: '/#/intervenante' });
    db_.log(db, `Ménage n° ${id} annulé par l'équipe, ${b.paid ? `${b.total} € à rembourser` : 'aucun remboursement requis'}.`);
    return { ok: true, message: b.paid ? `Ménage n° ${id} annulé, ${b.total} € à rembourser.` : `Ménage n° ${id} annulé, aucun remboursement nécessaire.` };
  });

  route('POST', '/api/admin/bookings/:id/refunded', ({ user, id }) => {
    need(user, 'admin');
    const before = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    const r = db.prepare("UPDATE bookings SET payment_status = 'rembourse' WHERE id = ? AND payment_status = 'a_rembourser'").run(id);
    if (!r.changes) throw new HttpError(409, 'Rien à rembourser pour cette réservation.');
    const amountCents = Math.round(Number(before.refund_amount ?? before.total) * 100);
    const avoir = issueCreditNote(id, amountCents, `refund-${id}-${amountCents}`);
    db_.log(db, `Réservation n° ${id} : remboursement effectué${avoir ? `, avoir ${avoir.number}` : ''}.`);
    return { ok: true, message: `Réservation n° ${id} marquée remboursée.` };
  });

  // ----- remboursement réel dans Stripe -----
  route('POST', '/api/admin/bookings/:id/refund', async ({ user, id }) => {
    need(user, 'admin');
    const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND payment_status = 'a_rembourser'").get(id);
    if (!b) throw new HttpError(409, 'Rien à rembourser pour cette réservation.');
    const amount = Math.round(Number(b.refund_amount ?? b.total) * 100);
    if (!stripePay.configured()) throw new HttpError(503, "Stripe n'est pas configuré sur ce serveur : remboursez dans le tableau de bord Stripe, puis cliquez sur « Marquer remboursé ».");
    let r;
    try { r = await stripePay.refund({ db, bookingId: id, amountCents: amount }); }
    catch (e) { throw new HttpError(502, `Remboursement refusé : ${e.message}. Rien n'a été débité ; vérifiez dans Stripe.`); }
    db.prepare("UPDATE bookings SET payment_status = ?, refund_id = ? WHERE id = ?").run(r.status === 'succeeded' ? 'rembourse' : 'remboursement_en_cours', r.id, id);
    const avoir = issueCreditNote(id, amount, `refund-${id}-${amount}`);
    db_.log(db, `Réservation n° ${id} : ${(amount / 100).toFixed(2).replace('.', ',')} € remboursés dans Stripe (${r.status === 'pending' ? 'en cours' : 'effectué'})${avoir ? `, avoir ${avoir.number}` : ''}.`);
    engine.notify(db, id, `Votre remboursement de ${(amount / 100).toFixed(2).replace('.', ',')} € a été lancé. Il apparaît sur votre compte bancaire sous 5 à 10 jours.`);
    return { ok: true, message: r.status === 'succeeded' ? `${(amount / 100).toFixed(2).replace('.', ',')} € remboursés dans Stripe.` : `Remboursement de ${(amount / 100).toFixed(2).replace('.', ',')} € en cours chez Stripe.` };
  });

  // ----- planning de la semaine -----
  route('GET', '/api/admin/planning', ({ user, query }) => {
    needStaff(user);
    const start = pricing.isValidDate(query.get('start')) ? query.get('start') : pricing.todayParis(now());
    const end = new Date(Date.parse(start + 'T12:00:00Z') + 6 * 864e5).toISOString().slice(0, 10);
    const workers = db.prepare('SELECT w.user_id, w.statut, w.cp, w.absent, u.name FROM workers w JOIN users u ON u.id = w.user_id ORDER BY u.name').all()
      .filter((w) => engine.isActive({ ...workerProfile(w.user_id) }));
    const rows = db.prepare("SELECT id, date, time, hours, cp, service, size, status, worker_id, paid, payment_status FROM bookings WHERE date BETWEEN ? AND ? AND status IN ('en_attente','proposee','attribuee','en_cours','terminee') ORDER BY date, time").all(start, end);
    return { start, end, workers, bookings: rows.map((b) => ({ ...b, label: `${b.service === 'airbnb' ? 'Airbnb ' + (b.size || '') : b.service === 'bureau' ? 'Bureaux' : b.service === 'grand' ? 'Grand nettoyage' : 'Ménage'} ${b.service === 'airbnb' ? '' : String(b.hours).replace('.', ',') + ' h'}`.trim() })) };
  });

  route('GET', '/api/admin/bookings/:id/candidates', ({ user, id }) => {
    needStaff(user);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    const offered = new Set(db.prepare("SELECT worker_id FROM offers WHERE booking_id = ? AND state = 'offered'").all(id).map((r) => r.worker_id));
    const list = engine.candidates(db, b, { withRefused: true })
      .filter((w) => w.user_id !== b.worker_id)
      .map((w) => ({ user_id: w.user_id, name: w.name, statut: w.statut, cp: w.cp, proximite: engine.proximity(w.d), refused: w.refused, offered: offered.has(w.user_id) }));
    return { booking: bookingView(b), list };
  });

  // ----- absence non prévenue : comptée dans le niveau (pas de Platine avec une absence sur 6 mois) -----
  db.exec(`CREATE TABLE IF NOT EXISTS worker_absences (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
    worker_id INTEGER NOT NULL REFERENCES users(id), note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by INTEGER)`);
  route('POST', '/api/admin/bookings/:id/no-show', ({ user, id, body }) => {
    needStaff(user);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !b.worker_id) throw new HttpError(404, 'Aucune intervenante sur cette réservation.');
    if (!['attribuee', 'en_cours'].includes(b.status)) throw new HttpError(409, 'Seulement pour un ménage prévu, pas terminé ni annulé.');
    if (b.date > pricing.todayParis(now())) throw new HttpError(409, 'Le ménage n\'a pas encore eu lieu.');
    const w = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.worker_id);
    const note = str(body.note, 300) || null;
    try { db.prepare('INSERT INTO worker_absences (booking_id, worker_id, note, created_by) VALUES (?, ?, ?, ?)').run(id, b.worker_id, note, user.id); }
    catch { throw new HttpError(409, 'Absence déjà notée pour ce ménage.'); }
    // la mission repart : l'équipe choisit une remplaçante (ou attribution automatique)
    db.prepare("UPDATE bookings SET worker_id = NULL, status = 'en_attente', on_way_at = NULL, arrived_at = NULL, eta_at = NULL WHERE id = ?").run(id);
    db.prepare("DELETE FROM offers WHERE booking_id = ?").run(id);
    db_.log(db, `Absence non prévenue de ${w.name} notée par ${user.name} (réservation n° ${id})${note ? ` : ${note}` : ''}.`);
    mailer.send(w.email, 'Absence non prévenue', 'Vous n\'êtes pas venue à une mission', [`La mission n° ${id} du ${fr(b.date)} à ${b.time} a été notée « absence non prévenue ».`, 'Si vous ne pouvez pas venir, prévenez toujours l\'équipe à l\'avance : contact@proprigo.fr.', 'Si c\'est une erreur, répondez à cet e-mail.'], null);
    return { ok: true, message: `Absence notée. La réservation n° ${id} est à réattribuer.` };
  });
  route('POST', '/api/admin/bookings/:id/assign', ({ user, id, body }) => {
    needStaff(user);
    const bookingToAssign = db.prepare('SELECT paid, payment_status FROM bookings WHERE id = ?').get(id);
    if (!bookingToAssign) throw new HttpError(404, 'Réservation introuvable.');
    if (production && (!bookingToAssign.paid || !['paye', 'garantie'].includes(bookingToAssign.payment_status))) throw new HttpError(409, 'Paiement confirmé requis avant attribution.');
    if (body.worker_id === 'auto') {
      db.prepare("DELETE FROM offers WHERE booking_id = ? AND state = 'offered'").run(id);
      const r = engine.assign(db, id);
      return { ...r, message: r.status === 'en_attente' ? 'Personne de disponible : la réservation reste à traiter.' : 'Attribution automatique relancée.' };
    }
    const r = engine.assignTo(db, id, Number(body.worker_id));
    if (r.error) throw new HttpError(409, r.error);
    return r;
  });

  // ---------- serveur ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
        if (!stripeReady) throw new HttpError(503, 'Stripe indisponible.');
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 200_000) throw new HttpError(413, 'Payload trop grand.'); chunks.push(chunk); }
        const raw = Buffer.concat(chunks);
        let event;
        try { event = stripePay.verifyEvent(raw, req.headers['stripe-signature']); }
        catch { throw new HttpError(400, 'Signature Stripe invalide.'); }
        if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && event.data.object.payment_status === 'paid') {
          const sess = event.data.object;
          const gift = db.prepare('SELECT * FROM gift_cards WHERE session_id = ?').get(sess.id);
          if (gift && sess.currency === 'eur' && sess.amount_total === gift.amount_cents) fulfillGift(gift.id);
          const tip = db.prepare('SELECT * FROM tips WHERE session_id = ?').get(sess.id);
          if (tip && sess.currency === 'eur' && sess.amount_total === tip.amount_cents) fulfillTip(tip.id);
          const payment = db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(sess.id);
          if (payment && payment.status !== 'paid' && sess.currency === 'eur' && sess.amount_total === payment.amount_cents) {
            const ids = JSON.parse(payment.booking_ids);
            const alreadyPaid = ids.some((id) => {
              const b = db.prepare('SELECT paid FROM bookings WHERE id = ?').get(id);
              return b && b.paid;
            });
            if (alreadyPaid) {
              // Never hide an actual second charge. Record it for manual refund/reconciliation.
              const dupPi = typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.payment_intent?.id || null;
              db.prepare("UPDATE stripe_payments SET status = 'duplicate_paid', payment_intent = ? WHERE session_id = ?").run(dupPi, sess.id);
              await refundDuplicateCharge({ paymentIntent: dupPi, amountCents: sess.amount_total, sessionId: sess.id, ids, clientId: payment.client_id });
            } else {
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare("UPDATE stripe_payments SET status = 'paid', payment_intent = ? WHERE session_id = ?").run(typeof sess.payment_intent === 'string' ? sess.payment_intent : null, sess.id);
              for (const id of ids) {
                const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
                if (b && b.client_id === payment.client_id && !b.paid) {
                  if (b.status === 'annulee') db.prepare("UPDATE bookings SET paid = 1, payment_status = 'a_rembourser', refund_amount = total WHERE id = ?").run(id);
                  else db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye' WHERE id = ?").run(id);
                }
                const legacyPi = typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.payment_intent?.id;
                if (legacyPi) db.prepare('INSERT OR IGNORE INTO stripe_claims (booking_id, payment_intent) VALUES (?, ?)').run(id, legacyPi);
              }
              db.exec('COMMIT');
            } catch (e) { db.exec('ROLLBACK'); throw e; }
            }
            for (const id of ids) {
              const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
              if (b && b.payment_status === 'paye' && b.status === 'en_attente') {
                db_.log(db, `Réservation n° ${id} payée : attribution manuelle nécessaire.`);
              }
            }
            if (!alreadyPaid) afterPaid(ids);
            await stripePay.expireOtherSessions(db, ids, sess.id);
            await reconcileDuplicateIntents(ids);
          }
        }
        // Prélèvement SEPA : mandat signé, puis prélèvement des relevés de fin de mois
        if (event.type === 'checkout.session.completed' && event.data.object.mode === 'setup' && event.data.object.metadata?.sepa_user) {
          await activateMandate(event.data.object);
        }
        if (['payment_intent.succeeded', 'payment_intent.payment_failed'].includes(event.type) && event.data.object?.metadata?.bill_id) {
          const pi = event.data.object;
          const bill = db.prepare('SELECT * FROM transfer_bills WHERE id = ? AND stripe_pi = ?').get(Number(pi.metadata.bill_id), pi.id);
          if (bill && !bill.paid_at && event.type === 'payment_intent.succeeded' && pi.amount_received === bill.total_cents) {
            db.prepare("UPDATE transfer_bills SET paid_at = ?, debit_status = 'paye' WHERE id = ?").run(now().toISOString(), bill.id);
            db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye_prelevement' WHERE bill_id = ?").run(bill.id);
            db_.log(db, `Prélèvement reçu pour le relevé ${bill.ref} (${bill.total_cents / 100} €).`);
          }
          if (bill && !bill.paid_at && event.type === 'payment_intent.payment_failed') {
            db.prepare("UPDATE transfer_bills SET debit_status = 'echoue' WHERE id = ?").run(bill.id);
            const c = db.prepare('SELECT email, name FROM users WHERE id = ?').get(bill.client_id);
            db_.log(db, `PRÉLÈVEMENT REJETÉ pour le relevé ${bill.ref} (${c ? c.name : '?'}) : ${String(pi.last_payment_error?.message || '').slice(0, 200)}`);
            for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin' AND (staff_level IS NULL OR staff_level <> 'planning')").all()) {
              mailer.send(a.email, `Prélèvement rejeté : ${bill.ref}`, 'Prélèvement rejeté', [`${c ? c.name : 'Le client'} : le prélèvement de ${(bill.total_cents / 100).toFixed(2).replace('.', ',')} € a été rejeté par sa banque.`, 'Appelez le client, puis relancez le prélèvement ou demandez un virement depuis Admin → Paiements.'], null);
            }
            if (c) mailer.send(c.email, `Prélèvement rejeté : ${bill.ref}`, 'Votre prélèvement a été rejeté', [`Bonjour ${c.name.split(' ')[0]},`, `Le prélèvement du relevé ${bill.ref} (${(bill.total_cents / 100).toFixed(2).replace('.', ',')} €) a été rejeté par votre banque.`, 'Vérifiez votre compte ou mettez à jour votre IBAN, puis nous relancerons le prélèvement.'], { label: 'Mettre à jour mon IBAN', path: '/#/prelevement' });
          }
        }
        // Paiement en deux temps : montant bloqué, pas encore encaissé.
        if (event.type === 'payment_intent.amount_capturable_updated' && typeof event.data.object?.id === 'string') {
          await settleIntent(event.data.object.id);
        }
        if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'unpaid') {
          const sp = event.data.object.payment_intent;
          const piId = typeof sp === 'string' ? sp : sp?.id;
          if (piId && db.prepare('SELECT 1 FROM stripe_payments WHERE session_id = ?').get(event.data.object.id)) await settleIntent(piId);
        }
        // Filet de sécurité : le même lien Stripe ouvert dans deux onglets peut produire
        // un deuxième encaissement sans deuxième session. Chaque PaymentIntent réussi est noté,
        // puis comparé au paiement retenu pour la réservation.
        if (event.type === 'payment_intent.succeeded') {
          const pi = event.data.object;
          let ids = [];
          try { ids = JSON.parse(pi?.metadata?.booking_ids || '[]'); } catch { ids = []; }
          ids = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
          if (pi && typeof pi.id === 'string' && ids.length && pi.currency === 'eur' && Number.isSafeInteger(pi.amount_received) && pi.amount_received > 0) {
            db.prepare('INSERT OR IGNORE INTO stripe_intents_seen (payment_intent, booking_ids, amount_cents) VALUES (?, ?, ?)').run(pi.id, JSON.stringify(ids), pi.amount_received);
            await reconcileDuplicateIntents(ids);
          }
        }
        if (event.type === 'refund.updated') {
          const refund = event.data.object;
          if (refund && typeof refund.id === 'string') {
            if (refund.status === 'succeeded') db.prepare("UPDATE bookings SET payment_status = 'rembourse' WHERE refund_id = ? AND payment_status = 'remboursement_en_cours'").run(refund.id);
            if (['failed', 'canceled'].includes(refund.status)) db.prepare("UPDATE bookings SET payment_status = 'a_rembourser' WHERE refund_id = ? AND payment_status = 'remboursement_en_cours'").run(refund.id);
          }
        }
        if (['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'].includes(event.type)) {
          onDispute(event.type, event.data.object);
        }
        if (event.type === 'checkout.session.async_payment_failed') {
          db.prepare("UPDATE stripe_payments SET status = 'failed' WHERE session_id = ? AND status = 'pending'").run(event.data.object.id);
        }
        if (event.type === 'checkout.session.expired') {
          db.prepare("UPDATE stripe_payments SET status = 'expired' WHERE session_id = ? AND status = 'pending'").run(event.data.object.id);
        }
        return send(res, 200, { received: true });
      }
      // Désinscription des relances : la page demande une confirmation (les robots qui ouvrent les liens ne désinscrivent personne) ;
      // Gmail et Yahoo envoient un POST « un clic » (RFC 8058), accepté directement.
      if (url.pathname === '/desinscription') {
        const uid = Number(url.searchParams.get('u'));
        const t = String(url.searchParams.get('t') || '');
        const valid = Number.isSafeInteger(uid) && uid > 0 && t.length === 32 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(unsubToken(uid)));
        const page = (msg, form = '') => {
          res.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
          res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proprigo · désinscription</title>
<style>body{font:16px/1.5 Arial,sans-serif;color:#0f1430;background:#f2f5ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border-radius:18px;padding:28px;max-width:440px}b.logo{color:#1f4fff;font-size:22px}button{background:#1f4fff;color:#fff;border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer}</style></head>
<body><main><b class="logo">proprigo</b><p>${msg}</p>${form}</main></body></html>`);
        };
        if (!valid) return page('Ce lien de désinscription n\'est pas valable.');
        if (req.method === 'POST') {
          db.prepare('UPDATE users SET marketing_optout = 1 WHERE id = ?').run(uid);
          db_.log(db, `Client n° ${uid} désinscrit des relances.`);
          return page('C\'est fait : vous ne recevrez plus nos rappels. Les e-mails liés à vos réservations (confirmations, factures) continuent d\'arriver.');
        }
        return page('Ne plus recevoir nos rappels « On repasse faire briller chez vous ? » ?', `<form method="post"><button>Me désinscrire</button></form>`);
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) throw new HttpError(403, 'Requête refusée : origine non autorisée.');
        if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Contenu JSON attendu.');
        }
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new HttpError(404, 'Introuvable.');
        const id = Number((url.pathname.match(r.re) || [])[1]);
        const body = req.method === 'POST' ? await readBody(req, /\/photos$/.test(url.pathname) ? 4_000_000 : url.pathname === '/api/worker/documents' ? 7_000_000 : 100_000) : {};
        const out = await r.handler({ req, res, body, id, query: url.searchParams, user: currentUser(req), ip: clientIp(req) });
        if (out && out.streamed) return;
        if (out && out.data !== undefined && (out.status || out.headers)) return send(res, out.status || 200, out.data, out.headers);
        return send(res, 200, out);
      }
      // pages pour Google : /menage-a-domicile/paris-11, plan du site, robots.txt
      if (req.method === 'GET' || req.method === 'HEAD') {
        const base = appUrl.replace(/\/$/, '');
        const seoHead = { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'none'", 'Cache-Control': 'public, max-age=3600' };
        if (url.pathname === '/sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', ...seoHead }); return res.end(seo.sitemap(base)); }
        // application Android (Trusted Web Activity) : prouve que l'appli et le site appartiennent à Proprigo
        if (url.pathname === '/.well-known/assetlinks.json') {
          const pkg = String(process.env.ANDROID_PACKAGE || 'fr.proprigo.app').trim();
          const prints = String(process.env.ANDROID_CERT_SHA256 || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x));
          const body = prints.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: prints } }] : [];
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify(body));
        }
        // page publique exigée par Google Play et l'App Store : comment supprimer son compte
        if (url.pathname === '/suppression-compte') {
          const contact = String(mail.replyTo || process.env.EMAIL_REPLY_TO || 'contact@proprigo.fr').replace(/^.*<|>.*$/g, '').replace(/[^\w.@+-]/g, '');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...seoHead });
          return res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supprimer son compte – Proprigo</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#14204a}h1{font-size:28px}a{color:#1f4fff}</style></head><body>
<h1>Supprimer votre compte Proprigo</h1>
<p><b>Dans l'application ou sur proprigo.fr</b> : connectez-vous, ouvrez « Mon compte », puis « Supprimer mon compte » en bas de la page, et confirmez avec votre mot de passe. Les ménages à venir doivent d'abord être annulés.</p>
<p><b>Sans accès à votre compte</b> : écrivez à <a href="mailto:${contact}?subject=Suppression%20de%20mon%20compte">${contact}</a> depuis l'adresse e-mail du compte. Nous le supprimons sous 30 jours au plus.</p>
<h2>Ce qui est supprimé</h2>
<p>Votre nom, e-mail, téléphone, logements, consignes d'accès, photos et abonnements aux notifications.</p>
<h2>Ce qui est conservé</h2>
<p>Les factures des ménages passés, sans vos coordonnées, pendant 10 ans, parce que la loi l'impose (article L123-22 du Code de commerce).</p>
<p><a href="/">Retour à Proprigo</a></p></body></html>`);
        }
        if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...seoHead }); return res.end(seo.robots(base)); }
        const m = url.pathname.match(/^\/(menage-a-domicile|menage-airbnb|nettoyage-bureaux)\/([a-z0-9-]+)\/?$/);
        if (m) {
          const html = seo.page(m[1], m[2], base);
          if (html) {
            if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
              const gz = zlib.gzipSync(html);
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...seoHead, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
              return res.end(gz);
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...seoHead, Vary: 'Accept-Encoding' }); return res.end(html);
          }
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable.');
        }
      }
      // fichiers du site : compressés (gzip) et mis en cache par le navigateur.
      // HTML, JS et CSS sont revérifiés à chaque visite (ETag) : une mise à jour se voit tout de suite.
      let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'Interdit.');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
      const st = fs.statSync(file);
      const ext = path.extname(file);
      const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const longCache = ext === '.woff' || ext === '.woff2' || url.pathname.startsWith('/fonts/');
      const headers = {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:",
        'Cache-Control': longCache ? 'public, max-age=31536000, immutable' : ['.png', '.svg', '.ico'].includes(ext) ? 'public, max-age=604800' : 'no-cache',
        ETag: etag, Vary: 'Accept-Encoding',
      };
      // La page d'accueil appelle app.js, art.js et styles.css avec le numéro de version (?v=1.5.9) :
      // après une mise en ligne, aucun navigateur ne peut garder l'ancien code en mémoire.
      if (path.basename(file) === 'index.html') {
        const html = fs.readFileSync(file, 'utf8').replace(/(src|href)="\/(app\.js|art\.js|i18n\.js|styles\.css)"/g, `$1="/$2?v=${VERSION}"`)
          .replace('</head>', `<meta name="proprigo-version" content="${VERSION}">\n</head>`);
        const out = /\bgzip\b/.test(req.headers['accept-encoding'] || '') ? zlib.gzipSync(html) : Buffer.from(html);
        const { ETag: _omit, ...pageHeaders } = headers;
        res.writeHead(200, { ...pageHeaders, 'Cache-Control': 'no-store', ...(out.length !== Buffer.byteLength(html) ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': out.length });
        return res.end(req.method === 'HEAD' ? undefined : out);
      }
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      const compressible = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg)/.test(headers['Content-Type']);
      if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        const key = `${file}|${etag}`;
        let gz = gzCache.get(key);
        if (!gz) { gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 }); gzCache.set(key, gz); }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
        return res.end(req.method === 'HEAD' ? undefined : gz);
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      reportError(`${req.method} ${(req.url || '').split('?')[0]}`, e);
      if (res.headersSent) return res.end();
      return send(res, 500, { error: 'Erreur interne. L\'équipe est prévenue.' });
    }
  });

  if (autoSync) {
    const run = async () => {
      if (production && !stripeReady) return; // sans paiement en ligne, aucune mission Airbnb n'est créée
      for (const h of db.prepare('SELECT * FROM homes WHERE ical_url IS NOT NULL').all()) {
        try { await ical.syncHome(db, h, syncOptions()); } catch (e) {
          db.prepare("UPDATE homes SET last_sync = datetime('now'), last_sync_result = ? WHERE id = ?").run('Erreur : ' + e.message, h.id);
        }
      }
    };
    setTimeout(run, 30_000).unref();
    setInterval(run, 6 * 3600e3).unref();
  }

  /** Rappel la veille du ménage, envoyé une seule fois. */
  // rappel la veille, à partir de 17 h (jamais en pleine nuit) : e-mail + notification au client et à l'intervenante
  const REMINDER_FROM = 17;
  const runReminders = ({ force = false } = {}) => {
    if (!force && Number(nowParisHM().slice(0, 2)) < REMINDER_FROM) return 0;
    const tomorrow = new Date(Date.parse(pricing.todayParis(now()) + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
    const list = db.prepare("SELECT * FROM bookings WHERE date = ? AND reminded = 0 AND status IN ('en_attente','proposee','attribuee')").all(tomorrow);
    for (const b of list) {
      const w = b.worker_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(b.worker_id) : null;
      const who = w ? displayName(w.name) : null;
      const home = b.home_id ? db.prepare('SELECT instructions FROM homes WHERE id = ?').get(b.home_id) : null;
      const access = home && home.instructions ? 'Vos consignes d\'accès sont transmises à l\'intervenante.' : 'Pensez à prévoir l\'accès : clés, code de la porte, ou quelqu\'un sur place.';
      mailer.send(emailOf(b.client_id), `Rappel : votre ménage demain à ${b.time}`, 'Votre ménage, c\'est demain', [`${fr(b.date)} à ${b.time}, ${b.address}.`, who ? `${who}, intervenante vérifiée, viendra.` : 'Nous vous confirmons l\'intervenante très vite.', access], { label: 'Voir ma réservation', url: `${appUrl || ''}/#/mes-reservations` });
      pushAll(db, b.client_id, { title: `🧽 Demain à ${b.time}`, body: `${who ? `${who.split(' ')[0]} vient chez vous` : 'Votre ménage est prévu'}. ${home && home.instructions ? '' : 'Pensez aux clés ou au code.'}`.trim(), url: '/#/mes-reservations', tag: `rappel-${b.id}` }).catch(() => {});
      if (b.worker_id) {
        mailer.send(emailOf(b.worker_id), `Rappel : mission demain à ${b.time}`, 'Votre mission de demain', [`${fr(b.date)} à ${b.time}, ${b.cp}.`, "L'adresse, les consignes et la checklist sont dans votre espace."], { label: 'Voir mes missions', url: `${appUrl || ''}/#/intervenante` });
        pushAll(db, b.worker_id, { title: `🚶 Mission demain à ${b.time}`, body: `${b.cp} · ${b.hours} h. Les consignes sont dans l'application.`, url: '/#/intervenante', tag: `rappel-w-${b.id}` }).catch(() => {});
      }
      db.prepare('UPDATE bookings SET reminded = 1 WHERE id = ?').run(b.id);
    }
    return list.length;
  };
  if (autoSync) {
    setInterval(() => { try { runNudges(); } catch (e) { console.error('Relances :', e.message); } }, 24 * 3600e3).unref();
    setTimeout(() => { try { runDocExpiry(); } catch (e) { console.error('Documents :', e.message); } }, 90_000).unref();
    setInterval(() => { try { runDocExpiry(); } catch (e) { console.error('Documents :', e.message); } }, 24 * 3600e3).unref();
    setInterval(() => { try { purgePhotos(); purgeAttempts(); purgeRejectedDocs(); } catch (e) { console.error('Nettoyage quotidien :', e.message); } }, 24 * 3600e3).unref();
    setInterval(() => { mailer.processQueue().catch((e) => console.error('File des e-mails :', e.message)); }, 5 * 60e3).unref();
    setTimeout(runReminders, 60_000).unref();
    setInterval(runReminders, 3600e3).unref();
  }

  return { server, db, runReminders, runBackup, purgePhotos, reportError, runNudges, runDocExpiry };
}

module.exports = { createApp };
