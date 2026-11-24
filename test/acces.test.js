'use strict';
// Audit des accès : chaque route du serveur est essayée par un visiteur, un autre client,
// une intervenante et un planificateur. Ce test casse si un accès s'ouvre par erreur.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const db_ = require('../src/db');

const PUBLIC = new Set(['GET /api/health', 'GET /api/me', 'POST /api/email/verify', 'POST /api/signup', 'POST /api/login', 'POST /api/password/forgot',
  'POST /api/password/reset', 'POST /api/quote-requests', 'POST /api/quote', 'POST /api/waitlist', 'GET /api/slots', 'GET /api/gifts/offer', 'GET /api/config',
  'POST /api/stripe/webhook', 'GET /api/reviews', 'GET /api/recruitment']);
// Réservé au responsable : le planificateur n'y a pas accès.
const OWNER_ONLY = ['GET /api/admin/backups', 'POST /api/admin/backups', 'GET /api/admin/backups/latest', 'GET /api/admin/outbox', 'GET /api/admin/staff', 'POST /api/admin/staff',
  'GET /api/admin/payouts', 'POST /api/admin/payouts', 'POST /api/admin/bookings/:id/refund', 'POST /api/admin/bookings/:id/refunded', 'POST /api/admin/workers/:id/advance',
  'POST /api/admin/workers', 'POST /api/admin/bookings/:id/cancel', 'GET /api/admin/payments', 'GET /api/admin/payments.csv', 'GET /api/admin/stats',
  'GET /api/admin/pricing', 'POST /api/admin/pricing', 'GET /api/admin/disputes/:id/evidence', 'POST /api/admin/documents/:id/review', 'POST /api/admin/workers/:id/reject', 'GET /api/admin/worker-docs', 'POST /api/admin/worker-docs', 'GET /api/admin/reviews', 'POST /api/admin/reviews/:id', 'GET /api/admin/sap', 'POST /api/admin/sap', 'GET /api/admin/nudges', 'POST /api/admin/nudges', 'POST /api/admin/nudges/run', 'GET /api/admin/invoices.csv', 'GET /api/admin/invoices/print'];
// Routes d'un client sur SES données : un autre client doit recevoir un refus.
const CLIENT_OWNED = ['POST /api/bookings/:id/pay', 'GET /api/bookings/:id/preferred-slots', 'POST /api/bookings/:id/update', 'POST /api/bookings/:id/cancel',
  'POST /api/bookings/:id/rate', 'POST /api/bookings/:id/photos', 'POST /api/bookings/:id/report', 'GET /api/bookings/:id/messages', 'POST /api/bookings/:id/messages',
  'GET /api/bookings/:id/receipt', 'POST /api/bookings/:id/ical-keep', 'POST /api/homes/:id', 'POST /api/homes/:id/delete', 'POST /api/homes/:id/sync', 'POST /api/series/:id/stop', 'POST /api/bookings/:id/guarantee'];

