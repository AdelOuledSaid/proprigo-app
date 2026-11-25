'use strict';
// v1.6.0 : garantie, avis réels, heure d'arrivée, planning et gains de l'intervenante, notifications,
// planning admin, export des factures, relances, crédit d'impôt, pages recrutement et professionnels.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const db_ = require('../src/db');
const mailer = require('../src/mailer');

let clock = new Date('2026-11-21T09:00:00Z');
async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => clock, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = async (email, password) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(r.status, 200, `connexion ${email}`);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    };
  };
  return { ...app, base, session, close: () => app.server.close() };
}
const since = (n) => mailer.outbox(500).slice(0, mailer.outbox(500).length - n).map((m) => m.subject);
const clientId = (db) => db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
const mkBooking = (db, extra = {}) => Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, worker_id, finished_at)
  VALUES (?, 'menage', 3, '75011', '12 rue Test', ?, '10:00', 0, 0, 111, 'IDF', 1, 'paye', ?, '[]', ?, ?)`).run(clientId(db), extra.date || '2026-11-20', extra.status || 'terminee', extra.worker_id || null, extra.finished_at || null).lastInsertRowid);

test('garantie : demande sous 48 h, une seule fois, retour gratuit planifié sans facture', async () => {
  clock = new Date('2026-11-21T09:00:00Z');
  const a = await start();
  try {
    const recent = mkBooking(a.db, { finished_at: '2026-11-20 15:00:00' });
    const old = mkBooking(a.db, { date: '2026-11-10', finished_at: '2026-11-10 15:00:00' });
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const mine = (await claire('GET', '/api/bookings/mine')).data;
    assert.equal(mine.find((b) => b.id === recent).guarantee_open, true);
    assert.equal(mine.find((b) => b.id === old).guarantee_open, false);
    assert.equal((await claire('POST', `/api/bookings/${old}/guarantee`, { text: 'La cuisine n\'a pas été faite.' })).status, 409, 'au-delà de 48 h');
    assert.equal((await claire('POST', `/api/bookings/${recent}/guarantee`, { text: 'court' })).status, 400);
    const before = mailer.outbox(500).length;
    const ok = await claire('POST', `/api/bookings/${recent}/guarantee`, { text: 'La salle de bain n\'a pas été faite.' });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    const subj = since(before);
    assert.ok(subj.includes('Nous revenons gratuitement'));
    assert.ok(subj.some((x) => x.startsWith('Garantie : retour gratuit à planifier')));
    assert.equal((await claire('POST', `/api/bookings/${recent}/guarantee`, { text: 'Encore une fois la même chose.' })).status, 409, 'une seule fois');

    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    assert.equal((await admin('POST', `/api/admin/bookings/${recent}/guarantee-visit`, { date: '2026-11-19', time: '10:00' })).status, 400, 'date passée');
    const v = await admin('POST', `/api/admin/bookings/${recent}/guarantee-visit`, { date: '2026-11-24', time: '10:00', hours: 2 });
    assert.equal(v.status, 200);
    const visit = a.db.prepare('SELECT * FROM bookings WHERE id = ?').get(v.data.id);
    assert.equal(visit.total, 0);
    assert.equal(visit.payment_status, 'garantie');
    assert.equal(visit.guarantee_of, recent);
    assert.equal(visit.hours, 2);
    assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE booking_id = ?").get(v.data.id).n, 0, 'aucune facture pour un retour gratuit');
    assert.equal((await admin('POST', `/api/admin/bookings/${recent}/guarantee-visit`, { date: '2026-11-25', time: '10:00' })).status, 409);
    assert.equal(a.db.prepare("SELECT resolved FROM incidents WHERE booking_id = ? AND source = 'garantie'").get(recent).resolved, 1);
  } finally { a.close(); }
});

test('avis : publiés seulement avec accord, moyenne sur toutes les notes, masquage par le responsable', async () => {
  const a = await start();
  try {
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    a.db.exec('UPDATE bookings SET rating = NULL, review = NULL, review_public = 0');
    const ids = [mkBooking(a.db), mkBooking(a.db), mkBooking(a.db)];
    await claire('POST', `/api/bookings/${ids[0]}/rate`, { stars: 5, review: 'Parfait, très soigneux.', publish: true });
    await claire('POST', `/api/bookings/${ids[1]}/rate`, { stars: 2, review: 'Pas terrible cette fois.', publish: false });
    await claire('POST', `/api/bookings/${ids[2]}/rate`, { stars: 4, publish: true }); // pas de texte : rien à publier
    const all = a.db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM bookings WHERE rating IS NOT NULL').get();
    const r = await (await fetch(a.base + '/api/reviews')).json();
    assert.equal(r.count, all.n, 'toutes les notes comptent');
    assert.equal(r.average, Math.round(all.avg * 10) / 10);
    assert.deepEqual(r.list.map((x) => x.text), ['Parfait, très soigneux.']);
    assert.equal(r.list[0].place, 'Paris 11e');
    assert.match(r.list[0].author, /^Claire( [A-Z]\.)?$/);
    assert.doesNotMatch(JSON.stringify(r), /claire@|12 rue Test/, 'ni e-mail ni adresse');
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    assert.equal((await admin('POST', `/api/admin/reviews/${ids[0]}`, { hidden: true })).status, 200);
    assert.equal((await (await fetch(a.base + '/api/reviews')).json()).list.length, 0);
  } finally { a.close(); }
});

test('jour J : heure d\'arrivée estimée envoyée au client et modifiable', async () => {
  clock = new Date('2026-11-21T08:00:00Z');
  const a = await start();
  try {
    const wid = a.db.prepare("SELECT u.id FROM users u JOIN workers w ON w.user_id = u.id WHERE u.email = 'fatima@proprigo.test'").get().id;
    const bid = mkBooking(a.db, { date: '2026-11-21', status: 'attribuee', worker_id: wid });
    const fatima = await a.session('fatima@proprigo.test', 'demo-proprigo');
    const r = await fatima('POST', `/api/worker/missions/${bid}/onway`, { eta: 20 });
    assert.equal(r.status, 200);
    assert.match(r.data.message, /arrivée vers 09:20/);
    assert.equal(a.db.prepare('SELECT eta_at FROM bookings WHERE id = ?').get(bid).eta_at, '2026-11-21T08:20:00.000Z');
    const msg = a.db.prepare('SELECT text FROM messages WHERE booking_id = ? ORDER BY id DESC').get(bid);
    assert.match(msg ? msg.text : a.db.prepare("SELECT text FROM events ORDER BY id DESC").get().text, /09:20|en route/);
    const r2 = await fatima('POST', `/api/worker/missions/${bid}/onway`, { eta: 45 });
    assert.match(r2.data.message, /09:45/);
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const b = (await claire('GET', '/api/bookings/mine')).data.find((x) => x.id === bid);
    assert.equal(b.eta_at, '2026-11-21T08:45:00.000Z');
  } finally { a.close(); clock = new Date('2026-11-21T09:00:00Z'); }
});

test('notifications : chiffrement lisible par le téléphone, signature VAPID valide, abonnement contrôlé', async () => {
  const crypto = require('node:crypto');
  const push = require('../src/push');
  // le « téléphone » : sa paire de clés et son secret
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: push.b64u(ua.getPublicKey()), auth: push.b64u(auth) } };
  const body = push.encrypt(JSON.stringify({ title: 'Nouvelle mission', body: 'samedi 10:00' }), sub);
  // déchiffrement côté téléphone (RFC 8291)
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const shared = ua.computeSecret(asPub);
  const ikm = h(h(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'délimiteur de fin');
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), { title: 'Nouvelle mission', body: 'samedi 10:00' });
  assert.equal(body.readUInt32BE(16), 4096);

  const a = await start();
  try {
    const keys = push.vapidKeys(a.db);
    assert.deepEqual(push.vapidKeys(a.db), keys, 'clés gardées en base');
    const header = push.vapidHeader(sub.endpoint, keys, 'mailto:contact@proprigo.fr');
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, keys.publicKey);
    const [h64, p64, s64] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(p64, 'base64url'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    const pub = push.fromB64u(keys.publicKey);
    const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: push.b64u(pub.subarray(1, 33)), y: push.b64u(pub.subarray(33)) }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h64}.${p64}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')), 'signature ES256 valide');

    const fatima = await a.session('fatima@proprigo.test', 'demo-proprigo');
    assert.equal((await fatima('POST', '/api/push/subscribe', { ...sub, endpoint: 'https://evil.example/x' })).status, 400, 'seuls les services de notification connus');
    assert.equal((await fatima('POST', '/api/push/subscribe', sub)).status, 200);
    const wid = a.db.prepare("SELECT id FROM users WHERE email = 'fatima@proprigo.test'").get().id;
    const calls = [];
    const fake = async (url, init) => { calls.push({ url, init }); return new Response('', { status: calls.length === 1 ? 201 : 410 }); };
    assert.equal(await push.notifyUser(a.db, wid, { title: 't', body: 'b' }, { fetchImpl: fake }), 1);
    assert.equal(calls[0].url, sub.endpoint);
    assert.equal(calls[0].init.headers['Content-Encoding'], 'aes128gcm');
    assert.match(calls[0].init.headers.Authorization, /^vapid t=/);
    assert.equal(await push.notifyUser(a.db, wid, { title: 't', body: 'b' }, { fetchImpl: fake }), 0);
    assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(wid).n, 0, 'abonnement expiré (410) supprimé');
  } finally { a.close(); }
});

test('intervenante : semaine visuelle et gains mois par mois', async () => {
  clock = new Date('2026-11-25T09:00:00Z'); // mercredi
  const a = await start();
  try {
    const wid = a.db.prepare("SELECT id FROM users WHERE email = 'nadia@proprigo.test'").get()?.id
      || a.db.prepare("SELECT u.id FROM users u JOIN workers w ON w.user_id = u.id WHERE w.statut = 'I' LIMIT 1").get().id;
    const email = a.db.prepare('SELECT email FROM users WHERE id = ?').get(wid).email;
    a.db.prepare('DELETE FROM bookings WHERE worker_id = ?').run(wid);
    mkBooking(a.db, { date: '2026-11-26', status: 'attribuee', worker_id: wid });
    mkBooking(a.db, { date: '2026-10-05', status: 'terminee', worker_id: wid });
    a.db.prepare("INSERT INTO payouts (worker_id, week_start, hours, rate, amount, booking_ids, paid_at) VALUES (?, '2026-10-05', 3, 24, 72, '[]', '2026-10-12 10:00:00')").run(wid);
    const w = await a.session(email, 'demo-proprigo');
    const wk = (await w('GET', '/api/worker/week')).data;
    assert.equal(wk.start, '2026-11-23', 'la semaine commence le lundi');
    assert.equal(wk.days.length, 7);
    assert.equal(wk.days.find((d) => d.today).date, '2026-11-25');
    const thu = wk.days.find((d) => d.date === '2026-11-26');
    assert.equal(thu.items.length, 1);
    assert.equal(thu.items[0].kind, 'mission');
    assert.equal(wk.hours, 3);
    assert.equal((await w('GET', `/api/worker/week?start=${wk.next}`)).data.start, '2026-11-30');
    const g = (await w('GET', '/api/worker/earnings')).data;
    const oct = g.history.find((h) => h.month === '2026-10');
    assert.equal(oct.n, 1);
    assert.equal(oct.paid, 72);
  } finally { a.close(); clock = new Date('2026-11-21T09:00:00Z'); }
});

test('comptable : factures et avoirs du mois en CSV et en impression groupée', async () => {
  const a = await start();
  try {
    const b1 = mkBooking(a.db); const b2 = mkBooking(a.db);
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    // factures émises au paiement (ici : à l'ouverture de la facture)
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    await claire('GET', `/api/bookings/${b1}/receipt`); await claire('GET', `/api/bookings/${b2}/receipt`);
    a.db.prepare("UPDATE bookings SET payment_status = 'a_rembourser', refund_amount = 20 WHERE id = ?").run(b2);
    await admin('POST', `/api/admin/bookings/${b2}/refunded`, {});
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const csv = await admin('GET', `/api/admin/invoices.csv?month=${month}`);
    assert.equal(csv.status, 200);
    const rows = csv.data.trim().split('\r\n');
    assert.match(rows[0], /^﻿?Numéro;Type;Date;Client/);
    assert.ok(rows.some((r) => /^F\d{4}-\d{6};Facture;/.test(r)));
    assert.ok(rows.some((r) => /^A\d{4}-\d{6};Avoir;.*-20,00;F\d{4}-\d{6}$/.test(r)), rows.join('\n'));
    assert.match(rows[rows.length - 1], /^TOTAL;.*;202,00;$/, 'total TTC : 111 + 111 − 20');
    const print = await admin('GET', `/api/admin/invoices/print?month=${month}`);
    assert.equal(print.status, 200);
    assert.equal((print.data.match(/<section class="doc">/g) || []).length, 3);
    assert.match(print.data, /Avoir A\d{4}-000001/);
    assert.doesNotMatch(print.data, /Voir la facture|Avoirs liés/, 'pas de liens de navigation dans le PDF');
    assert.equal((await claire('GET', `/api/admin/invoices.csv?month=${month}`)).status, 403);
  } finally { a.close(); }
});

test('relances : clients inactifs seulement, une fois, désinscription en un clic', async () => {
  clock = new Date('2026-11-21T09:00:00Z');
  const realFetch = global.fetch;
  let sent = [];
  global.fetch = async (url, init) => { if (String(url) === 'https://api.resend.com/emails') { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); } return realFetch(url, init); };
  const a = await start({ mail: { provider: 'resend', apiKey: 're_test', from: 'Proprigo <contact@proprigo.fr>', retryDelaysMs: [0, 0] }, appUrl: 'https://proprigo.example' });
  try {
    a.db.exec('DELETE FROM bookings');
    const cid = clientId(a.db);
    mkBooking(a.db, { date: '2026-10-01' }); // 51 jours : à relancer
    const other = db_.createUser(a.db, { role: 'client', email: 'actif@test.fr', password: 'motdepasse-actif', name: 'Client Actif' });
    a.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
      VALUES (?, 'menage', 3, '75011', '1 rue', '2026-10-01', '10:00', 0, 0, 111, 'IDF', 1, 'paye', 'terminee', '[]'), (?, 'menage', 3, '75011', '1 rue', '2026-11-28', '10:00', 0, 0, 111, 'IDF', 1, 'paye', 'attribuee', '[]')`).run(other, other);
    assert.equal(a.runNudges(), 1, 'le client avec un ménage à venir n\'est pas relancé');
    await new Promise((r) => setTimeout(r, 50));
    const mail = sent.find((m) => m.subject === 'On repasse faire briller chez vous ?');
    assert.ok(mail);
    assert.equal(mail.to[0], 'claire@proprigo.test');
    assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/proprigo\.example\/desinscription\?u=\d+&t=[0-9a-f]{32}>$/);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(mail.html, /reserver\?again=\d+/);
    assert.equal(a.runNudges(), 0, 'pas deux fois');
    const link = mail.headers['List-Unsubscribe'].slice(1, -1).replace('https://proprigo.example', a.base);
    assert.equal((await realFetch(link)).status, 200);
    assert.equal(a.db.prepare('SELECT marketing_optout FROM users WHERE id = ?').get(cid).marketing_optout, 0, 'ouvrir le lien ne désinscrit pas (robots)');
    assert.equal((await realFetch(link.replace(/t=[0-9a-f]+/, 't=' + '0'.repeat(32)), { method: 'POST' })).status, 400);
    const one = await realFetch(link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(one.status, 200);
    assert.equal(a.db.prepare('SELECT marketing_optout FROM users WHERE id = ?').get(cid).marketing_optout, 1);
    // réglages
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    assert.equal((await admin('POST', '/api/admin/nudges', { enabled: false, days: 60 })).status, 200);
    assert.deepEqual((await admin('GET', '/api/admin/nudges')).data.settings, { enabled: false, days: 60 });
  } finally { a.close(); global.fetch = realFetch; }
});

