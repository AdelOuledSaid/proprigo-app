'use strict';
// v1.12.2 : prélèvement SEPA par Stripe (mandat signé sur Stripe, relevé prélevé en fin de mois)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

test('prélèvement : devis accepté → mandat Stripe → passages confirmés → relevé prélevé → payé', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_prelevement';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_prelevement';
  const stripe = require('../src/stripe-pay');
  const calls = [];
  stripe.sepaSetup = async ({ user }) => { calls.push(['setup', user.id]); return { url: 'https://checkout.stripe.com/c/pay/seti_test' }; };
  stripe.sepaSetupResult = async (id) => { calls.push(['result', id]); return { status: 'succeeded', paymentMethod: 'pm_sepa_1', mandate: 'mandate_1', last4: '3000' }; };
  stripe.sepaCharge = async ({ billId, amountCents }) => { calls.push(['charge', billId, amountCents]); return { id: 'pi_bill_1', status: 'processing' }; };
  const { createApp } = require('../src/app');
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', paymentsEnabled: true, appUrl: 'https://proprigo.example', companyConfig: { raisonSociale: 'PROPRIGO', regimeTVA: 'franchise' } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const j = (p, method = 'GET', body, cookie) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})), headers: r.headers }));
  const hook = (event) => { const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000); const sig = crypto.createHmac('sha256', 'whsec_prelevement').update(`${t}.${raw}`).digest('hex'); return fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw }); };
  try {
    await j('/api/quote-requests', 'POST', { company: 'Cabinet Martin', name: 'Paul Martin', email: 'paul@exemple.fr', cp: '75010', kind: 'bureaux', frequency: 'chaque semaine' });
    const admin = (await j('/api/login', 'POST', { email: 'admin@proprigo.test', password: 'admin-test-123' })).headers.get('set-cookie').split(';')[0];
    const q = (await j('/api/admin/quote-requests', 'GET', null, admin)).data[0];
    const sent = await j(`/api/admin/quote-requests/${q.id}/offer`, 'POST', { label: 'Bureaux', hours: 2, rate: 36, frequency: 'weekly', allowTransfer: true }, admin);
    const t = sent.data.quote.link.split('t=')[1];
    const acc = await j('/api/devis/answer', 'POST', { t, accept: true, name: 'Paul Martin', address: '12 rue de Paradis', start: '2030-01-07', time: '09:00', count: 2, password: 'motdepasse-solide', pay: 'prelevement' });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    assert.match(acc.data.checkout_url, /checkout\.stripe\.com/, 'envoyé signer le mandat');
    const uid = app.db.prepare("SELECT id FROM users WHERE email = 'paul@exemple.fr'").get().id;
    assert.ok(app.db.prepare('SELECT payment_status FROM bookings WHERE client_id = ?').all(uid).every((b) => b.payment_status === 'en_attente_paiement'), 'pas confirmés avant le mandat');
    const r1 = await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_setup_1', mode: 'setup', setup_intent: 'seti_1', metadata: { sepa_user: String(uid) } } } });
    assert.equal(r1.status, 200);
    const u = app.db.prepare('SELECT billing, sepa_pm, sepa_last4 FROM users WHERE id = ?').get(uid);
    assert.deepEqual([u.billing, u.sepa_pm, u.sepa_last4], ['prelevement', 'pm_sepa_1', '3000']);
    assert.ok(app.db.prepare('SELECT payment_status FROM bookings WHERE client_id = ?').all(uid).every((b) => b.payment_status === 'prelevement'), 'passages confirmés après le mandat');
    app.db.prepare("UPDATE bookings SET status = 'terminee', date = '2026-10-0' || id WHERE client_id = ?").run(uid);
    const bill = await j('/api/admin/transfer-bills', 'POST', { client_id: uid, month: '2026-10' }, admin);
    assert.equal(bill.status, 200, JSON.stringify(bill.data));
    assert.equal(bill.data.bill.debit_status, 'en_cours');
    assert.deepEqual(calls.find((c) => c[0] === 'charge'), ['charge', bill.data.bill.id, 14400]);
    await hook({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_bill_1', currency: 'eur', amount_received: 14400, metadata: { bill_id: String(bill.data.bill.id) } } } });
    const paid = app.db.prepare('SELECT paid_at, debit_status FROM transfer_bills WHERE id = ?').get(bill.data.bill.id);
    assert.ok(paid.paid_at); assert.equal(paid.debit_status, 'paye');
    assert.ok(app.db.prepare('SELECT payment_status FROM bookings WHERE client_id = ?').all(uid).every((b) => b.payment_status === 'paye_prelevement'));
  } finally { app.server.close(); delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; }
});
