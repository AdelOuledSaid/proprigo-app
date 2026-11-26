'use strict';
// Audit v1.3.0 : CSRF, tentatives de connexion persistantes, Airbnb en production, photos, sauvegardes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const backups = require('../src/backup');

const NOW = new Date('2026-11-21T09:00:00Z');
async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...app, base, post };
}

test('CSRF : une requête venue d\'un autre site est refusée, le site lui-même passe', async () => {
  const a = await start({ production: true, appUrl: 'https://proprigo.example' });
  try {
    const evil = await a.post('/api/login', { email: 'claire@proprigo.test', password: 'x' }, { Origin: 'https://pirate.example' });
    assert.equal(evil.status, 403);
    const nullOrigin = await a.post('/api/login', { email: 'x@y.fr', password: 'x' }, { Origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    const badReferer = await a.post('/api/login', { email: 'x@y.fr', password: 'x' }, { Referer: 'https://pirate.example/page' });
    assert.equal(badReferer.status, 403);
    const crossFetch = await a.post('/api/login', { email: 'x@y.fr', password: 'x' }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossFetch.status, 403);
    const own = await a.post('/api/login', { email: 'x@y.fr', password: 'mauvais' }, { Origin: 'https://proprigo.example' });
    assert.equal(own.status, 401); // passe le contrôle d'origine, refusé seulement pour le mot de passe
    const ownHost = await a.post('/api/login', { email: 'x@y.fr', password: 'mauvais' }, { Origin: `https://127.0.0.1:${a.server.address().port}` });
    assert.equal(ownHost.status, 401);
    const get = await fetch(a.base + '/api/health', { headers: { Origin: 'https://pirate.example' } });
    assert.notEqual(get.status, 403); // lecture simple : pas concernée
  } finally { a.server.close(); }
});

test('tentatives de connexion : le blocage survit à un redémarrage du serveur', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-login-'));
  const dbFile = path.join(dir, 'p.db');
  let a = await start({ dbFile });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await a.post('/api/login', { email: 'claire@proprigo.test', password: 'mauvais' })).status, 401);
    assert.equal((await a.post('/api/login', { email: 'claire@proprigo.test', password: 'demo-proprigo' })).status, 429);
  } finally { a.server.close(); a.db.close(); }
  a = await start({ dbFile, seed: false });
  try {
    assert.equal((await a.post('/api/login', { email: 'claire@proprigo.test', password: 'demo-proprigo' })).status, 429, 'toujours bloqué après redémarrage');
    assert.equal((await a.post('/api/login', { email: 'marc@proprigo.test', password: 'mauvais' })).status, 401, 'les autres comptes ne sont pas bloqués');
  } finally { a.server.close(); a.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Airbnb en production : ménage créé à payer, sans intervenante, client prévenu', async () => {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:stay-1@airbnb', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261128', 'SUMMARY:Reserved', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = await start({ production: true, paymentsEnabled: true, appUrl: 'https://proprigo.example', icalAllowAny: true, icalFetch: async () => ics });
  try {
    const client = a.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const home = a.db.prepare("SELECT * FROM homes WHERE client_id = ? AND ical_url IS NOT NULL LIMIT 1").get(client)
      || a.db.prepare('SELECT * FROM homes WHERE id = ?').get(Number(a.db.prepare(`INSERT INTO homes (client_id, name, address, cp, service, size, hours, checkout_time, checklist, photo_consent, ical_url)
        VALUES (?, 'Studio test', '1 rue Test', '75011', 'airbnb', 'studio', 3, '11:00', '[]', 0, 'https://www.airbnb.fr/calendar/ical/1.ics')`).run(client).lastInsertRowid));
    const ical = require('../src/ical');
    const notified = [];
    const r = await ical.syncHome(a.db, home, { now: NOW, allowAny: true, fetchText: async () => ics, prepay: true, onPrepay: (id) => notified.push(id) });
    assert.equal(r.created, 1);
    const b = a.db.prepare("SELECT * FROM bookings WHERE source = 'ical' ORDER BY id DESC").get();
    assert.equal(b.paid, 0);
    assert.equal(b.payment_status, 'en_attente_paiement');
    assert.equal(b.worker_id, null, 'aucune intervenante avant paiement');
    assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM offers WHERE booking_id = ?').get(b.id).n, 0);
    assert.deepEqual(notified, [b.id]);
  } finally {
    a.server.close();
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});