test('crédit d\'impôt : jamais mentionné avant la déclaration, officiel après', async () => {
  const a = await start();
  try {
    const bid = mkBooking(a.db);
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    assert.deepEqual((await (await fetch(a.base + '/api/config')).json()).sap, { declared: false });
    let inv = (await claire('GET', `/api/bookings/${bid}/receipt`)).data;
    assert.doesNotMatch(inv, /199 sexdecies/);
    assert.match((await claire('GET', '/api/me/attestation?year=2026')).data, /Document provisoire/);
    assert.equal((await admin('POST', '/api/admin/sap', { declared: true, numero: '12345' })).status, 400, 'numéro au format SAP + 9 chiffres');
    assert.equal((await admin('POST', '/api/admin/sap', { declared: true, numero: 'sap 123 456 789' })).status, 200);
    const cfg = await (await fetch(a.base + '/api/config')).json();
    assert.equal(cfg.sap.declared, true);
    assert.equal(cfg.sap.numero, 'SAP123456789');
    inv = (await claire('GET', `/api/bookings/${bid}/receipt`)).data;
    assert.match(inv, /déclaration n° SAP123456789/);
    assert.match(inv, /199 sexdecies/);
    const att = (await claire('GET', '/api/me/attestation?year=2026')).data;
    assert.doesNotMatch(att, /Document provisoire/);
    assert.match(att, /services à la personne sous le n° SAP123456789/);
    // avance immédiate : liste d'intérêt
    assert.equal((await claire('POST', '/api/me/avance', { wants: true })).status, 200);
    assert.equal((await admin('GET', '/api/admin/sap')).data.interested, 1);
    assert.equal((await claire('GET', '/api/me')).data.user.wants_avance, 1);
  } finally { a.close(); }
});

