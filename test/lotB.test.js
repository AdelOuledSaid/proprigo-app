'use strict';
// Lot B : espace entreprises.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const NOW = new Date('2026-11-21T09:00:00Z'); // samedi 21 novembre, 10 h à Paris
const ADMIN = ['admin@proprigo.test', 'admin-test-123'];

async function startServer(opts = {}) {
  const { server, db } = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  const logged = async (email, password = 'demo-proprigo') => {
    const a = agent();
    assert.equal((await a('POST', '/api/login', { email, password })).status, 200);
    return a;
  };
  return { server, db, agent, logged };
}
const uid = (db, email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const addBooking = (db, f) => Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, worker_id, checklist)
  VALUES (?, 'menage', 3, '75011', '12 rue Test', ?, ?, 0, 0, ?, 'IDF', ?, ?, ?, ?, '[]')`).run(f.client, f.date, f.time || '10:00', f.total || 111, f.paid ? 1 : 0, f.pay || 'paye', f.status || 'attribuee', f.worker || null).lastInsertRowid);


test('société : facture à son nom, SIRET et TVA vérifiés', async () => {
  const { server, db, logged } = await startServer();
  try {
    const c = await logged('claire@proprigo.test');
    assert.equal((await c('POST', '/api/account/company', { company: 'Conciergerie Test', siret: '123' })).status, 400);
    assert.equal((await c('POST', '/api/account/company', { company: 'Conciergerie Test', siret: '123 456 789 00012', vat_number: 'fr12345678901', billing_address: '5 rue du Siège, 75009 Paris' })).status, 200);
    const info = (await c('GET', '/api/account/company')).data;
    assert.equal(info.siret, '12345678900012');
    assert.equal(info.vat_number, 'FR12345678901');
    const id = addBooking(db, { client: uid(db, 'claire@proprigo.test'), date: '2026-11-15', paid: true, status: 'terminee' });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(base + `/api/bookings/${id}/receipt`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /Facturé à<\/b><br>Conciergerie Test/);
    assert.match(html, /SIRET : 12345678900012/);
  } finally { server.close(); }
});

test('remise volume : seulement pour une société, prestations pro, jamais cumulée ni envoyée par le navigateur', async () => {
  const pricing = require('../src/pricing');
  const { server, db, logged } = await startServer();
  try {
    const cid = uid(db, 'claire@proprigo.test');
    const c = await logged('claire@proprigo.test');
    const q0 = (await c('POST', '/api/quote', { service: 'bureau', hours: 3, cp: '75008', date: '2026-11-30', volume: 0.1 })).data;
    assert.equal(q0.total, 126, 'la remise envoyée par le navigateur est ignorée');
    for (let i = 0; i < 10; i++) addBooking(db, { client: cid, date: '2026-11-2' + (i % 8 + 1), paid: true });
    assert.equal((await c('POST', '/api/quote', { service: 'bureau', hours: 3, cp: '75008', date: '2026-11-30' })).data.total, 126, 'pas de société : pas de remise');
    await c('POST', '/api/account/company', { company: 'Bureaux Test' });
    const q1 = (await c('POST', '/api/quote', { service: 'bureau', hours: 3, cp: '75008', date: '2026-11-30' })).data;
    assert.equal(q1.total, Math.round(126 * 0.95));
    assert.ok(q1.lines.some((l) => /Remise volume/.test(l.label)));
    assert.equal((await c('POST', '/api/quote', { service: 'menage', hours: 3, cp: '75011', date: '2026-11-30' })).data.total, 111, 'pas de remise volume sur le ménage à domicile');
    for (let i = 0; i < 20; i++) addBooking(db, { client: cid, date: '2026-11-2' + (i % 8 + 1), paid: true });
    const q2 = (await c('POST', '/api/quote', { service: 'bureau', hours: 3, cp: '75008', date: '2026-11-30', repeat: '7' })).data;
    assert.equal(q2.total, Math.round(126 * 0.9), '−10 %, sans y ajouter l\'abonnement');
    for (const [svc, extra] of [['bureau', {}], ['airbnb', { size: 'T2' }]]) {
      const q = pricing.quote({ service: svc, hours: 3, cp: '75008', date: '2026-11-30', volume: 0.1, ...extra }, NOW);
      const m = pricing.estimateMargin({ service: svc, size: extra.size, total: q.total, hours: q.hours, kit: 0 }, null);
      assert.ok(m.marge / m.ht >= 0.2, `${svc} : marge ${Math.round((m.marge / m.ht) * 100)} %`);
    }
  } finally { server.close(); }
});

test('demande de devis : enregistrée, visible par l\'équipe, limitée', async () => {
  const { server, agent, logged } = await startServer();
  try {
    const a = agent();
    assert.equal((await a('POST', '/api/quote-requests', { company: 'Agence Test', name: 'Lina', email: 'lina@agence.fr', cp: '75015', kind: 'nimporte' })).status, 400);
    const r = await a('POST', '/api/quote-requests', { company: 'Agence Test', name: 'Lina Test', email: 'lina@agence.fr', cp: '75015', kind: 'agence', surface: 60, frequency: '4 fins de bail par mois', message: 'Bonjour' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const adm = await logged(...ADMIN);
    const list = (await adm('GET', '/api/admin/quote-requests')).data;
    assert.equal(list[0].company, 'Agence Test');
    assert.equal((await adm('GET', '/api/admin/overview')).data.quoteRequests, 1);
    assert.equal((await adm('POST', `/api/admin/quote-requests/${list[0].id}/done`)).status, 200);
    assert.equal((await adm('GET', '/api/admin/overview')).data.quoteRequests, 0);
    for (let i = 0; i < 4; i++) await a('POST', '/api/quote-requests', { company: 'X', name: 'Y', email: 'y@x.fr', cp: '75015', kind: 'autre' });
    assert.equal((await a('POST', '/api/quote-requests', { company: 'X', name: 'Y', email: 'y@x.fr', cp: '75015', kind: 'autre' })).status, 429);
  } finally { server.close(); }
});

test('bureaux : créneaux de 6 h à 22 h, ménages longs avec options possibles', async () => {
  const engine = require('../src/engine');
  const b = engine.requestSlots({ hours: 2, service: 'bureau' });
  assert.equal(b[0], '06:00'); assert.equal(b[b.length - 1], '20:00');
  const m = engine.requestSlots({ hours: 2, service: 'menage' });
  assert.equal(m[0], '07:00'); assert.equal(m[m.length - 1], '18:00');
  assert.ok(engine.requestSlots({ hours: 10.5, service: 'grand' }).length > 0);
});