test('photos de plus de 90 jours : supprimées par le nettoyage périodique', async () => {
  const photosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-ph-'));
  const a = await start({ photosDir });
  try {
    const client = a.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const b = { id: Number(a.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
      VALUES (?, 'menage', 3, '75011', '1 rue Test', '2026-01-10', '10:00', 0, 0, 111, 'IDF', 1, 'paye', 'terminee', '[]')`).run(client).lastInsertRowid) };
    fs.writeFileSync(path.join(photosDir, 'old.jpg'), 'x');
    const cols = a.db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
    const vals = { booking_id: b.id, file: 'old.jpg', created_at: '2026-01-01 10:00:00', kind: 'avant', uploaded_by: client, uploader_id: client, user_id: client };
    const use = Object.keys(vals).filter((k) => cols.includes(k));
    a.db.prepare(`INSERT INTO photos (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`).run(...use.map((k) => vals[k]));
    assert.equal(a.purgePhotos(), 1);
    assert.equal(fs.existsSync(path.join(photosDir, 'old.jpg')), false);
  } finally { a.server.close(); fs.rmSync(photosDir, { recursive: true, force: true }); }
});

test('sauvegarde : vérifiée, chiffrée, déchiffrable, restaurable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-bk-'));
  try {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE users(id INTEGER); CREATE TABLE bookings(id INTEGER); INSERT INTO users VALUES (1),(2); INSERT INTO bookings VALUES (1);");
    const f = backups.backup(db, dir);
    assert.deepEqual({ ...backups.verify(f) }, { ok: true, users: 2, bookings: 1, payments: null });
    const key = 'une-cle-de-chiffrement-assez-longue';
    const enc = backups.encrypt(fs.readFileSync(f), key);
    assert.ok(!enc.includes(Buffer.from('SQLite format')), 'le fichier chiffré ne laisse rien lire');
    assert.deepEqual(backups.decrypt(enc, key), fs.readFileSync(f));
    assert.throws(() => backups.decrypt(enc, 'une-autre-cle-tout-aussi-longue'), /mauvaise clé/);
    const broken = Buffer.from(enc); broken[broken.length - 1] ^= 1;
    assert.throws(() => backups.decrypt(broken, key), /abîmé/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('signature S3 (AWS Signature V4) : exemple officiel AWS', () => {
  // Exemple « GET Object » de la documentation AWS (examplebucket/test.txt).
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const { signature } = backups.signV4({
    method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' },
    payloadHash: empty, accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z',
  });
  assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('copie externe : refusée sans clé de chiffrement, envoyée chiffrée sinon', async () => {
  const base = { BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'sauvegardes', BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SK' };
  assert.equal(backups.offsiteConfig({}), null);
  assert.throws(() => backups.offsiteConfig(base), /BACKUP_ENCRYPTION_KEY/);
  const cfg = backups.offsiteConfig({ ...base, BACKUP_ENCRYPTION_KEY: 'une-cle-de-chiffrement-assez-longue' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-up-'));
  try {
    const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE users(id INTEGER)');
    const f = backups.backup(db, dir, { now: new Date('2026-11-23T03:00:00Z') });
    let sent;
    const name = await backups.uploadOffsite(f, cfg, { now: new Date('2026-11-23T03:00:05Z'), fetchImpl: async (url, init) => { sent = { url, init }; return new Response('', { status: 200 }); } });
    assert.equal(name, 'proprigo/proprigo-20261123-0300.db.enc');
    assert.equal(sent.url, 'https://acc.r2.cloudflarestorage.com/sauvegardes/proprigo/proprigo-20261123-0300.db.enc');
    assert.equal(sent.init.method, 'PUT');
    assert.match(sent.init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20261123\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    assert.deepEqual(backups.decrypt(sent.init.body, cfg.encryptionKey), fs.readFileSync(f));
    await assert.rejects(backups.uploadOffsite(f, cfg, { fetchImpl: async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }) }), /refus 403 \(AccessDenied\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
