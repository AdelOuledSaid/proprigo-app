'use strict';
// Lot C : pages Google, avis Google, versements aux indépendantes.
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


test('pages Google : une par prestation et par lieu, plan du site, robots', async () => {
  const seo = require('../src/seo');
  assert.equal(seo.PLACES.length, 35);
  const { server } = await startServer({ appUrl: 'https://proprigo.example' });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const p = await fetch(base + '/menage-a-domicile/paris-11');
    assert.equal(p.status, 200);
    const html = await p.text();
    assert.match(html, /<title>Ménage à domicile à Paris 11e/);
    assert.match(html, /Oberkampf/);
    assert.match(html, /<link rel="canonical" href="https:\/\/proprigo.example\/menage-a-domicile\/paris-11">/);
    assert.match(html, /#\/\?cp=75011/);
    assert.match(p.headers.get('content-security-policy'), /script-src 'none'/);
    assert.match(await (await fetch(base + '/nettoyage-bureaux/boulogne-billancourt')).text(), /35 € HT de l/);
    assert.equal((await fetch(base + '/menage-a-domicile/lyon')).status, 404);
    const sm = await (await fetch(base + '/sitemap.xml')).text();
    assert.equal((sm.match(/<loc>/g) || []).length, 1 + 3 * 35);
    assert.match(await (await fetch(base + '/robots.txt')).text(), /Sitemap: https:\/\/proprigo.example\/sitemap.xml/);
  } finally { server.close(); }
});

test('avis Google : le lien n\'est donné que s\'il est configuré et sûr', async () => {
  for (const [url, expected] of [['https://g.page/r/proprigo/review', 'https://g.page/r/proprigo/review'], ['javascript:alert(1)', ''], ['', '']]) {
    const { server, agent } = await startServer({ googleReviewUrl: url });
    try { assert.equal((await agent()('GET', '/api/config')).data.googleReviewUrl, expected); } finally { server.close(); }
  }
});

test('versements aux indépendantes : par semaine, bonus de niveau, jamais deux fois', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const ines = uid(db, 'ines@proprigo.test');
    const fatima = uid(db, 'fatima@proprigo.test');
    const ids = ['2026-11-09', '2026-11-10', '2026-11-16'].map((d) => addBooking(db, { client: claire, worker: ines, date: d, paid: true, status: 'terminee' }));
    addBooking(db, { client: claire, worker: fatima, date: '2026-11-10', paid: true, status: 'terminee' }); // salariée : pas de versement
    const a = await logged(...ADMIN);
    let p = (await a('GET', '/api/admin/payouts')).data;
    assert.equal(p.owed.length, 2, 'deux semaines');
    assert.equal(p.owed[0].week_start, '2026-11-09');
    assert.equal(p.owed[0].amount, 2 * 3 * 24);
    assert.ok(!p.owed.some((o) => o.worker_id === fatima));
    assert.equal((await a('POST', '/api/admin/payouts', { worker_id: ines, week_start: '2026-11-09', reference: 'VIR-001' })).status, 200);
    assert.equal((await a('POST', '/api/admin/payouts', { worker_id: ines, week_start: '2026-11-09' })).status, 409, 'jamais deux fois');
    p = (await a('GET', '/api/admin/payouts')).data;
    assert.equal(p.owed.length, 1);
    // bonus de niveau : 5 avis à 5/5, mais pas encore assez de ménages pour le Platine → pas de bonus
    for (const id of ids) db.prepare('UPDATE bookings SET rating = 5 WHERE id = ?').run(id);
    for (let i = 0; i < 2; i++) db.prepare('UPDATE bookings SET rating = 5 WHERE id = ?').run(addBooking(db, { client: claire, worker: ines, date: '2026-11-17', paid: true, status: 'terminee' }));
    p = (await a('GET', '/api/admin/payouts')).data;
    assert.equal(p.owed[0].bonus_rate, 0, 'Bleu : pas de bonus');
    // le responsable abaisse le seuil du Platine à 5 ménages : +1 € de l'heure
    assert.equal((await a('POST', '/api/admin/tiers', { or: { missions: 3, rating: 4.6, bonus: 0 }, platine: { missions: 5, rating: 4.8, bonus: 1 } })).status, 200);
    p = (await a('GET', '/api/admin/payouts')).data;
    assert.equal(p.owed[0].bonus_rate, 1);
    assert.equal(p.owed[0].amount, 3 * 3 * 25, '3 ménages de 3 h à 24 + 1 €');
    const i = await logged('ines@proprigo.test');
    const g = (await i('GET', '/api/worker/earnings')).data;
    assert.equal(g.bonus.eligible, true);
    assert.equal(g.pending, 225);
    assert.equal(g.paid[0].amount, 144);
    const pl = await logged(...ADMIN);
    void pl;
  } finally { server.close(); }
});
