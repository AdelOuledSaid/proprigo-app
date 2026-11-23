'use strict';
// Double encaissement Stripe : la même réservation payée deux fois (onglet dupliqué, deux sessions…)
// doit être remboursée automatiquement, une seule fois, sans toucher au paiement retenu.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const NOW = new Date('2026-11-21T09:00:00Z');

async function setup() {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  const refunds = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://api.stripe.com/v1/refunds') {
      const p = new URLSearchParams(init.body.toString());
      const key = init.headers['Idempotency-Key'];
      const prior = refunds.find((r) => r.key === key);
      if (prior) return new Response(JSON.stringify(prior.out), { status: 200 }); // Stripe rejoue la même réponse
      const out = { id: `re_${refunds.length + 1}`, status: 'succeeded', payment_intent: p.get('payment_intent'), amount: Number(p.get('amount')) };
      refunds.push({ key, out, pi: p.get('payment_intent'), amount: Number(p.get('amount')) });
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (u.startsWith('https://api.stripe.com/v1/checkout/sessions/') && u.endsWith('/expire')) return new Response('{}', { status: 200 });
    return realFetch(url, init);
  };
  const { server, db } = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, paymentsEnabled: true, appUrl: 'https://proprigo.example' });
  await new Promise((r) => server.listen(0, r));
  const client = db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
  const booking = Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
    VALUES (?, 'menage', 3, '75011', '12 rue Test', '2026-11-28', '10:00', 0, 0, 111, 'IDF', 0, 'en_attente_paiement', 'en_attente', '[]')`).run(client).lastInsertRowid);
  const addSession = (id) => db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES (?, ?, ?, 11100, 'pending')").run(id, client, JSON.stringify([booking]));
  const send = (type, object) => {
    const raw = JSON.stringify({ type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${raw}`).digest('hex');
    return realFetch(`http://127.0.0.1:${server.address().port}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
  };
  const completed = (session, pi) => send('checkout.session.completed', { id: session, payment_status: 'paid', currency: 'eur', amount_total: 11100, payment_intent: pi });
  const intent = (pi) => send('payment_intent.succeeded', { id: pi, currency: 'eur', amount_received: 11100, metadata: { booking_ids: JSON.stringify([booking]) } });
  const done = () => {
    server.close(); global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  };
  const journal = () => db.prepare('SELECT text FROM events').all().map((e) => e.text).join('\n');
  return { db, booking, refunds, addSession, completed, intent, done, journal };
}

test('même lien Stripe payé dans deux onglets : le deuxième encaissement est remboursé une seule fois', async () => {
  const s = await setup();
  try {
    s.addSession('cs_test_tab');
    assert.equal((await s.completed('cs_test_tab', 'pi_tab1')).status, 200);
    assert.equal((await s.intent('pi_tab1')).status, 200);
    assert.equal(s.refunds.length, 0, 'le paiement retenu ne doit jamais être remboursé');
    assert.equal((await s.intent('pi_tab2')).status, 200);
    assert.equal(s.refunds.length, 1);
    assert.equal(s.refunds[0].pi, 'pi_tab2');
    assert.equal(s.refunds[0].amount, 11100);
    await s.intent('pi_tab2'); // Stripe renvoie parfois le même événement
    await s.completed('cs_test_tab', 'pi_tab1');
    assert.equal(s.refunds.length, 1, 'aucun second remboursement');
    const b = s.db.prepare('SELECT paid, payment_status FROM bookings WHERE id = ?').get(s.booking);
    assert.equal(b.paid, 1); assert.equal(b.payment_status, 'paye');
    assert.equal(s.db.prepare('SELECT status FROM stripe_duplicate_refunds WHERE payment_intent = ?').get('pi_tab2').status, 'rembourse');
    assert.match(s.journal(), /111,00 € remboursés automatiquement/);
  } finally { s.done(); }
});

test('deuxième encaissement reçu avant la confirmation de session : remboursé dès la confirmation', async () => {
  const s = await setup();
  try {
    s.addSession('cs_test_order');
    await s.intent('pi_late2');
    await s.intent('pi_first');
    assert.equal(s.refunds.length, 0, 'tant que le paiement retenu est inconnu, rien n\'est remboursé');
    await s.completed('cs_test_order', 'pi_first');
    assert.equal(s.refunds.length, 1);
    assert.equal(s.refunds[0].pi, 'pi_late2');
  } finally { s.done(); }
});

test('deux sessions différentes payées : la seconde est remboursée et marquée', async () => {
  const s = await setup();
  try {
    s.addSession('cs_test_a'); s.addSession('cs_test_b');
    await s.completed('cs_test_a', 'pi_a');
    await s.completed('cs_test_b', 'pi_b');
    await s.intent('pi_a'); await s.intent('pi_b');
    assert.equal(s.refunds.length, 1);
    assert.equal(s.refunds[0].pi, 'pi_b');
    assert.equal(s.db.prepare("SELECT status FROM stripe_payments WHERE session_id = 'cs_test_b'").get().status, 'duplicate_refunded');
    assert.equal(s.db.prepare("SELECT status FROM stripe_payments WHERE session_id = 'cs_test_a'").get().status, 'paid');
  } finally { s.done(); }
});
