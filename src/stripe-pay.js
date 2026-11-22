'use strict';
const crypto = require('node:crypto');
const configured = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
const validBaseUrl = (url) => /^https:\/\/[^/]+/i.test(url);
function verifyEvent(raw, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET || typeof signature !== 'string') throw new Error('Missing signature');
  const parts = Object.fromEntries(signature.split(',').map((x) => x.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) throw new Error('Old signature');
  const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  const candidates = signature.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!candidates.some((v) => /^[a-f0-9]{64}$/.test(v) && crypto.timingSafeEqual(Buffer.from(v, 'hex'), Buffer.from(expected, 'hex')))) throw new Error('Invalid signature');
  return JSON.parse(raw.toString('utf8'));
}
async function checkout({ db, ids, clientId, email, appUrl }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (!validBaseUrl(appUrl)) throw new Error('Invalid public URL');
  const bookings = ids.map((id) => db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, clientId));
  if (bookings.some((b) => !b || b.paid || b.status === 'annulee' || b.payment_status === 'paye')) throw new Error('Invalid bookings');
  const amount = bookings.reduce((sum, b) => sum + Math.round(b.total * 100), 0);
  if (!Number.isSafeInteger(amount) || amount < 50 || amount > 99999999) throw new Error('Invalid amount');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('customer_email', email);
  params.set('payment_method_types[0]', 'card');
  params.set('line_items[0][price_data][currency]', 'eur');
  params.set('line_items[0][price_data][unit_amount]', String(amount));
  params.set('line_items[0][price_data][product_data][name]', `PROPRIGO - ${bookings.length} prestation(s) de nettoyage`);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', `${appUrl.replace(/\/$/, '')}/?stripe=success&booking=${ids[0]}#/mes-reservations`);
  params.set('cancel_url', `${appUrl.replace(/\/$/, '')}/?stripe=cancel#/mes-reservations`);
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 1800));
  let resp;
  try {
    resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: params,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Stripe Checkout network error:', { name: err.name, message: err.message, cause: err.cause?.code });
    throw new Error('Stripe Checkout network error');
  }
  let session;
  try {
    session = await resp.json();
  } catch (err) {
    console.error('Stripe Checkout invalid response:', { status: resp.status, message: err.message });
    throw new Error('Stripe Checkout invalid response');
  }
  if (!resp.ok || !session.id || !session.url) {
    console.error('Stripe Checkout error:', {
      status: resp.status,
      type: session.error?.type,
      code: session.error?.code,
      message: session.error?.message,
    });
    throw new Error('Stripe session failed');
  }
  try {
    db.prepare('INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES (?, ?, ?, ?, ?)').run(session.id, clientId, JSON.stringify(ids), amount, 'pending');
  } catch (err) {
    console.error('Stripe Checkout database error:', { code: err.code, message: err.message });
    throw err;
  }
  return { url: session.url };
}
module.exports = { configured, validBaseUrl, verifyEvent, checkout };
