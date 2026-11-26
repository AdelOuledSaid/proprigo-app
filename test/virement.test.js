'use strict';
// v1.12.0 : entreprises payées par virement, relevé de fin de mois
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

test('virement : passages confirmés sans carte, relevé mensuel, factures, marqué payé', async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', companyConfig: { raisonSociale: 'PROPRIGO', iban: 'FR76 3000 6000 0112 3456 7890 189', bic: 'AGRIFRPP', regimeTVA: 'franchise' } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = async (email, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0];
  const call = (cookie, method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }));
  try {
    const admin = await login('admin@proprigo.test', 'admin-test-123');
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const add = (date, status, ps) => Number(app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist) VALUES (?, 'bureau', 2, '75010', '12 rue Test', ?, '09:00', 0, 0, 72, 'IDF', 0, ?, ?, '[]')`).run(cid, date, ps, status).lastInsertRowid);
    const future = add('2030-01-10', 'en_attente', 'en_attente_paiement');
    const r1 = await call(admin, 'POST', '/api/admin/clients/billing', { email: 'claire@proprigo.test', billing: 'virement' });
    assert.equal(r1.status, 200);
    assert.equal(app.db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(future).payment_status, 'virement', 'passage à venir confirmé sans carte');
    const a = add('2026-10-05', 'terminee', 'virement'); const b = add('2026-10-19', 'terminee', 'virement');
    assert.equal((await call(admin, 'POST', '/api/admin/transfer-bills', { client_id: cid, month: '2026-09' })).status, 409);
    const bill = await call(admin, 'POST', '/api/admin/transfer-bills', { client_id: cid, month: '2026-10' });
    assert.equal(bill.status, 200, JSON.stringify(bill.data));
    assert.equal(bill.data.bill.total, 144);
    assert.equal(bill.data.bill.lines.length, 2);
    assert.ok(bill.data.bill.lines.every((l) => /^F\d{4}-\d{6}$/.test(l.number)), 'une facture par passage');
    assert.equal((await call(admin, 'POST', '/api/admin/transfer-bills', { client_id: cid, month: '2026-10' })).status, 409, 'pas deux relevés');
    const client = await login('claire@proprigo.test', 'demo-proprigo');
    const mine = await call(client, 'GET', `/api/transfer-bills/${bill.data.bill.id}`);
    assert.equal(mine.status, 200);
    assert.match(mine.data.iban, /FR76/);
    const inv = await call(client, 'GET', `/api/bookings/${a}/receipt`);
    assert.match(inv.data, /Paiement par virement à réception/);
    assert.match(inv.data, /PROPRIGO-R0001/);
    assert.equal((await call(admin, 'POST', `/api/admin/transfer-bills/${bill.data.bill.id}/paid`)).status, 200);
    assert.equal(app.db.prepare('SELECT paid, payment_status FROM bookings WHERE id = ?').get(b).payment_status, 'paye_virement');
    assert.match((await call(client, 'GET', `/api/bookings/${b}/receipt`)).data, /acquittée par virement/);
  } finally { app.server.close(); }
});
