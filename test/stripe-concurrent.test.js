'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const stripe = require('../src/stripe-pay');
test('two concurrent checkout requests reuse one Stripe session', async () => {
  const oldFetch = global.fetch;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  const oldWebhook = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bookings(id INTEGER PRIMARY KEY, client_id INTEGER, paid INTEGER, status TEXT, payment_status TEXT, total REAL);
    CREATE TABLE stripe_payments(session_id TEXT PRIMARY KEY, client_id INTEGER, booking_ids TEXT, amount_cents INTEGER, status TEXT, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO bookings VALUES(17, 3, 0, 'en_attente', 'en_attente_paiement', 111);`);
  let creates = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/v1/checkout/sessions')) { creates++; await new Promise(r => setTimeout(r, 20)); return { ok: true, json: async () => ({ id: 'cs_test_one', url: 'https://checkout.stripe.com/test' }) }; }
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const args = { db, ids: [17], clientId: 3, email: 'test@example.com', appUrl: 'https://example.com' };
    const [a,b] = await Promise.all([stripe.checkout(args), stripe.checkout(args)]);
    assert.deepEqual(a,b);
    assert.equal(creates,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stripe_payments').get().n,1);
  } finally {
    global.fetch = oldFetch;
    db.close();
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
    if (oldWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = oldWebhook;
  }
});
