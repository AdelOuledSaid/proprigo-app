'use strict';
// v1.9.10 : une fois l'intervenante arrivée, le client ne peut plus annuler
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

test("annulation refusée quand l'intervenante est arrivée", async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const add = (arrived) => Number(app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, worker_id, on_way_at, arrived_at)
      VALUES (?, 'menage', 3, '75011', '12 rue Test', '2030-01-10', '10:00', 0, 0, 108, 'IDF', 1, 'paye', 'attribuee', '[]', 2, ?, ?)`).run(cid, arrived ? '2030-01-10T08:40:00Z' : null, arrived ? '2030-01-10T09:00:00Z' : null).lastInsertRowid);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const cancel = (id) => fetch(`${base}/api/bookings/${id}/cancel`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    const r1 = await cancel(add(true));
    assert.equal(r1.status, 409);
    assert.match((await r1.json()).error, /déjà chez vous/);
    const r2 = await cancel(add(false));
    assert.equal(r2.status, 200, 'avant le départ, l\'annulation reste possible');
  } finally { app.server.close(); }
});
