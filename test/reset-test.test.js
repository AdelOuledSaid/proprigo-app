'use strict';
// v1.12.0 : effacer les données de test avant l'ouverture
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

async function start() {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'admin@proprigo.test', password: 'admin-test-123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  return { app, post };
}

test('effacer les données de test : confirmation, comptes démo, numérotation repartie à zéro', async () => {
  const { app, post } = await start();
  try {
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist) VALUES (?, 'menage', 3, '75011', 'x', '2030-01-10', '10:00', 0, 0, 108, 'IDF', 1, 'paye', 'terminee', '[]')`).run(cid);
    assert.equal((await post('/api/admin/test-data/reset', { confirm: 'oui' })).status, 400);
    const r = await post('/api/admin/test-data/reset', { confirm: 'EFFACER', demo: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@proprigo.test' AND role <> 'admin'").get().n, 0, 'comptes démo supprimés');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@proprigo.test'").get().n, 1, 'le compte qui efface est gardé');
    assert.match(r.data.message, /F\d{4}-000001/);
  } finally { app.server.close(); }
});

test('refusé quand Stripe est en mode réel', async () => {
  const old = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_live_exemple';
  const { app, post } = await start();
  try {
    const r = await post('/api/admin/test-data/reset', { confirm: 'EFFACER' });
    assert.equal(r.status, 409);
  } finally { app.server.close(); if (old === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = old; }
});
