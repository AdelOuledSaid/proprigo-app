'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const stripe = require('../src/stripe-pay');
test('webhook Stripe : signature valide et payload intact', () => {
  const prev = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  try {
    const raw = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test' } } }));
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
    assert.equal(stripe.verifyEvent(raw, `t=${ts},v1=${sig}`).data.object.id, 'cs_test');
    assert.throws(() => stripe.verifyEvent(Buffer.from('{}'), `t=${ts},v1=${sig}`));
    assert.throws(() => stripe.verifyEvent(raw, `t=${ts - 1000},v1=${sig}`));
  } finally { if (prev === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prev; }
});

test('Checkout: double clic simultané ne crée pas deux sessions Stripe', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bookings(id INTEGER PRIMARY KEY, client_id INTEGER, paid INTEGER, status TEXT, payment_status TEXT, total REAL);
    CREATE TABLE stripe_payments(session_id TEXT PRIMARY KEY, client_id INTEGER, booking_ids TEXT, amount_cents INTEGER, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  db.prepare("INSERT INTO bookings VALUES (1, 5, 0, 'en_attente', 'en_attente_paiement', 111)").run();
  const oldFetch = global.fetch, oldKey = process.env.STRIPE_SECRET_KEY, oldWebhook = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
  let calls = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/checkout/sessions')) {
      calls++;
      await wait;
      return { ok: true, json: async () => ({ id: 'cs_test_one', url: 'https://checkout.stripe.com/c/test' }) };
    }
    return { ok: true, json: async () => ({ status: 'open', url: 'https://checkout.stripe.com/c/test' }) };
  };
  try {
    const args = { db, ids: [1], clientId: 5, email: 'client@example.com', appUrl: 'https://app.example.com' };
    const first = stripe.checkout(args);
    await assert.rejects(stripe.checkout(args), /already in progress/);
    release();
    assert.equal((await first).url, 'https://checkout.stripe.com/c/test');
    assert.equal((await stripe.checkout(args)).url, 'https://checkout.stripe.com/c/test');
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stripe_payments').get().n, 1);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
    if (oldWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = oldWebhook;
    db.close();
  }
});
