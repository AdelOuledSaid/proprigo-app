'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db_ = require('./db');
const engine = require('./engine');
const pricing = require('./pricing');
const checklist = require('./checklist');
const ical = require('./ical');
const mailer = require('./mailer');
const backups = require('./backup');
const VERSION = require('../package.json').version;
const os = require('node:os');
const stripePay = require('./stripe-pay');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 14;
const MIN_LEAD_MIN = 60;
const REFERRAL_EUR = 10; // offert au filleul sur son premier ménage, et au parrain après ce ménage // un ménage du jour se réserve au moins 1 h à l'avance (temps de trajet)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({ dbFile = ':memory:', adminPassword = 'proprigo-admin', seed = true, secureCookies = false, production = false, paymentsEnabled = false, photosDir = null, icalAllowAny = false, icalFetch = undefined, autoSync = false, mail = {}, appUrl = 'http://localhost:3000', now = () => new Date(), backupDir = null } = {}) {
  const PHOTOS = photosDir || (dbFile === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-photos-')) : path.join(path.dirname(dbFile), 'photos'));
  fs.mkdirSync(PHOTOS, { recursive: true });
  const db = db_.open(dbFile);
  const stripeReady = paymentsEnabled && stripePay.configured();
  if (seed) db_.seedDemo(db, adminPassword);
  const loginAttempts = new Map();
  const syncAsks = new Map();
  mailer.configure({
    outbox: mail.outbox || (dbFile === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-outbox-')) : path.join(path.dirname(dbFile), 'outbox')),
    provider: mail.provider, apiKey: mail.apiKey, from: mail.from, appUrl,
    onError: (t) => db_.log(db, t),
  });
  // Règle d'annulation : gratuite jusqu'à 24 h avant, 50 % retenus ensuite.
  const FREE_CANCEL_HOURS = 24;
  const LATE_CANCEL_KEEP = 0.5;
  const refundFor = (b) => (hoursBefore(b) >= FREE_CANCEL_HOURS ? b.total : Math.round(b.total * (1 - LATE_CANCEL_KEEP) * 100) / 100);
  const emailOf = (uid) => (db.prepare('SELECT email FROM users WHERE id = ?').get(uid) || {}).email;
  const fr = (d) => engine.frDate(d);
  // RGPD : les photos sont supprimées 90 jours après leur ajout
  for (const ph of db.prepare("SELECT * FROM photos WHERE created_at < datetime('now', '-90 days')").all()) {
    try { fs.unlinkSync(path.join(PHOTOS, ph.file)); } catch { /* déjà supprimée */ }
    db.prepare('DELETE FROM photos WHERE id = ?').run(ph.id);
  }

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
    return db.prepare('SELECT id, role, email, name, phone, staff_level FROM users WHERE id = ?').get(s.user_id) || null;
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
    const data = { ok, version: VERSION, uptimeMinutes: Math.round((Date.now() - started) / 60e3), database: dbOk ? 'ok' : 'erreur', backup: !backupDir ? 'désactivée' : backupOk ? 'ok' : 'en retard' };
    return ok ? data : { status: 503, data };
  });
  const runBackup = () => {
    try {
      const f = backups.backup(db, backupDir);
      lastBackup = Date.now();
      lastBackupError = null;
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
    return { enabled: true, error: lastBackupError, list: backups.list(backupDir).slice(0, 5).map((b) => ({ file: b.file, size: b.size, time: new Date(b.time).toISOString() })) };
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
    if (role === 'intervenante') mailer.send(email, 'Votre candidature Proprigo', `Bonjour ${name.split(' ')[0]}, merci pour votre candidature`, ["Notre équipe vous contacte pour la suite : vérification de l'identité, entretien, formation.", 'Pensez à indiquer vos disponibilités dans votre espace.'], { label: 'Mon espace', path: '/#/intervenante' });
    else mailer.send(email, 'Bienvenue chez Proprigo', `Bienvenue ${name.split(' ')[0]}`, ['Votre compte est créé. Vous pouvez réserver un ménage en quelques minutes, avec des intervenantes vérifiées.'], { label: 'Réserver un ménage', path: '/#/reserver' });
    return { status: 201, data: { ok: true }, headers: { 'Set-Cookie': login(null, id) } };
  });

  route('POST', '/api/login', ({ body, ip }) => {
    const key = ip + '|' + str(body.email, 120).toLowerCase();
    const a = loginAttempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Trop d\'essais. Réessayez dans quelques minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(str(body.email, 120).toLowerCase());
    if (!u || !db_.checkPassword(String(body.password || ''), u.pass_hash)) {
      a.n += 1;
      if (a.n >= 5) { a.until = Date.now() + 10 * 60e3; a.n = 0; }
      loginAttempts.set(key, a);
      throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
    }
    loginAttempts.delete(key);
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
    const q = pricing.quote(body, now());
    if (q.ok && user && user.role === 'client') {
      const d = Math.min(creditOf(user.id), Math.floor(q.total / 2));
      if (d > 0) { q.discount = d; q.lines = [...q.lines, { label: 'Crédit parrainage', amount: -d }]; q.total = Math.round((q.total - d) * 100) / 100; }
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
    if (!pricing.isValidDate(date) || !pricing.zoneOf(cp) || !(hours >= 1 && hours <= 8)) return { slots: [] };
    const later = (t) => date !== pricing.todayParis(now()) || engine.toMin(t) >= engine.toMin(nowParisHM()) + MIN_LEAD_MIN;
    const slots = engine.requestSlots({ hours }).filter(later); // créneaux demandables, sous réserve d'attribution par l'équipe
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
    } catch (e) { throw new HttpError(502, 'Paiement indisponible. Réessayez.'); }
  });
  route('GET', '/api/payments/status', ({ user, query }) => {
    need(user, 'client');
    const id = Number(query.get('booking'));
    const b = db.prepare('SELECT id, paid, payment_status FROM bookings WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!b) throw new HttpError(404, 'Réservation introuvable.');
    return b;
  });

  const creditOf = (clientId) => {
    const got = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM credits WHERE user_id = ?').get(clientId).t;
    const used = db.prepare("SELECT COALESCE(SUM(discount), 0) AS t FROM bookings WHERE client_id = ? AND status <> 'annulee'").get(clientId).t;
    return Math.max(0, Math.round((got - used) * 100) / 100);
  };
  route('POST', '/api/bookings', async ({ user, body }) => {
    need(user, 'client');
    // Sécurité : en production, aucune réservation sans vrai paiement en ligne.
    if (production && !stripeReady) throw new HttpError(503, "Le paiement en ligne n'est pas encore activé : les réservations ouvriront bientôt.");
    const q = pricing.quote(body, now());
    if (!q.ok) throw new HttpError(400, q.errors.join(' '));
    if (!q.open) throw new HttpError(409, "Proprigo n'est pas encore ouvert à ce code postal. Inscrivez-vous sur la liste d'attente.");
    const address = str(body.address, 200);
    if (address.length < 5) throw new HttpError(400, 'Indiquez l\'adresse complète.');
    const time = str(body.time, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Heure invalide.');
    if (body.date === pricing.todayParis(now()) && engine.toMin(time) < engine.toMin(nowParisHM()) + MIN_LEAD_MIN) throw new HttpError(400, 'Pour aujourd\'hui, choisissez une heure au moins 1 h à l\'avance.');
    if (!engine.requestSlots({ hours: q.hours }).includes(time)) throw new HttpError(400, 'Choisissez un créneau proposé.');
    const every = body.repeat === '7' || body.repeat === '14' ? Number(body.repeat) : 0;
    const count = every ? Math.min(12, Math.max(2, Number(body.occurrences) || 8)) : 1;
    if (every && q.urgent) throw new HttpError(400, "L'urgence ne s'applique pas à une réservation récurrente.");
    const home = body.home_id ? db.prepare('SELECT * FROM homes WHERE id = ? AND client_id = ?').get(Number(body.home_id), user.id) : null;
    if (body.home_id && !home) throw new HttpError(404, 'Logement introuvable.');
    const payMode = every && body.payment_mode === 'per_visit' ? 'per_visit' : 'all';
    if (stripeReady && !stripePay.validBaseUrl(appUrl)) throw new HttpError(503, 'Adresse publique du site non configurée.');
    // Eviter les doublons exacts d'une prestation simple lors des clics repetes.
    // Ne pas bloquer une nouvelle reservation differente ni les recurrents.
    if (stripeReady && !every) {
      const existing = db.prepare(`SELECT * FROM bookings
        WHERE client_id = ? AND service = ? AND hours = ? AND cp = ?
          AND address = ? AND date = ? AND time = ? AND total = ?
          AND urgent = ? AND kit = ? AND COALESCE(home_id, 0) = ?
          AND status <> 'annulee' AND created_at >= datetime('now', '-30 minutes')
        ORDER BY id DESC LIMIT 1`).get(user.id, q.service, q.hours, body.cp, address,
          body.date, time, q.total, body.urgent ? 1 : 0, body.kit ? 1 : 0, home ? home.id : 0);
      if (existing) {
        if (existing.paid || existing.payment_status === 'paye')
          throw new HttpError(409, 'Cette prestation a deja ete payee. Consultez Mes reservations.');
        try {
          const session = await stripePay.checkout({ db, ids: [existing.id], clientId: user.id, email: user.email, appUrl });
          return { status: 200, data: { checkout_url: session.url, created: 0, reused: true } };
        } catch (e) {
          console.error('Stripe Checkout retry failed:', { message: e.message });
          throw new HttpError(502, 'Impossible de reprendre le paiement Stripe. Reessayez.');
        }
      }
    }
    const tasks = JSON.stringify(checklist.clean(body.checklist, q.service));
    const consent = body.photoConsent ? 1 : 0;
    let seriesId = null;
    if (every) seriesId = Number(db.prepare('INSERT INTO series (client_id, every_days) VALUES (?, ?)').run(user.id, every).lastInsertRowid);
    const ids = [];
    for (let k = 0; k < count; k++) {
      const date = addDays(body.date, k * every);
      const qk0 = k === 0 ? q : pricing.quote({ ...body, date, urgent: false }, now());
      // crédit (parrainage) appliqué au premier ménage ; le prix ne descend jamais sous 50 % du tarif
      const discount = k === 0 ? Math.min(creditOf(user.id), Math.floor(qk0.total / 2)) : 0;
      const qk = { ...qk0, total: Math.round((qk0.total - discount) * 100) / 100 };
      const r = db.prepare(`INSERT INTO bookings (client_id, service, size, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, series_id, checklist, photo_consent, home_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '${stripeReady ? 'en_attente_paiement' : 'simule'}', ?, ?, ?, ?)`).run(
        user.id, q.service, q.size, q.hours, body.cp, address, date, time, k === 0 && body.urgent ? 1 : 0, body.kit ? 1 : 0, qk.total, q.zone, seriesId, tasks, consent, home ? home.id : null);
      const id = Number(r.lastInsertRowid);
      if (discount) db.prepare('UPDATE bookings SET discount = ? WHERE id = ?').run(discount, id);
      ids.push(id);
      db_.log(db, `Réservation n° ${id} créée, paiement ${stripeReady ? 'en attente' : 'simulé'} : ${qk.total} €, ${body.cp}, ${date} ${time}.`);
      if (!stripeReady && !production) engine.assign(db, id); // mode démonstration seulement
    }
    if (stripeReady) {
      // Chaque intervention est enregistrée sans affectation jusqu'à confirmation Stripe.
      // En mode per_visit, seule la première intervention est encaissée maintenant.
      const chargeIds = payMode === 'all' ? ids : [ids[0]];
      try {
        const session = await stripePay.checkout({ db, ids: chargeIds, clientId: user.id, email: user.email, appUrl });
        return { status: 201, data: { checkout_url: session.url, created: ids.length, payment_mode: payMode } };
      } catch (e) {
        db.prepare(`UPDATE bookings SET status = 'annulee', payment_status = 'paiement_echoue' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        throw new HttpError(502, 'Impossible de démarrer le paiement Stripe. Réessayez.');
      }
    }
    const first = bookingView(db.prepare('SELECT * FROM bookings WHERE id = ?').get(ids[0]));
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
    if (!engine.requestSlots({ hours: q.hours }).includes(next.time)) throw new HttpError(400, 'Choisissez un créneau proposé.');
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
    return { profile: w, steps: db_.STEPS[w.statut], active: engine.isActive(w), offers: safeOffers, missions: missions.map((m) => { const h = m.home_id ? db.prepare('SELECT name, instructions FROM homes WHERE id = ?').get(m.home_id) : null; return { ...bookingView(m), client_name: m.client_name, home_name: h ? h.name : null, instructions: h ? h.instructions : null }; }), done, availability: cal, timeoff: off };
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

  route('POST', '/api/homes/:id/sync', async ({ user, id }) => {
    need(user, 'client');
    const h = db.prepare('SELECT * FROM homes WHERE id = ? AND client_id = ?').get(id, user.id);
    if (!h) throw new HttpError(404, 'Logement introuvable.');
    if (production) throw new HttpError(503, 'Réservations Airbnb automatiques suspendues jusqu’à la mise en place du prépaiement.');
    const lastAsk = syncAsks.get(id) || 0;
    if (now().getTime() - lastAsk < 120e3) throw new HttpError(429, 'Calendrier déjà synchronisé il y a moins de 2 minutes.');
    syncAsks.set(id, now().getTime());
    try {
      return await ical.syncHome(db, h, { now: now(), allowAny: icalAllowAny, fetchText: icalFetch });
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
  route('GET', '/api/bookings/:id/receipt', ({ user, id, res }) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b || !user || !(user.role === 'admin' || b.client_id === user.id)) throw new HttpError(404, 'Réservation introuvable.');
    if (b.status !== 'terminee' || (production && !b.paid)) throw new HttpError(409, 'Le reçu est disponible après paiement et réalisation du ménage.');
    const c = db.prepare('SELECT name, email FROM users WHERE id = ?').get(b.client_id);
    const tva = pricing.PRO_SERVICES.includes(b.service) ? pricing.COSTS.tvaPro : pricing.COSTS.tvaParticulier;
    const ht = Math.round((b.total / (1 + tva)) * 100) / 100;
    const e = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const label = b.service === 'airbnb' ? `Ménage Airbnb ${pricing.SIZE_LABEL[b.size]} (ménage + linge)` : `${b.service === 'bureau' ? 'Nettoyage de bureaux' : b.service === 'grand' ? 'Grand nettoyage' : 'Ménage'} ${b.hours} h${b.kit ? ', matériel et produits fournis' : ''}`;
    const num = `PG-${b.date.slice(0, 4)}-${String(b.id).padStart(6, '0')}`;
    const eur = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\u00a0€';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reçu ${num}</title>
<style>body{font:15px/1.5 Arial,sans-serif;color:#0f1430;max-width:720px;margin:24px auto;padding:0 16px}h1{font-size:24px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px;border-bottom:1px solid #dce3f7;text-align:left}td.n,th.n{text-align:right;white-space:nowrap}.test{border:2px solid #b23d0c;color:#b23d0c;padding:10px;border-radius:10px;font-weight:700;margin:16px 0}.muted{color:#596181;font-size:13px}@media print{.noprint{display:none}}</style></head><body>
${stripeReady ? '' : '<p class="test">DOCUMENT DE TEST : paiement simulé, aucune somme encaissée. Ce reçu n\'a aucune valeur comptable.</p>'}
<div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap"><div><h1>Reçu ${num}</h1><p class="muted">Date de la prestation : ${e(fr(b.date))}</p></div>
<div><b>Proprigo</b><br>[RAISON SOCIALE ET FORME JURIDIQUE]<br>[ADRESSE DU SIÈGE]<br>SIRET : [À COMPLÉTER]<br>TVA intracommunautaire : [À COMPLÉTER]</div></div>
<p><b>Client :</b> ${e(c.name)}<br>${e(b.address)}, ${e(b.cp)}</p>
<table><thead><tr><th>Prestation</th><th class="n">Montant HT</th><th class="n">TVA</th><th class="n">Total TTC</th></tr></thead>
<tbody><tr><td>${e(label)}<br><span class="muted">${e(fr(b.date))} à ${e(b.time)}</span></td><td class="n">${eur(ht)}</td><td class="n">${Math.round(tva * 100)} % · ${eur(b.total - ht)}</td><td class="n"><b>${eur(b.total)}</b></td></tr></tbody></table>
<p class="muted">${pricing.PRO_SERVICES.includes(b.service) ? 'Prestation à un professionnel.' : "Service à la personne : l'attestation fiscale annuelle pour le crédit d'impôt sera disponible dès la déclaration de l'entreprise (à confirmer par l'expert-comptable)."}</p>
<p class="noprint muted">Pour l'enregistrer en PDF : Ctrl + P sur ordinateur, ou Partager › Imprimer sur téléphone.</p>
</body></html>`);
    return { streamed: true };
  });

  // ----- e-mails envoyés (mode local) -----
  route('GET', '/api/admin/outbox', ({ user }) => {
    need(user, 'admin');
    return { provider: mailer.cfg.provider || null, list: mailer.outbox() };
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
      .map((w) => ({ ...w, steps: db_.STEPS[w.statut], active: engine.isActive(w) }));
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
    const steps = db_.STEPS[w.statut];
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
    db.prepare("UPDATE bookings SET status = 'annulee', payment_status = 'a_rembourser', refund_amount = total, ical_flagged = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM offers WHERE booking_id = ? AND state = 'offered'").run(id);
    engine.notify(db, id, `Le ménage du ${fr(b.date)} est annulé par l'équipe Proprigo. Vous êtes remboursé intégralement (${b.total} €).`);
    if (b.worker_id) mailer.send(emailOf(b.worker_id), `Mission annulée le ${fr(b.date)}`, 'Mission annulée', [`La mission du ${fr(b.date)} à ${b.time} (${b.cp}) est annulée.`], { label: 'Voir mes missions', path: '/#/intervenante' });
    db_.log(db, `Ménage n° ${id} annulé par l'équipe, ${b.total} € à rembourser.`);
    return { ok: true, message: `Ménage n° ${id} annulé, ${b.total} € à rembourser.` };
  });

  route('POST', '/api/admin/bookings/:id/refunded', ({ user, id }) => {
    need(user, 'admin');
    const r = db.prepare("UPDATE bookings SET payment_status = 'rembourse' WHERE id = ? AND payment_status = 'a_rembourser'").run(id);
    if (!r.changes) throw new HttpError(409, 'Rien à rembourser pour cette réservation.');
    db_.log(db, `Réservation n° ${id} : remboursement effectué.`);
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
    db.prepare("UPDATE bookings SET payment_status = 'rembourse', refund_id = ? WHERE id = ?").run(r.id, id);
    db_.log(db, `Réservation n° ${id} : ${(amount / 100).toFixed(2).replace('.', ',')} € remboursés dans Stripe (${r.status === 'pending' ? 'en cours' : 'effectué'}).`);
    engine.notify(db, id, `Votre remboursement de ${(amount / 100).toFixed(2).replace('.', ',')} € a été lancé. Il apparaît sur votre compte bancaire sous 5 à 10 jours.`);
    return { ok: true, message: `${(amount / 100).toFixed(2).replace('.', ',')} € remboursés dans Stripe.` };
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
          const payment = db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(sess.id);
          if (payment && payment.status !== 'paid' && sess.currency === 'eur' && sess.amount_total === payment.amount_cents) {
            const ids = JSON.parse(payment.booking_ids);
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare("UPDATE stripe_payments SET status = 'paid', payment_intent = ? WHERE session_id = ?").run(typeof sess.payment_intent === 'string' ? sess.payment_intent : null, sess.id);
              for (const id of ids) {
                const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
                if (b && b.client_id === payment.client_id && !b.paid) {
                  if (b.status === 'annulee') db.prepare("UPDATE bookings SET paid = 1, payment_status = 'a_rembourser', refund_amount = total WHERE id = ?").run(id);
                  else db.prepare("UPDATE bookings SET paid = 1, payment_status = 'paye' WHERE id = ?").run(id);
                }
              }
              db.exec('COMMIT');
            } catch (e) { db.exec('ROLLBACK'); throw e; }
            for (const id of ids) {
              const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
              if (b && b.payment_status === 'paye' && b.status === 'en_attente') {
                db_.log(db, `Réservation n° ${id} payée : attribution manuelle nécessaire.`);
              }
            }
          }
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
        if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Contenu JSON attendu.');
        }
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new HttpError(404, 'Introuvable.');
        const id = Number((url.pathname.match(r.re) || [])[1]);
        const body = req.method === 'POST' ? await readBody(req, /\/photos$/.test(url.pathname) ? 4_000_000 : 100_000) : {};
        const out = await r.handler({ req, res, body, id, query: url.searchParams, user: currentUser(req), ip: req.socket.remoteAddress || '' });
        if (out && out.streamed) return;
        if (out && out.data !== undefined && (out.status || out.headers)) return send(res, out.status || 200, out.data, out.headers);
        return send(res, 200, out);
      }
      // fichiers du site
      let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'Interdit.');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:",
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'Erreur interne.' });
    }
  });

  if (autoSync) {
    const run = async () => {
      if (production) return; // Synchronisation auto suspendue : ne pas créer de mission Airbnb impayée.
      for (const h of db.prepare('SELECT * FROM homes WHERE ical_url IS NOT NULL').all()) {
        try { await ical.syncHome(db, h, { now: now(), allowAny: icalAllowAny, fetchText: icalFetch }); } catch (e) {
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
    setTimeout(runReminders, 60_000).unref();
    setInterval(runReminders, 3600e3).unref();
  }

  return { server, db, runReminders, runBackup };
}

module.exports = { createApp };
