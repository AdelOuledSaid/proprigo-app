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
