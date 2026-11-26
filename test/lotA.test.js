'use strict';
// Lot A : options, abonnement, cartes cadeaux, packs d'heures.
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


test('options et abonnement : temps en plus, tâches ajoutées, −10 % en récurrent', async () => {
  const pricing = require('../src/pricing');
  const q = pricing.quote({ service: 'menage', hours: 3, cp: '75011', date: '2026-12-01', extras: ['vitres', 'four', 'inconnue'], repeat: '7' }, NOW);
  assert.ok(q.ok);
  assert.equal(q.hours, 4.5);
  assert.deepEqual(q.extras, ['vitres', 'four']);
  assert.equal(q.total, Math.round(4.5 * 36 * 0.9));
  const m = pricing.estimateMargin({ service: 'menage', total: q.total, hours: q.hours, kit: 0 }, null);
  assert.ok(m.marge / m.ht >= 0.25, 'jamais à perte avec l\'abonnement');
  assert.equal(pricing.quote({ service: 'bureau', hours: 3, cp: '75011', date: '2026-12-01', extras: ['vitres'] }, NOW).hours, 3, 'pas d\'options pour les bureaux');
  const { server, db, logged } = await startServer();
  try {
    const c = await logged('claire@proprigo.test');
    const r = await c('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Test', date: '2026-11-25', time: '09:00', extras: ['repassage'], checklist: [] });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const b = db.prepare("SELECT * FROM bookings WHERE date = '2026-11-25'").get();
    assert.equal(b.hours, 3);
    assert.match(b.checklist, /Repassage/);
    assert.equal(b.extras, '["repassage"]');
  } finally { server.close(); }
});

test('carte cadeau (démo) : code envoyé, utilisée une seule fois, crédit déduit jusqu\'à 100 %', async () => {
  const { server, db, agent, logged } = await startServer();
  try {
    const c = await logged('claire@proprigo.test');
    assert.equal((await c('POST', '/api/gifts', { amount: 77 })).status, 400);
    const g = await c('POST', '/api/gifts', { amount: 100, recipient_name: 'Maman', recipient_email: 'maman@test.fr', message: 'Joyeux Noël' });
    assert.equal(g.status, 200, JSON.stringify(g.data));
    const code = db.prepare("SELECT code FROM gift_cards WHERE kind = 'gift'").get().code;
    assert.match(code, /^PG-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const b = agent();
    assert.equal((await b('POST', '/api/signup', { name: 'Maman Test', email: 'maman@test.fr', password: 'motdepasse-123' })).status, 201);
    assert.equal((await b('POST', '/api/gifts/redeem', { code: 'PG-FAUX-CODE' })).status, 404);
    const red = await b('POST', '/api/gifts/redeem', { code: code.toLowerCase() });
    assert.equal(red.status, 200, JSON.stringify(red.data));
    assert.equal(red.data.credit, 100);
    assert.equal((await c('POST', '/api/gifts/redeem', { code })).status, 409, 'déjà utilisée');
    // ménage de 72 € : entièrement couvert, il reste 28 €
    const q = (await b('POST', '/api/quote', { service: 'menage', hours: 2, cp: '75011', date: '2026-11-25' })).data;
    assert.equal(q.total, 0);
    const r = await b('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '2 rue Test', date: '2026-11-25', time: '10:00', checklist: [] });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    assert.equal((await b('GET', '/api/gifts/mine')).data.credit, 28);
  } finally { server.close(); }
});

test('pack d\'heures (démo) : 10 h payées, 11 h créditées', async () => {
  const { server, logged } = await startServer();
  try {
    const c = await logged('claire@proprigo.test');
    const offer = (await c('GET', '/api/gifts/offer')).data;
    assert.deepEqual(offer.packs[0], { hours: 10, price: 360, credit: 396, free: 1 });
    assert.equal((await c('POST', '/api/gifts', { kind: 'pack', hours: 7 })).status, 400);
    assert.equal((await c('POST', '/api/gifts', { kind: 'pack', hours: 10 })).status, 200);
    assert.equal((await c('GET', '/api/gifts/mine')).data.credit, 396);
  } finally { server.close(); }
});

test('carte cadeau payée par Stripe : rien avant le webhook, code après, montant vérifié', async () => {
  const crypto = require('node:crypto');
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  let session = null;
  global.fetch = async (url, init = {}) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      const p = new URLSearchParams(init.body.toString());
      session = { id: 'cs_gift_1', url: 'https://checkout.stripe.com/c/pay/cs_gift_1', amount: Number(p.get('line_items[0][price_data][unit_amount]')) };
      return new Response(JSON.stringify(session), { status: 200 });
    }
    return realFetch(url, init);
  };
  const { server, db, logged } = await startServer({ paymentsEnabled: true, appUrl: 'https://proprigo.example' });
  try {
    const c = await logged('claire@proprigo.test');
    const r = await c('POST', '/api/gifts', { amount: 50, recipient_email: 'ami@test.fr' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.checkout_url);
    assert.equal(session.amount, 5000);
    assert.equal(db.prepare('SELECT status FROM gift_cards').get().status, 'pending');
    const send = async (amount) => {
      const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_gift_1', payment_status: 'paid', currency: 'eur', amount_total: amount } } });
      const t = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${raw}`).digest('hex');
      return realFetch(`http://127.0.0.1:${server.address().port}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
    };
    await send(100); // mauvais montant : ignoré
    assert.equal(db.prepare('SELECT status FROM gift_cards').get().status, 'pending');
    assert.equal((await send(5000)).status, 200);
    const g = db.prepare('SELECT * FROM gift_cards').get();
    assert.equal(g.status, 'paid');
    assert.ok(g.code);
    await send(5000); // webhook rejoué : rien ne change
    assert.equal(db.prepare('SELECT code FROM gift_cards').get().code, g.code);
  } finally {
    server.close(); global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});
