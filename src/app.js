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

function createApp({ dbFile = ':memory:', adminPassword = 'proprigo-admin', seed = true, secureCookies = false, production = false, paymentsEnabled = false, photosDir = null, icalAllowAny = false, icalFetch = undefined, autoSync = false, mail = {}, appUrl = 'http://localhost:3000', now = () => new Date(), backupDir = null, googleReviewUrl = '' } = {}) {
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
    provider: mail.provider, apiKey: mail.apiKey, from: mail.from, appUrl, db,
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
    return db.prepare('SELECT id, role, email, name, phone, staff_level, email_verified_at IS NOT NULL AS email_verified FROM users WHERE id = ?').get(s.user_id) || null;
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
  const bookingView = (b) => {
    const w = b.worker_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(b.worker_id) : null;
    const photos = db.prepare('SELECT id, kind FROM photos WHERE booking_id = ? ORDER BY id').all(b.id);
    const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE booking_id = ?').get(b.id).n;
    const inc = db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE booking_id = ? AND resolved = 0').get(b.id).n;
    let list = [];
    try { list = JSON.parse(b.checklist || '[]'); } catch { list = []; }
    return { ...b, worker_name: w ? w.name : null, checklist: list, photos, messages: msgs, incidents: inc };
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
    const data = { ok, version: VERSION, uptimeMinutes: Math.round((Date.now() - started) / 60e3), database: dbOk ? 'ok' : 'erreur', backup: !backupDir ? 'désactivée' : backupOk ? 'ok' : 'en retard', erreurs24h: db.prepare("SELECT COUNT(*) AS n FROM server_errors WHERE at >= datetime('now', '-1 day')").get().n, factures: companyMissing.length ? `à compléter (config/entreprise.json : ${companyMissing.join(', ')})` : 'ok', backupExterne: !offsite.configured ? 'non configurée' : offsite.ok ? 'ok' : offsite.ok === false ? 'en échec' : 'en attente' };
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
      db.prepare('INSERT INTO workers (user_id, statut, cp, rate) VALUES (?, ?, ?, ?)').run(id, statut, cp, rate);
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
    return db.prepare("SELECT * FROM quote_requests ORDER BY CASE status WHEN 'nouveau' THEN 0 ELSE 1 END, id DESC LIMIT 50").all().map((q) => ({ ...q, kindLabel: QUOTE_KINDS[q.kind] }));
  });
  route('POST', '/api/admin/quote-requests/:id/done', ({ user, id }) => {
    needStaff(user);
    db.prepare("UPDATE quote_requests SET status = 'traite' WHERE id = ?").run(id);
    return { ok: true, message: 'Demande marquée comme traitée.' };
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
      const pid = engine.preferredIds(db, { client_id: user.id, home_id: homeId, series_id: null })[0];
      if (pid) preferred = { id: pid, name: engine.firstName(db, pid), slots: engine.slotsFor(db, pid, { date, cp, hours }).filter(later) };
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
      throw new HttpError(502, 'Paiement indisponible. Réessayez.');
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
  db.exec(`CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('facture','avoir')), year INTEGER NOT NULL, seq INTEGER NOT NULL,
    number TEXT NOT NULL UNIQUE, booking_id INTEGER NOT NULL, client_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, tva_rate REAL NOT NULL,
    ref_invoice TEXT, refund_key TEXT UNIQUE, issued_at TEXT NOT NULL, UNIQUE(kind, year, seq))`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_facture ON invoices(booking_id) WHERE kind = 'facture'");
  const company = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'entreprise.json'), 'utf8')); } catch { return {}; }
  })();
  const companyMissing = ['raisonSociale', 'adresse', 'siret'].filter((k) => !String(company[k] || '').trim());
  const tvaOf = (b) => (pricing.PRO_SERVICES.includes(b.service) ? pricing.COSTS.tvaPro : pricing.COSTS.tvaParticulier);
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
    if (!b || !b.paid) return null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const n = nextNumber('facture');
      db.prepare("INSERT INTO invoices (kind, year, seq, number, booking_id, client_id, amount_cents, tva_rate, issued_at) VALUES ('facture', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(n.year, n.seq, n.number, b.id, b.client_id, Math.round((b.total + (b.discount || 0)) * 100), tvaOf(b), now().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '${stripeReady ? 'en_attente_paiement' : 'simule'}', ?, ?, ?, ?)`).run(
        user.id, q.service, q.size, q.hours, body.cp, address, date, time, k === 0 && body.urgent ? 1 : 0, body.kit ? 1 : 0, qk.total, q.zone, seriesId, tasks, consent, home ? home.id : null);
      const id = Number(r.lastInsertRowid);
      if (discount) db.prepare('UPDATE bookings SET discount = ? WHERE id = ?').run(discount, id);
      if (q.extras && q.extras.length) db.prepare('UPDATE bookings SET extras = ? WHERE id = ?').run(JSON.stringify(q.extras), id);
      // entièrement réglé par le crédit : rien à payer
      if (stripeReady && qk.total === 0) db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye' WHERE id = ?").run(id);
      ids.push(id);
      db_.log(db, `Réservation n° ${id} créée, paiement ${stripeReady ? 'en attente' : 'simulé'} : ${qk.total} €, ${body.cp}, ${date} ${time}.`);
      if (!stripeReady && !production) engine.assign(db, id); // mode démonstration seulement
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
        throw new HttpError(502, 'Impossible de démarrer le paiement Stripe. Réessayez.');
      }
    }
    const first = bookingView(db.prepare('SELECT * FROM bookings WHERE id = ?').get(ids[0]));
    notifyTeamNewBooking(ids, { paidBy: 'paiement simulé (démonstration)' });
    mailer.send(user.email, `Réservation confirmée : ${fr(first.date)} à ${first.time}`, 'Votre ménage est réservé',
      [`${fr(first.date)} à ${first.time}, ${first.address} (${first.cp}).`, `Prix : ${first.total} € TTC${ids.length > 1 ? `, puis ${ids.length - 1} autre(s) ménage(s) récurrent(s)` : ''}.`,
        first.worker_name ? `Votre intervenante : ${first.worker_name.split(' ')[0]}, intervenante vérifiée.` : 'Nous vous indiquerons le nom de votre intervenante dès que possible.',
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
      const v = bookingView(b);
      const pid = engine.preferredIds(db, b)[0];
      return pid ? { ...v, preferred_id: pid, preferred_name: engine.firstName(db, pid) } : v;
    });
  });

  route('POST', '/api/bookings/:id/cancel', ({ user, id }) => {
    need(user, 'client');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    if (!['en_attente', 'proposee', 'attribuee'].includes(b.status)) throw new HttpError(409, 'Cette réservation ne peut plus être annulée.');
    const refund = refundFor(b);
    db.prepare("UPDATE bookings SET status = 'annulee', refund_amount = ?, payment_status = CASE WHEN payment_status = 'paye' OR payment_status = 'simule' THEN 'a_rembourser' ELSE payment_status END WHERE id = ?").run(refund, id);
    db.prepare('DELETE FROM offers WHERE booking_id = ?').run(id);
    db_.log(db, `Réservation n° ${id} annulée par le client : ${refund} € à rembourser${refund < b.total ? ' (annulation à moins de 24 h)' : ''}.`);
    const late = refund < b.total;
    mailer.send(user.email, 'Réservation annulée', 'Votre réservation est annulée', [`Ménage du ${fr(b.date)} à ${b.time}.`, late ? `Annulation à moins de ${FREE_CANCEL_HOURS} h : ${refund} € vous seront remboursés sur ${b.total} €.` : `Vous serez remboursé de ${refund} €.`]);
    if (b.worker_id) mailer.send(emailOf(b.worker_id), 'Mission annulée', 'Une mission est annulée', [`Le ménage du ${fr(b.date)} à ${b.time} (${b.cp}) est annulé par le client.`]);
    return { ok: true, refund, message: late ? `Réservation annulée. ${refund} € vous seront remboursés (annulation à moins de ${FREE_CANCEL_HOURS} h).` : `Réservation annulée. ${refund} € vous seront remboursés.` };
  });

  route('POST', '/api/bookings/:id/rate', ({ user, id, body }) => {
    need(user, 'client');
    const stars = Number(body.stars);
    if (![1, 2, 3, 4, 5].includes(stars)) throw new HttpError(400, 'Note de 1 à 5.');
    const review = str(body.review, 500) || null;
    const r = db.prepare("UPDATE bookings SET rating = ?, review = ? WHERE id = ? AND client_id = ? AND status = 'terminee' AND rating IS NULL").run(stars, review, id, user.id);
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
    return { profile: { ...w, reject_reason: undefined }, steps: db_.STEPS[w.statut], active: engine.isActive(w), offers: safeOffers, missions: missions.map((m) => { const h = m.home_id ? db.prepare('SELECT name, instructions FROM homes WHERE id = ?').get(m.home_id) : null; return { ...bookingView(m), client_name: m.client_name, home_name: h ? h.name : null, instructions: h ? h.instructions : null }; }), done, availability: cal, timeoff: off };
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
    } catch { throw new HttpError(502, 'Paiement indisponible. Réessayez.'); }
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
  route('GET', '/api/config', () => ({ googleReviewUrl: reviewUrl, prices: pricing.publicPrices(), openDepts: [...pricing.OPEN_DEPTS] }));

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
  const BONUS_PER_HOUR = 1; // 1 € de plus par heure pour une note moyenne d'au moins 4,8 sur les 10 derniers avis (5 au moins)
  const mondayOf = (d) => { const t = new Date(d + 'T12:00:00Z'); const wd = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - wd * 864e5).toISOString().slice(0, 10); };
  const bonusOf = (wid) => {
    const r = db.prepare("SELECT rating FROM bookings WHERE worker_id = ? AND status = 'terminee' AND rating IS NOT NULL ORDER BY date DESC, id DESC LIMIT 10").all(wid);
    const avg = r.length ? r.reduce((t, x) => t + x.rating, 0) / r.length : 0;
    return { eligible: r.length >= 5 && avg >= 4.8, avg: r.length ? Math.round(avg * 10) / 10 : null, count: r.length, perHour: BONUS_PER_HOUR };
  };
  const paidIds = () => new Set(db.prepare('SELECT booking_ids FROM payouts').all().flatMap((p) => JSON.parse(p.booking_ids)));
  const owedFor = (wid) => {
    const w = workerProfile(wid);
    if (!w || w.statut !== 'I') return [];
    const done = paidIds();
    const bonus = bonusOf(wid);
    const rows = db.prepare("SELECT id, date, hours FROM bookings WHERE worker_id = ? AND status = 'terminee' ORDER BY date").all(wid).filter((b) => !done.has(b.id));
    const weeks = new Map();
    for (const b of rows) {
      const k = mondayOf(b.date);
      if (!weeks.has(k)) weeks.set(k, { week_start: k, hours: 0, ids: [] });
      const x = weeks.get(k); x.hours += b.hours; x.ids.push(b.id);
    }
    return [...weeks.values()].map((x) => {
      const bonusRate = bonus.eligible ? bonus.perHour : 0;
      return { worker_id: wid, name: w.name, week_start: x.week_start, hours: x.hours, rate: w.rate, bonus_rate: bonusRate, amount: Math.round(x.hours * (w.rate + bonusRate) * 100) / 100, booking_ids: x.ids };
    });
  };
  route('GET', '/api/admin/payouts', ({ user }) => {
    need(user, 'admin');
    const ind = db.prepare("SELECT user_id FROM workers WHERE statut = 'I'").all();
    const today = pricing.todayParis(now());
    const owed = ind.flatMap((w) => owedFor(w.user_id)).map((o) => ({ ...o, weekOver: o.week_start < mondayOf(today) }));
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
    db.prepare('INSERT INTO payouts (worker_id, week_start, hours, rate, bonus_rate, amount, booking_ids, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(wid, week, o.hours, o.rate, o.bonus_rate, o.amount, JSON.stringify(o.booking_ids), reference, user.id);
    mailer.send(emailOf(wid), `Versement de ${o.amount.toFixed(2).replace('.', ',')} €`, 'Votre versement Proprigo', [`Semaine du ${fr(week)} : ${String(o.hours).replace('.', ',')} h × ${o.rate} €${o.bonus_rate ? ` + bonus qualité ${o.bonus_rate} €/h` : ''}.`, `Montant : ${o.amount.toFixed(2).replace('.', ',')} €${reference ? ` (référence ${reference})` : ''}.`], { label: 'Voir mes gains', path: '/#/intervenante' });
    db_.log(db, `Versement de ${o.amount} € à ${o.name} pour la semaine du ${week}.`);
    return { ok: true, message: `${o.amount.toFixed(2).replace('.', ',')} € marqués comme versés à ${o.name.split(' ')[0]}.` };
  });

  // ----- intervenante : mes gains -----
  route('GET', '/api/worker/earnings', ({ user }) => {
    need(user, 'intervenante');
    const w = workerProfile(user.id);
    const m0 = pricing.todayParis(now()).slice(0, 7);
    const prev = new Date(Date.parse(m0 + '-15T12:00:00Z') - 30 * 864e5).toISOString().slice(0, 7);
    const sum = (where, ...args) => db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS h FROM bookings WHERE worker_id = ? AND ${where}`).get(user.id, ...args);
    const pack = (r) => ({ n: r.n, h: r.h, eur: w.statut === 'I' ? Math.round(r.h * (w.rate || 0) * 100) / 100 : null });
    const months = db.prepare("SELECT substr(date, 1, 7) AS m, COUNT(*) AS n, SUM(hours) AS h FROM bookings WHERE worker_id = ? AND status = 'terminee' GROUP BY m ORDER BY m DESC LIMIT 6").all(user.id);
    return {
      statut: w.statut, rate: w.rate,
      month: pack(sum("status = 'terminee' AND substr(date, 1, 7) = ?", m0)),
      lastMonth: pack(sum("status = 'terminee' AND substr(date, 1, 7) = ?", prev)),
      upcoming: pack(sum("status IN ('attribuee','en_cours') AND date >= ?", pricing.todayParis(now()))),
      history: months.map((r) => ({ month: r.m, ...pack(r) })),
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
<p class="warn"><b>Document provisoire.</b> Cette attestation ne vaut pour le crédit d'impôt qu'une fois Proprigo déclaré « services à la personne » (n° [À COMPLÉTER]). Les ménages de logements de location courte durée et le nettoyage de bureaux n'y ouvrent pas droit et ne sont pas listés.</p>
<h1>Attestation fiscale annuelle ${year}</h1>
<p>Proprigo, [RAISON SOCIALE, ADRESSE, SIRET] atteste que <b>${e(user.name)}</b> a bénéficié des prestations de ménage à domicile suivantes, réglées en ${year} :</p>
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
      notes: db.prepare("SELECT n.id, n.text, n.created_at, u.name AS author FROM admin_notes n JOIN users u ON u.id = n.author_id WHERE kind = 'client' AND target_id = ? ORDER BY n.id DESC").all(id),
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
  route('POST', '/api/admin/notes', ({ user, body }) => {
    needStaff(user);
    const kind = body.kind === 'worker' ? 'worker' : body.kind === 'client' ? 'client' : null;
    const target = Number(body.target_id);
    const text = str(body.text, 1000);
    if (!kind || !target || text.length < 2) throw new HttpError(400, 'Note vide.');
    db.prepare('INSERT INTO admin_notes (kind, target_id, author_id, text) VALUES (?, ?, ?, ?)').run(kind, target, user.id, text);
    return { ok: true, message: 'Note enregistrée.' };
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
  for (const step of ['onway', 'arrived']) route('POST', `/api/worker/missions/:id/${step}`, ({ user, id }) => {
    need(user, 'intervenante');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND worker_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Mission introuvable.');
    if (b.status !== 'attribuee') throw new HttpError(409, 'Cette mission a déjà commencé ou est terminée.');
    if (b.date !== pricing.todayParis(now())) throw new HttpError(409, 'Ce bouton sert le jour de la mission.');
    const first = user.name.split(' ')[0];
    if (step === 'onway') {
      if (b.on_way_at) return { ok: true, message: 'Le client sait déjà que vous êtes en route.' };
      db.prepare("UPDATE bookings SET on_way_at = datetime('now') WHERE id = ?").run(id);
      engine.notify(db, id, `${first} est en route vers votre logement.`);
      return { ok: true, message: 'Le client est prévenu que vous êtes en route.' };
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
    return { id, firstName: w.name.split(' ')[0], since: w.created_at.slice(0, 7), missions: st.n, rating: st.rated ? Math.round(st.avg * 10) / 10 : null, ratings: st.rated, languages: w.languages || '', bio: w.bio || '', reviews };
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
      WHERE b.client_id = ? AND b.status = 'terminee' GROUP BY u.id ORDER BY n DESC`).all(user.id);
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

  // ----- documents des intervenantes : déposés par elles, vérifiés par le responsable -----
  // Fichiers privés, hors du dossier public, jamais servis à un client. Lisibles par l'intervenante et le responsable seulement.
  const DOCS = dbFile === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-docs-')) : path.join(path.dirname(dbFile), 'documents');
  fs.mkdirSync(DOCS, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS worker_docs (id INTEGER PRIMARY KEY, worker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    file TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'a_verifier' CHECK (status IN ('a_verifier','valide','refuse')),
    note TEXT, uploaded_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_by INTEGER, reviewed_at TEXT)`);
  for (const [c, t] of [['rejected_at', 'TEXT'], ['reject_reason', 'TEXT']]) if (!db.prepare('PRAGMA table_info(workers)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE workers ADD COLUMN ${c} ${t}`);
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
  const kindsFor = (statut) => Object.entries(DOC_KINDS).filter(([, v]) => v.for.includes(statut)).map(([k, v]) => ({ kind: k, label: v.label, required: v.required }));
  function docsOf(workerId) {
    const w = db.prepare('SELECT statut FROM workers WHERE user_id = ?').get(workerId);
    if (!w) return null;
    const rows = db.prepare('SELECT id, kind, mime, size, status, note, uploaded_at, reviewed_at FROM worker_docs WHERE worker_id = ? ORDER BY id DESC').all(workerId);
    const list = kindsFor(w.statut).map((k) => ({ ...k, latest: rows.find((r) => r.kind === k.kind) || null }));
    const missing = list.filter((k) => k.required && (!k.latest || k.latest.status !== 'valide')).map((k) => k.label);
    return { list, missing, complete: missing.length === 0 };
  }
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
    if (!DOC_KINDS[kind] || !DOC_KINDS[kind].for.includes(w.statut)) throw new HttpError(400, 'Type de document inconnu.');
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
    db.prepare('INSERT INTO worker_docs (worker_id, kind, file, mime, size) VALUES (?, ?, ?, ?, ?)').run(user.id, kind, file, mime, buf.length);
    db_.log(db, `${user.name} a déposé : ${DOC_KINDS[kind].label}. À vérifier.`);
    return { ok: true, message: 'Document reçu. L\'équipe le vérifie rapidement.', ...docsOf(user.id) };
  });
  route('GET', '/api/documents/:id', ({ user, id, res }) => {
    const d = db.prepare('SELECT * FROM worker_docs WHERE id = ?').get(id);
    if (!d || !user || !(d.worker_id === user.id || isOwner(user))) throw new HttpError(404, 'Document introuvable.');
    const f = path.join(DOCS, path.basename(d.file));
    if (!fs.existsSync(f)) throw new HttpError(404, 'Fichier introuvable.');
    if (isOwner(user) && d.worker_id !== user.id) db_.log(db, `Document n° ${d.id} (${DOC_KINDS[d.kind]?.label || d.kind}) consulté par ${user.name}.`);
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
    const w = workerProfile(d.worker_id);
    const label = DOC_KINDS[d.kind]?.label || d.kind;
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
    const cell = (v) => { const t = String(v ?? ''); return /[;"\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; };
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

  route('GET', '/api/bookings/:id/receipt', ({ user, id, res, query }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !user || !(user.role === 'admin' || b.client_id === user.id)) throw new HttpError(404, 'Réservation introuvable.');
    const isTest = !b.paid;
    if (isTest && (production || b.status !== 'terminee')) throw new HttpError(409, 'La facture est disponible dès que la réservation est payée.');
    const facture = isTest ? null : issueInvoice(b.id);
    const avoirs = isTest ? [] : db.prepare("SELECT * FROM invoices WHERE kind = 'avoir' AND booking_id = ? ORDER BY seq").all(b.id);
    const wanted = String(query.get('doc') || '');
    const doc = isTest ? { kind: 'facture', number: `TEST-${b.id}`, amount_cents: Math.round((b.total + (b.discount || 0)) * 100), tva_rate: tvaOf(b), issued_at: now().toISOString() }
      : avoirs.find((a) => a.number === wanted) || facture;
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title>
<style>body{font:15px/1.5 Arial,sans-serif;color:#0f1430;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:24px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px;border-bottom:1px solid #dce3f7;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}.muted{color:#596181;font-size:13px}.todo{background:#fff1c2}.test{background:#fff1c2;padding:10px;border-radius:8px;font-weight:700}.box{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-top:12px}tfoot td{font-weight:700}@media print{.noprint{display:none}}</style></head><body>
${isTest ? '<p class="test">DOCUMENT DE TEST : paiement simulé, aucune somme encaissée. Aucune valeur comptable.</p>' : ''}
<div class="box"><div><h1>${e(title)}</h1><p class="muted">Date d'émission : ${e(day(doc.issued_at))}${isAvoir ? `<br>Avoir sur la facture ${e(doc.ref_invoice)}` : ''}</p></div>
<div><b>${e(company.nomCommercial || 'Proprigo')}</b><br>${todo('raisonSociale', 'raison sociale')}${company.formeJuridique ? `, ${e(company.formeJuridique)}` : ''}${company.capital ? ` au capital de ${e(company.capital)}` : ''}<br>${todo('adresse', 'adresse du siège')}<br>SIRET : ${todo('siret', 'SIRET')}${company.rcs ? `<br>RCS ${e(company.rcs)}` : ''}<br>TVA intracommunautaire : ${todo('tvaIntracom', 'n° de TVA')}</div></div>
<div class="box"><div><b>${isPro ? 'Facturé à' : 'Client'}</b><br>${c.company ? `${e(c.company)}<br>` : ''}${e(c.name)}<br>${c.billing_address ? e(c.billing_address) : `${e(b.address)}, ${e(b.cp)}`}${c.siret ? `<br>SIRET : ${e(c.siret)}` : ''}${c.vat_number ? `<br>TVA intracommunautaire : ${e(c.vat_number)}` : ''}</div>
<div><b>Lieu de la prestation</b><br>${e(b.address)}, ${e(b.cp)}<br>Réservation n° ${b.id}</div></div>
<table><thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">Prix HT</th><th class="n">TVA</th><th class="n">Total TTC</th></tr></thead>
<tbody><tr><td>${isAvoir ? 'Remboursement : ' : ''}${e(label)}<br><span class="muted">Prestation du ${e(fr(b.date))} à ${e(b.time)}</span></td><td class="n">1</td><td class="n">${eur(ht)}</td><td class="n">${Math.round(doc.tva_rate * 1000) / 10} %</td><td class="n">${eur(ttc)}</td></tr></tbody>
<tfoot><tr><td colspan="4">Total HT</td><td class="n">${eur(ht)}</td></tr><tr><td colspan="4">TVA ${Math.round(doc.tva_rate * 1000) / 10} %</td><td class="n">${eur(ttc - ht)}</td></tr><tr><td colspan="4">${isAvoir ? 'Total remboursé TTC' : 'Total TTC'}</td><td class="n">${eur(ttc)}</td></tr></tfoot></table>
${isAvoir ? `<p>Remboursé sur le moyen de paiement d'origine.</p>`
    : `<p>Facture acquittée${isTest ? '' : ` le ${e(day(doc.issued_at))}`} : ${credit > 0 ? `${eur(ttc - credit)} par carte bancaire et ${eur(credit)} avec le crédit Proprigo (parrainage, carte cadeau ou pack).` : 'réglée par carte bancaire.'}</p>`}
${isPro ? "<p class=\"muted\">Prestation à un professionnel. Escompte pour paiement anticipé : néant. En cas de retard de paiement : pénalités au taux de 3 fois le taux d'intérêt légal et indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 du Code de commerce).</p>"
    : "<p class=\"muted\">Service à la personne : l'attestation fiscale annuelle pour le crédit d'impôt sera disponible dès la déclaration de l'entreprise (à confirmer par l'expert-comptable).</p>"}
${!isAvoir && avoirs.length ? `<p class="noprint"><b>Avoirs liés :</b> ${avoirs.map((a) => `<a href="?doc=${encodeURIComponent(a.number)}">${e(a.number)}</a> (${eur(a.amount_cents)})`).join(', ')}</p>` : ''}
${isAvoir ? `<p class="noprint"><a href="?">Voir la facture ${e(doc.ref_invoice)}</a></p>` : ''}
<p class="noprint muted">Pour l'enregistrer en PDF : Ctrl + P sur ordinateur, ou Partager › Imprimer sur téléphone.</p>
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
        return { ...w, steps: db_.STEPS[w.statut], active: engine.isActive(w), rejected: Boolean(w.rejected_at),
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
      quoteRequests: db.prepare("SELECT COUNT(*) AS n FROM quote_requests WHERE status = 'nouveau'").get().n,
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
      db.prepare('INSERT INTO workers (user_id, statut, cp, rate, step) VALUES (?, ?, ?, ?, 0)').run(id, statut, cp, rate);
      db_.setAvailability(db, id, db_.NEW_WORKER_WEEK);
      db.exec('COMMIT');
      db_.log(db, `Intervenante créée par administration : ${name} (validation nécessaire).`);
      return { status: 201, data: { ok: true, id } };
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
    if (w.step + 1 === steps.length - 1) engine.retryPending(db);
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

  route('POST', '/api/admin/bookings/:id/assign', ({ user, id, body }) => {
    needStaff(user);
    const bookingToAssign = db.prepare('SELECT paid, payment_status FROM bookings WHERE id = ?').get(id);
    if (!bookingToAssign) throw new HttpError(404, 'Réservation introuvable.');
    if (production && (!bookingToAssign.paid || bookingToAssign.payment_status !== 'paye')) throw new HttpError(409, 'Paiement confirmé requis avant attribution.');
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
  const runReminders = () => {
    const tomorrow = new Date(Date.parse(pricing.todayParis(now()) + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
    const list = db.prepare("SELECT * FROM bookings WHERE date = ? AND reminded = 0 AND status IN ('en_attente','proposee','attribuee')").all(tomorrow);
    for (const b of list) {
      const w = b.worker_id ? engine.firstName(db, b.worker_id) : null;
      mailer.send(emailOf(b.client_id), `Rappel : votre ménage demain à ${b.time}`, 'Votre ménage, c\'est demain', [`${fr(b.date)} à ${b.time}, ${b.address}.`, w ? `${w}, intervenante vérifiée, viendra.` : 'Nous vous confirmons votre intervenante très vite.', 'Un changement ? Écrivez-nous dans la messagerie de la réservation.'], { label: 'Voir ma réservation', path: '/#/' });
      if (b.worker_id) mailer.send(emailOf(b.worker_id), `Rappel : mission demain à ${b.time}`, 'Votre mission de demain', [`${fr(b.date)} à ${b.time}, ${b.cp}.`, "L'adresse, les consignes et la checklist sont dans votre espace."], { label: 'Voir mes missions', path: '/#/intervenante' });
      db.prepare('UPDATE bookings SET reminded = 1 WHERE id = ?').run(b.id);
    }
    return list.length;
  };
  if (autoSync) {
    setInterval(() => { try { purgePhotos(); purgeAttempts(); purgeRejectedDocs(); } catch (e) { console.error('Nettoyage quotidien :', e.message); } }, 24 * 3600e3).unref();
    setInterval(() => { mailer.processQueue().catch((e) => console.error('File des e-mails :', e.message)); }, 5 * 60e3).unref();
    setTimeout(runReminders, 60_000).unref();
    setInterval(runReminders, 3600e3).unref();
  }

  return { server, db, runReminders, runBackup, purgePhotos, reportError };
}

module.exports = { createApp };