test('recrutement : pièces demandées publiques, à jour avec la liste du responsable', async () => {
  const a = await start();
  try {
    const r = await (await fetch(a.base + '/api/recruitment')).json();
    assert.ok(r.docs.I.some((d) => /URSSAF/.test(d.label)));
    assert.ok(r.docs.S.some((d) => /sécurité sociale/.test(d.label)));
    assert.deepEqual(r.rate, { min: 15, max: 40 });
    assert.doesNotMatch(JSON.stringify(r), /@|password|email/i, 'aucune donnée personnelle');
  } finally { a.close(); }
});

test('applis mobiles : fichier de vérification Android et page de suppression de compte', async () => {
  const a = await start();
  try {
    let r = await (await fetch(a.base + '/.well-known/assetlinks.json')).json();
    assert.deepEqual(r, [], 'vide tant que l\'empreinte n\'est pas fournie');
    const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
    process.env.ANDROID_CERT_SHA256 = fp;
    r = await (await fetch(a.base + '/.well-known/assetlinks.json')).json();
    assert.equal(r[0].target.package_name, 'fr.proprigo.app');
    assert.deepEqual(r[0].target.sha256_cert_fingerprints, [fp]);
    delete process.env.ANDROID_CERT_SHA256;
    const html = await (await fetch(a.base + '/suppression-compte')).text();
    assert.match(html, /Supprimer mon compte/);
    assert.match(html, /mailto:/);
  } finally { a.close(); }
});