function allRoutes() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const list = [...src.matchAll(/route\('(GET|POST)', '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).filter((r) => !r.includes('\\'));
  for (const a of ['accept', 'refuse', 'start', 'finish']) list.push(`POST /api/worker/missions/:id/${a}`);
  return [...new Set(list)].filter((r) => r !== 'POST /api/logout');
}

test('audit des accès par rôle', async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => new Date('2026-11-21T09:00:00Z') });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { db } = app;
  try {
    db.prepare("INSERT INTO users (role, email, pass_hash, name) VALUES ('client', 'b@test.fr', ?, 'Client B')").run(db_.hashPassword('motdepasse-bbbb'));
    db.prepare("INSERT INTO users (role, email, pass_hash, name, staff_level) VALUES ('admin', 'plan@test.fr', ?, 'Planif', 'planning')").run(db_.hashPassword('motdepasse-plan'));
    const A = db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const W = db.prepare('SELECT u.id, u.email FROM users u JOIN workers w ON w.user_id = u.id LIMIT 1').get();
    const series = Number(db.prepare('INSERT INTO series (client_id, every_days) VALUES (?, 7)').run(A).lastInsertRowid);
    const bk = Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, series_id)
      VALUES (?, 'menage', 3, '75011', '12 rue A', '2026-11-28', '10:00', 0, 0, 111, 'IDF', 1, 'paye', 'terminee', '[]', ?)`).run(A, series).lastInsertRowid);
    const home = Number(db.prepare(`INSERT INTO homes (client_id, name, address, cp, service, size, hours, checkout_time, checklist, photo_consent)
      VALUES (?, 'Studio A', '1 rue A', '75011', 'airbnb', 'studio', 2, '11:00', '[]', 0)`).run(A).lastInsertRowid);
    const login = async (email, password) => {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.equal(r.status, 200, `connexion ${email}`);
      return (r.headers.get('set-cookie') || '').split(';')[0];
    };
    const who = { visiteur: '', autreClient: await login('b@test.fr', 'motdepasse-bbbb'), intervenante: await login(W.email, 'demo-proprigo'), planificateur: await login('plan@test.fr', 'motdepasse-plan') };
    const idFor = (p) => (p.startsWith('/api/homes') ? home : p.startsWith('/api/series') ? series : p.includes('workers/:id') ? W.id : p.includes('clients/:id') ? A : bk);
    const bodyFor = (p) => (p.endsWith('/rate') ? { stars: 5 } : p.endsWith('/report') ? { text: 'problème de test' } : p.endsWith('/messages') ? { text: 'bonjour' } : {});
    const problems = [];
    const snapshot = () => JSON.stringify([db.prepare('SELECT status, rating, payment_status, problem FROM bookings WHERE id = ?').get(bk),
      db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE booking_id = ?').get(bk), db.prepare('SELECT COUNT(*) AS n FROM messages WHERE booking_id = ?').get(bk),
      db.prepare('SELECT name FROM homes WHERE id = ?').get(home)]);
    let lastSnap = snapshot();
    const routes = allRoutes();
    assert.ok(routes.length > 80, `${routes.length} routes relevées`);
    for (const r of routes) {
      const [method, p] = r.split(' ');
      for (const [role, cookie] of Object.entries(who)) {
        const res = await fetch(base + p.replace(':id', idFor(p)), { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: method === 'POST' ? JSON.stringify(bodyFor(p)) : undefined });
        const st = res.status;
        const touched = snapshot();
        if (touched !== lastSnap && !(role === 'planificateur' && r === 'POST /api/bookings/:id/messages')) problems.push(`${r} : ${role} a modifié les données de Claire`);
        lastSnap = touched;
        const ok2xx = st >= 200 && st < 300;
        if (st === 500) problems.push(`${r} → 500 pour ${role} (panne)`);
        if (role === 'visiteur' && !PUBLIC.has(r) && ok2xx) problems.push(`${r} ouvert à un visiteur`);
        if (p.startsWith('/api/admin/') && ['autreClient', 'intervenante'].includes(role) && st !== 403 && st !== 401) problems.push(`${r} → ${st} pour ${role}`);
        if (p.startsWith('/api/worker/') && ['autreClient', 'planificateur'].includes(role) && ok2xx) problems.push(`${r} ouvert à ${role}`);
        if (CLIENT_OWNED.includes(r) && role !== 'planificateur' && ok2xx) problems.push(`${r} : ${role} agit sur les données de Claire`);
        if (OWNER_ONLY.includes(r) && role === 'planificateur' && st !== 403) problems.push(`${r} → ${st} pour le planificateur`);
      }
    }
    assert.deepEqual(problems, []);
    // Les données de Claire n'ont pas bougé.
    const b = db.prepare('SELECT status, rating, payment_status FROM bookings WHERE id = ?').get(bk);
    assert.deepEqual({ ...b }, { status: 'terminee', rating: null, payment_status: 'paye' });
    assert.ok(db.prepare('SELECT 1 FROM homes WHERE id = ?').get(home), 'le logement de Claire existe toujours');
    assert.deepEqual(db.prepare('SELECT text, source FROM incidents WHERE booking_id = ?').all(bk).map((x) => ({ ...x })), []);
    // Seule l'équipe (planificateur) a pu écrire à Claire.
    assert.deepEqual(db.prepare('SELECT DISTINCT u.role FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.booking_id = ?').all(bk).map((x) => x.role), ['admin']);
  } finally { app.server.close(); }
});
