'use strict';
// Paiement en deux temps : Stripe bloque le montant, PROPRIGO encaisse le premier paiement
// et annule les autres. Une réservation ne peut plus être débitée deux fois.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const NOW = new Date('2026-11-21T09:00:00Z');

async function setup() {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  const intents = new Map(); // faux Stripe : état de chaque PaymentIntent
  const sessionOf = new Map();
  const calls = { capture: [], cancel: [], refund: [], create: [] };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return realFetch(url, init);
    const path = u.slice('https://api.stripe.com'.length);
    let m;
    if (path === '/v1/checkout/sessions' && init.method === 'POST') {
      const p = new URLSearchParams(init.body.toString());
      calls.create.push(Object.fromEntries(p));
      return json({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    }
    if ((m = path.match(/^\/v1\/payment_intents\/(pi_\w+)\/capture$/))) {
      const pi = intents.get(m[1]); calls.capture.push(m[1]);
      if (pi.status !== 'requires_capture') return json({ error: { code: 'payment_intent_unexpected_state' } }, 400);
      pi.status = 'succeeded'; pi.amount_received = pi.amount_capturable; pi.amount_capturable = 0;
      return json(pi);
    }
    if ((m = path.match(/^\/v1\/payment_intents\/(pi_\w+)\/cancel$/))) {
      const pi = intents.get(m[1]); calls.cancel.push(m[1]);
      if (pi.status !== 'requires_capture') return json({ error: { code: 'payment_intent_unexpected_state' } }, 400);
      pi.status = 'canceled'; pi.amount_capturable = 0;
      return json(pi);
    }
    if ((m = path.match(/^\/v1\/payment_intents\/(pi_\w+)$/))) return json(intents.get(m[1]));
    if ((m = path.match(/^\/v1\/checkout\/sessions\?payment_intent=(pi_\w+)/))) return json({ data: sessionOf.has(m[1]) ? [{ id: sessionOf.get(m[1]) }] : [] });
    if (path.endsWith('/expire')) return json({});
    if (path === '/v1/refunds') { const p = new URLSearchParams(init.body.toString()); calls.refund.push(p.get('payment_intent')); return json({ id: 're_1', status: 'succeeded' }); }
    throw new Error('unexpected Stripe call ' + path);
  };
  const { server, db } = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, paymentsEnabled: true, appUrl: 'https://proprigo.example' });
  await new Promise((r) => server.listen(0, r));
  const client = db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
  const booking = Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
    VALUES (?, 'menage', 3, '75011', '12 rue Test', '2026-11-28', '10:00', 0, 0, 111, 'IDF', 0, 'en_attente_paiement', 'en_attente', '[]')`).run(client).lastInsertRowid);
  db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES ('cs_test_tab', ?, ?, 11100, 'pending')").run(client, JSON.stringify([booking]));
  // le client valide « Payer » dans un onglet : Stripe bloque le montant
  const authorize = (id, session = 'cs_test_tab', amount = 11100) => {
    intents.set(id, { id, status: 'requires_capture', currency: 'eur', amount_capturable: amount, amount_received: 0, metadata: { booking_ids: JSON.stringify([booking]), client_id: String(client) } });
    sessionOf.set(id, session);
  };
  const send = (type, object) => {
    const raw = JSON.stringify({ type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${raw}`).digest('hex');
    return realFetch(`http://127.0.0.1:${server.address().port}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
  };
  const capturable = (id) => send('payment_intent.amount_capturable_updated', { id });
  const completed = (session, pi) => send('checkout.session.completed', { id: session, payment_status: 'unpaid', currency: 'eur', amount_total: 11100, payment_intent: pi });
  const done = () => {
    server.close(); global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  };
  const bookingRow = () => ({ ...db.prepare('SELECT paid, payment_status FROM bookings WHERE id = ?').get(booking) });
  const journal = () => db.prepare('SELECT text FROM events').all().map((e) => e.text).join('\n');
  return { db, client, booking, intents, calls, authorize, capturable, completed, done, bookingRow, journal };
}

test('la session Stripe demande un paiement par carte en deux temps', async () => {
  const s = await setup();
  try {
    s.db.prepare("UPDATE stripe_payments SET status = 'expired'").run();
    const stripe = require('../src/stripe-pay');
    await stripe.checkout({ db: s.db, ids: [s.booking], clientId: s.client, email: 'c@test.fr', appUrl: 'https://proprigo.example' });
    const p = s.calls.create[0];
    assert.equal(p['payment_intent_data[capture_method]'], 'manual');
    assert.equal(p['allowed_payment_method_types[0]'], 'card', 'nouveau nom exigé par l\'API Stripe du 30/09/2026');
    assert.equal(p['payment_method_types[0]'], undefined, 'ancien paramètre refusé par Stripe');
    assert.equal(p['payment_intent_data[metadata][client_id]'], String(s.client));
  } finally { s.done(); }
});

test('deux onglets : le premier paiement est encaissé, le second est annulé sans débit', async () => {
  const s = await setup();
  try {
    s.authorize('pi_tab1');
    assert.equal((await s.completed('cs_test_tab', 'pi_tab1')).status, 200);
    assert.equal(s.intents.get('pi_tab1').status, 'succeeded');
    assert.deepEqual(s.bookingRow(), { paid: 1, payment_status: 'paye' });
    assert.equal(s.db.prepare("SELECT status, payment_intent FROM stripe_payments WHERE session_id = 'cs_test_tab'").get().payment_intent, 'pi_tab1');

    s.authorize('pi_tab2'); // « Payer » dans le deuxième onglet
    assert.equal((await s.capturable('pi_tab2')).status, 200);
    assert.equal(s.intents.get('pi_tab2').status, 'canceled', 'le deuxième paiement ne doit jamais être encaissé');
    assert.equal(s.intents.get('pi_tab1').status, 'succeeded');
    assert.deepEqual(s.calls.refund, [], 'rien à rembourser : rien n\'a été débité');
    assert.match(s.journal(), /Paiement en double bloqué .*111,00 € non encaissés/);

    // webhooks rejoués par Stripe : aucun effet supplémentaire
    await s.capturable('pi_tab1'); await s.capturable('pi_tab2'); await s.completed('cs_test_tab', 'pi_tab1');
    assert.equal(s.calls.capture.filter((x) => x === 'pi_tab2').length, 0);
    assert.equal(s.calls.cancel.length, 1);
    assert.deepEqual(s.bookingRow(), { paid: 1, payment_status: 'paye' });
  } finally { s.done(); }
});

test('les deux onglets validés presque en même temps : un seul encaissement', async () => {
  const s = await setup();
  try {
    s.authorize('pi_a'); s.authorize('pi_b');
    await Promise.all([s.capturable('pi_a'), s.capturable('pi_b'), s.completed('cs_test_tab', 'pi_a')]);
    const states = ['pi_a', 'pi_b'].map((id) => s.intents.get(id).status).sort();
    assert.deepEqual(states, ['canceled', 'succeeded']);
    assert.deepEqual(s.bookingRow(), { paid: 1, payment_status: 'paye' });
  } finally { s.done(); }
});

test('réservation annulée avant l\'encaissement : le paiement bloqué est relâché', async () => {
  const s = await setup();
  try {
    s.db.prepare("UPDATE bookings SET status = 'annulee' WHERE id = ?").run(s.booking);
    s.authorize('pi_late');
    await s.capturable('pi_late');
    assert.equal(s.intents.get('pi_late').status, 'canceled');
    assert.equal(s.bookingRow().paid, 0);
  } finally { s.done(); }
});

test('montant bloqué différent du prix : refusé', async () => {
  const s = await setup();
  try {
    s.authorize('pi_bad', 'cs_test_tab', 100);
    await s.capturable('pi_bad');
    assert.equal(s.intents.get('pi_bad').status, 'canceled');
    assert.equal(s.bookingRow().paid, 0);
  } finally { s.done(); }
});

test('API Stripe du 30/09/2026 : l\'ancien paramètre est refusé, le nouveau passe ; compte ancien : second essai', async () => {
  const realFetch = global.fetch;
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const { createApp: mk } = require('../src/app');
  const stripe = require('../src/stripe-pay');
  const run = async (apiVersion) => {
    const calls = [];
    global.fetch = async (url, init) => {
      if (String(url) !== 'https://api.stripe.com/v1/checkout/sessions') return realFetch(url, init);
      const p = new URLSearchParams(init.body.toString());
      calls.push(p);
      if (apiVersion === 'endive' && p.has('payment_method_types[0]')) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'The `payment_method_types` parameter is no longer supported when creating a Checkout Session.' } }), { status: 400 });
      if (apiVersion === 'ancienne' && p.has('allowed_payment_method_types[0]')) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', param: 'allowed_payment_method_types', message: 'Received unknown parameter: allowed_payment_method_types' } }), { status: 400 });
      return new Response(JSON.stringify({ id: 'cs_test_ok', url: 'https://checkout.stripe.com/c/pay/cs_test_ok' }), { status: 200 });
    };
    const app = mk({ dbFile: ':memory:', adminPassword: 'admin-test-123', paymentsEnabled: true, appUrl: 'https://proprigo.example' });
    try {
      const client = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
      const id = Number(app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
        VALUES (?, 'menage', 3, '75011', '1 rue', '2026-12-28', '10:00', 0, 0, 111, 'IDF', 0, 'en_attente_paiement', 'en_attente', '[]')`).run(client).lastInsertRowid);
      const s = await stripe.checkout({ db: app.db, ids: [id], clientId: client, email: 'c@test.fr', appUrl: 'https://proprigo.example' });
      return { url: s.url, calls };
    } finally { app.server.close(); }
  };
  try {
    const now = await run('endive');
    assert.equal(now.url, 'https://checkout.stripe.com/c/pay/cs_test_ok');
    assert.equal(now.calls.length, 1, 'un seul envoi, accepté du premier coup');
    const old = await run('ancienne');
    assert.equal(old.url, 'https://checkout.stripe.com/c/pay/cs_test_ok');
    assert.equal(old.calls.length, 2);
    assert.equal(old.calls[1].get('payment_method_types[0]'), 'card');
  } finally {
    global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});
