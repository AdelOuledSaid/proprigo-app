'use strict';
// Lot 1 : remboursement Stripe réel, planning, « je pars / je suis arrivée », fiche de l'intervenante.
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

test('remboursement réel dans Stripe : montant exact, une seule fois, jamais au-delà du paiement', async () => {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.stripe.com/')) {
      calls.push({ url: String(url), init });
      if (String(url).includes('/checkout/sessions/')) return new Response(JSON.stringify({ id: 'cs_1', payment_intent: 'pi_123' }), { status: 200 });
      return new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const id = addBooking(db, { client: claire, date: '2026-11-25', paid: true, pay: 'a_rembourser', status: 'annulee', total: 111 });
    db.prepare('UPDATE bookings SET refund_amount = 55.5 WHERE id = ?').run(id);
    db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES ('cs_1', ?, ?, 11100, 'paid')").run(claire, JSON.stringify([id]));
    const a = await logged(...ADMIN);
    const c = await logged('claire@proprigo.test');
    assert.equal((await c('POST', `/api/admin/bookings/${id}/refund`)).status, 403, 'réservé à l\'administration');
    const r = await a('POST', `/api/admin/bookings/${id}/refund`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const refundCall = calls.find((x) => x.url.endsWith('/v1/refunds'));
    const body = new URLSearchParams(refundCall.init.body.toString());
    assert.equal(body.get('payment_intent'), 'pi_123');
    assert.equal(body.get('amount'), '5550', 'montant de la règle d\'annulation, en centimes');
    assert.equal(refundCall.init.headers['Idempotency-Key'], `proprigo-refund-${id}-5550`, 'clé fixe : pas de double remboursement');
    const b = db.prepare('SELECT payment_status, refund_id FROM bookings WHERE id = ?').get(id);
    assert.equal(b.payment_status, 'rembourse');
    assert.equal(b.refund_id, 're_1');
    assert.equal((await a('POST', `/api/admin/bookings/${id}/refund`)).status, 409, 'deuxième clic : rien à rembourser');
    // jamais plus que le paiement
    const id2 = addBooking(db, { client: claire, date: '2026-11-26', paid: true, pay: 'a_rembourser', status: 'annulee', total: 200 });
    db.prepare('UPDATE bookings SET refund_amount = 200 WHERE id = ?').run(id2);
    db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status, payment_intent) VALUES ('cs_2', ?, ?, 10000, 'paid', 'pi_2')").run(claire, JSON.stringify([id2]));
    assert.equal((await a('POST', `/api/admin/bookings/${id2}/refund`)).status, 502);
    assert.equal(db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(id2).payment_status, 'a_rembourser');
  } finally {
    server.close();
    global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});

test('sans Stripe configuré, le remboursement explique quoi faire et ne change rien', async () => {
  const { server, db, logged } = await startServer();
  try {
    const id = addBooking(db, { client: uid(db, 'claire@proprigo.test'), date: '2026-11-25', paid: true, pay: 'a_rembourser', status: 'annulee' });
    const r = await (await logged(...ADMIN))('POST', `/api/admin/bookings/${id}/refund`);
    assert.equal(r.status, 503);
    assert.match(r.data.error, /Marquer remboursé/);
  } finally { server.close(); }
});

test('planning de la semaine : intervenantes actives et ménages des 7 jours', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const fatima = uid(db, 'fatima@proprigo.test');
    addBooking(db, { client: claire, worker: fatima, date: '2026-11-23', paid: true });
    addBooking(db, { client: claire, date: '2026-11-24', paid: true, status: 'en_attente' });
    addBooking(db, { client: claire, date: '2026-12-10', paid: true, status: 'en_attente' });
    const r = await (await logged(...ADMIN))('GET', '/api/admin/planning?start=2026-11-21');
    assert.equal(r.status, 200);
    assert.equal(r.data.end, '2026-11-27');
    assert.equal(r.data.bookings.length, 2, 'seulement la semaine demandée');
    assert.ok(r.data.workers.some((w) => w.user_id === fatima));
    assert.ok(!r.data.workers.some((w) => w.name.startsWith('Mariam')), 'pas les candidates non validées');
    assert.equal((await (await logged('claire@proprigo.test'))('GET', '/api/admin/planning')).status, 403);
  } finally { server.close(); }
});

test('je pars, je suis arrivée : seulement le jour même, le client est prévenu', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const fatima = uid(db, 'fatima@proprigo.test');
    const today = addBooking(db, { client: claire, worker: fatima, date: '2026-11-21', time: '14:00', paid: true });
    const later = addBooking(db, { client: claire, worker: fatima, date: '2026-11-25', paid: true });
    const w = await logged('fatima@proprigo.test');
    assert.equal((await w('POST', `/api/worker/missions/${later}/onway`)).status, 409);
    assert.equal((await w('POST', `/api/worker/missions/${today}/onway`)).status, 200);
    assert.equal((await w('POST', `/api/worker/missions/${today}/arrived`)).status, 200);
    const b = db.prepare('SELECT on_way_at, arrived_at FROM bookings WHERE id = ?').get(today);
    assert.ok(b.on_way_at && b.arrived_at);
    const msgs = db.prepare('SELECT text FROM messages WHERE booking_id = ?').all(today).map((m) => m.text).join(' | ');
    assert.match(msgs, /en route/);
    assert.match(msgs, /est arrivée/);
    const ines = await logged('ines@proprigo.test');
    assert.equal((await ines('POST', `/api/worker/missions/${today}/onway`)).status, 404, 'pas la mission d\'une autre');
    const mine = (await (await logged('claire@proprigo.test'))('GET', '/api/bookings/mine')).data.find((x) => x.id === today);
    assert.ok(mine.on_way_at && mine.arrived_at, 'le client voit le suivi');
  } finally { server.close(); }
});

test('fiche de l\'intervenante : visible par ses clients seulement, prénom uniquement', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const fatima = uid(db, 'fatima@proprigo.test');
    const id = addBooking(db, { client: claire, worker: fatima, date: '2026-11-15', paid: true, status: 'terminee' });
    db.prepare("UPDATE bookings SET rating = 5, review = 'Impeccable, très soigneuse.' WHERE id = ?").run(id);
    const w = await logged('fatima@proprigo.test');
    assert.equal((await w('POST', '/api/worker/profile', { bio: 'Dix ans d\'expérience, j\'aime les intérieurs nets.', languages: 'Français, arabe' })).status, 200);
    const c = await logged('claire@proprigo.test');
    const card = await c('GET', `/api/workers/${fatima}/card`);
    assert.equal(card.status, 200);
    assert.equal(card.data.firstName, 'Fatima');
    assert.ok(!JSON.stringify(card.data).includes('@'), 'ni e-mail ni nom de famille');
    assert.equal(card.data.rating, 5);
    assert.equal(card.data.languages, 'Français, arabe');
    assert.equal(card.data.reviews[0].review, 'Impeccable, très soigneuse.');
    // un client qui n'a jamais eu Fatima ne voit pas sa fiche
    const ines = uid(db, 'ines@proprigo.test');
    assert.equal((await c('GET', `/api/workers/${ines}/card`)).status, 404);
  } finally { server.close(); }
});