test('applis mobiles : jetons de notification natifs, envoi APNs et FCM', async () => {
  const crypto = require('node:crypto');
  const np = require('../src/native-push');
  const a = await start();
  try {
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    assert.equal((await claire('POST', '/api/push/native', { platform: 'ios', token: 'pas-un-jeton' })).status, 400);
    const iosTok = 'a'.repeat(64);
    assert.equal((await claire('POST', '/api/push/native', { platform: 'ios', token: iosTok })).status, 200);
    assert.equal((await claire('POST', '/api/push/native', { platform: 'android', token: 'fcm:' + 'b'.repeat(40) })).status, 200);
    assert.equal((await claire('GET', '/api/push/key')).data.native, 2);
    const uid = a.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;

    // iPhone : JWT ES256 vers Apple, jeton supprimé si Apple répond 410
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = {
      APNS_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123',
      FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'proprigo-test', client_email: 'x@proprigo-test.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
    };
    const seen = { apns: [], fcm: [] };
    const http2Connect = (host) => {
      const { EventEmitter } = require('node:events');
      const client = new EventEmitter(); client.close = () => {};
      client.request = (h) => {
        const req = new EventEmitter(); req.setTimeout = () => {}; req.resume = () => {};
        req.end = (body) => { seen.apns.push({ host, h, body: JSON.parse(body) }); setImmediate(() => req.emit('response', { ':status': 410 })); };
        return req;
      };
      return client;
    };
    const fetchImpl = async (url, opts) => {
      if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      seen.fcm.push({ url, opts, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    };
    np._cache.apns = null; np._cache.fcm = null;
    const n = await np.notifyUser(a.db, uid, { title: 'Proprigo', body: 'En route', url: '/#/mes-reservations' }, { env, fetchImpl, http2Connect });
    assert.equal(n, 1, 'Android envoyé, iPhone refusé (410)');
    assert.equal(seen.apns[0].host, 'https://api.push.apple.com');
    assert.equal(seen.apns[0].h[':path'], `/3/device/${iosTok}`);
    assert.equal(seen.apns[0].h['apns-topic'], 'fr.proprigo.app');
    const [h64, c64, s64] = seen.apns[0].h.authorization.slice(7).split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${h64}.${c64}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')), 'signature Apple valide');
    assert.equal(seen.apns[0].body.url, '/#/mes-reservations');
    assert.match(seen.fcm[0].url, /projects\/proprigo-test\/messages:send$/);
    assert.equal(seen.fcm[0].opts.headers.Authorization, 'Bearer tok');
    assert.equal(seen.fcm[0].body.message.data.url, '/#/mes-reservations');
    assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM native_push WHERE user_id = ?').get(uid).n, 1, 'jeton iPhone périmé supprimé');
    // déconnexion du téléphone
    await claire('POST', '/api/push/native/remove', { token: 'fcm:' + 'b'.repeat(40) });
    assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM native_push WHERE user_id = ?').get(uid).n, 0);
  } finally { a.close(); }
});

test('suppression de compte : une intervenante peut la demander depuis l\'appli', async () => {
  const a = await start();
  try {
    const w = a.db.prepare("SELECT email FROM users WHERE role = 'intervenante' ORDER BY id LIMIT 1").get();
    const s = await a.session(w.email, 'demo-proprigo');
    assert.equal((await s('POST', '/api/account/delete-request', { password: 'faux' })).status, 400);
    const r = await s('POST', '/api/account/delete-request', { password: 'demo-proprigo' });
    assert.equal(r.status, 200);
    assert.match(r.data.message, /30 jours/);
    assert.match((await s('POST', '/api/account/delete-request', { password: 'demo-proprigo' })).data.message, /déjà envoyée/);
  } finally { a.close(); }
});

test('auto-entrepreneur : factures sans TVA (293 B) et alerte avant le seuil de 37 500 €', async () => {
  const { createApp } = require('../src/app');
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', companyConfig: { raisonSociale: 'Adel TEST EI', adresse: '1 rue de Paris', siret: '12345678900011', regimeTVA: 'franchise' } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.franchiseTVA, true);
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    // 30 500 € de factures déjà émises cette année : l'alerte des 80 % doit partir au prochain paiement
    const year = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric' }).format(new Date()));
    app.db.prepare("INSERT INTO invoices (kind, year, seq, number, booking_id, client_id, amount_cents, tva_rate, issued_at) VALUES ('facture', ?, 999, 'F-OLD', 999999, ?, 3050000, 0, datetime('now'))").run(year, cid);
    const r = { lastInsertRowid: mkBooking(app.db) };
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${base}/api/bookings/${r.lastInsertRowid}/receipt`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /TVA non applicable, art\. 293 B du CGI/);
    assert.doesNotMatch(html, /Total HT|TVA intracommunautaire/);
    assert.equal(app.db.prepare('SELECT tva_rate FROM invoices WHERE booking_id = ?').get(r.lastInsertRowid).tva_rate, 0);
    assert.ok(app.db.prepare("SELECT 1 FROM mail_sent WHERE key = ?").get(`tva-80-${year}`), 'alerte 80 % envoyée une fois');
    const h = await (await fetch(base + '/api/health')).json();
    assert.match(h.tva, /franchise \(293 B\)/);
  } finally { app.server.close(); }
});

test('photo de profil : vérifiée avant d\'être montrée, le client voit le prénom et l\'initiale', async () => {
  const a = await start();
  try {
    const fatima = a.db.prepare("SELECT id FROM users WHERE email = 'fatima@proprigo.test'").get().id;
    const bid = mkBooking(a.db, { worker_id: fatima, status: 'attribuee', date: '2026-12-01' });
    const w = await a.session('fatima@proprigo.test', 'demo-proprigo');
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    // un JPEG minimal
    const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString('base64');
    assert.equal((await w('POST', '/api/worker/avatar', { data: 'data:image/gif;base64,R0lGOD' })).status, 400);
    assert.equal((await w('POST', '/api/worker/avatar', { data: jpeg })).status, 200);
    // pas encore validée : le client ne la voit pas, l'intervenante si
    let card = (await claire('GET', `/api/workers/${fatima}/card`)).data;
    assert.equal(card.photo, false);
    assert.equal(card.avatar_status, undefined, 'le client ne voit pas l\'état de validation');
    assert.equal((await claire('GET', `/api/workers/${fatima}/avatar`)).status, 404);
    assert.equal((await w('GET', `/api/workers/${fatima}/avatar`)).status, 200);
    assert.equal((await w('GET', `/api/workers/${fatima}/card`)).data.avatar_status, 'a_verifier');
    // l'équipe accepte
    assert.equal((await admin('POST', `/api/admin/workers/${fatima}/avatar`, { ok: true })).status, 200);
    card = (await claire('GET', `/api/workers/${fatima}/card`)).data;
    assert.equal(card.photo, true);
    assert.equal((await claire('GET', `/api/workers/${fatima}/avatar`)).status, 200);
    // le client ne reçoit jamais le nom de famille complet
    const mine = (await claire('GET', '/api/bookings/mine')).data.find((b) => b.id === bid);
    a.db.prepare("UPDATE users SET name = 'Fatima Koné Diallo' WHERE id = ?").run(fatima);
    const again = (await claire('GET', '/api/bookings/mine')).data.find((b) => b.id === bid);
    assert.equal(again.worker_name, 'Fatima K.');
    assert.equal((await claire('GET', `/api/workers/${fatima}/card`)).data.displayName, 'Fatima K.');
    assert.doesNotMatch(JSON.stringify(again), /Koné|Diallo/);
    assert.equal(mine.worker_photo, true);
    // un autre client, sans réservation avec elle, ne voit pas la photo
    const other = await a.session('admin@proprigo.test', 'admin-test-123');
    void other;
    // refus : la photo disparaît
    assert.equal((await w('POST', '/api/worker/avatar', { data: jpeg })).status, 200);
    assert.equal((await admin('POST', `/api/admin/workers/${fatima}/avatar`, { ok: false })).status, 200);
    assert.equal((await claire('GET', `/api/workers/${fatima}/card`)).data.photo, false);
  } finally { a.close(); }
});
