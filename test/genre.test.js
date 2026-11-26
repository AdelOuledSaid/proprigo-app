'use strict';
// v1.12.0 : « intervenant » au masculin quand c'est un homme
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');

test('genre : enregistré par le responsable et renvoyé au client', async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = async (email, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0];
  try {
    const admin = await login('admin@proprigo.test', 'admin-test-123');
    const wid = app.db.prepare("SELECT id FROM users WHERE email = 'ines@proprigo.test'").get().id;
    const r = await fetch(`${base}/api/admin/workers/${wid}/gender`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: admin }, body: JSON.stringify({ gender: 'h' }) });
    assert.equal(r.status, 200);
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, worker_id) VALUES (?, 'menage', 3, '75011', 'x', '2030-01-10', '10:00', 0, 0, 108, 'IDF', 1, 'paye', 'attribuee', '[]', ?)`).run(cid, wid);
    const client = await login('claire@proprigo.test', 'demo-proprigo');
    const list = await (await fetch(base + '/api/bookings/mine', { headers: { Cookie: client } })).json();
    assert.equal(list.find((b) => b.worker_id === wid).worker_gender, 'h');
  } finally { app.server.close(); }
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(ui, /const GW = \(g\) => \(g === 'h' \? \{ N: 'Intervenant'/);
});
