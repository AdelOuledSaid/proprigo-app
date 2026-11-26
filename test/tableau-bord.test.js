'use strict';
// v1.13.0 : tableau de bord du mois (chiffre d'affaires, marge, clients)
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

test('tableau de bord : CA, marge, clients du mois et comparaison', async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', companyConfig: { regimeTVA: 'franchise' }, now: () => new Date('2026-11-20T10:00:00Z') });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const ines = app.db.prepare("SELECT id FROM users WHERE email = 'ines@proprigo.test'").get().id;
    const add = (date, status, total, hours) => app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, worker_id) VALUES (?, 'menage', ?, '75011', 'x', ?, '10:00', 0, 0, ?, 'IDF', 1, 'paye', ?, '[]', ?)`).run(cid, hours, date, total, status, ines);
    add('2026-10-10', 'terminee', 108, 3);
    add('2026-11-05', 'terminee', 108, 3); add('2026-11-12', 'terminee', 72, 2);
    add('2026-11-27', 'attribuee', 108, 3);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'admin@proprigo.test', password: 'admin-test-123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const d = await (await fetch(base + '/api/admin/dashboard', { headers: { Cookie: cookie } })).json();
    assert.equal(d.month, '2026-11');
    assert.equal(d.ca, 180, 'franchise : CA = prix payé');
    assert.equal(d.menages, 2);
    assert.ok(d.marge > 0 && d.marge < d.ca);
    assert.equal(Math.round((d.cout + d.frais + d.marge) * 100) / 100, d.ca, 'CA = intervenante + frais + marge');
    assert.equal(d.clients.actifs, 1); assert.equal(d.clients.nouveaux, 0, 'déjà venu en octobre'); assert.equal(d.clients.revenus, 1);
    assert.equal(d.prev.ca, 108);
    assert.equal(d.prevu.menages, 1);
    assert.equal(d.series.length, 6);
    const oct = await (await fetch(base + '/api/admin/dashboard?month=2026-10', { headers: { Cookie: cookie } })).json();
    assert.equal(oct.clients.nouveaux, 1);
  } finally { app.server.close(); }
});
