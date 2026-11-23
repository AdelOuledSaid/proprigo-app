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
  // Verrou persistant et idempotence : un seul appel Stripe à la fois pour la réservation.
  // En cas de timeout, le prochain essai reprend EXACTEMENT la même requête et la même clé.
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_checkout_attempts (
    booking_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL, lock_until INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, session_url TEXT, state TEXT NOT NULL DEFAULT 'creating'
  )`);
  const bookingKey = `${clientId}:${ids.join(',')}`;
  const now = Math.floor(Date.now() / 1000);
  const existingPayment = db.prepare("SELECT session_id FROM stripe_payments WHERE client_id = ? AND booking_ids = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(clientId, JSON.stringify(ids));
  if (existingPayment) {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(existingPayment.session_id)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000),
    });
    const old = await r.json();
    if (!r.ok) throw new Error('Stripe session lookup failed');
    if (old.status === 'open' && old.url) return { url: old.url };
    if (old.payment_status === 'paid') throw new Error('Payment already completed; awaiting webhook');
  }
  let attempt;
  db.exec('BEGIN IMMEDIATE');
  try {
    attempt = db.prepare('SELECT * FROM stripe_checkout_attempts WHERE booking_key = ?').get(bookingKey);
    if (attempt && attempt.lock_until > now) throw new Error('Checkout already in progress; retry shortly');
    // Ne jamais remplacer une tentative incertaine avant son expiration Stripe.
    // Un éventuel appel précédent peut avoir abouti malgré une réponse réseau perdue.
    if (!attempt || (attempt.expires_at < now && attempt.state === 'expired')) {
      const attemptId = crypto.randomUUID();
      attempt = { booking_key: bookingKey, attempt_id: attemptId,
        idempotency_key: `proprigo-checkout-${attemptId}`, expires_at: now + 1800,
        session_id: null, session_url: null, state: 'creating' };
      db.prepare(`INSERT INTO stripe_checkout_attempts
        (booking_key,attempt_id,idempotency_key,expires_at,lock_until,session_id,session_url,state)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(booking_key) DO UPDATE SET
        attempt_id=excluded.attempt_id,idempotency_key=excluded.idempotency_key,
        expires_at=excluded.expires_at,lock_until=excluded.lock_until,
        session_id=NULL,session_url=NULL,state=excluded.state`).run(
        bookingKey, attempt.attempt_id, attempt.idempotency_key, attempt.expires_at, now + 25,
        null, null, 'creating');
    } else {
      db.prepare('UPDATE stripe_checkout_attempts SET lock_until = ? WHERE booking_key = ?').run(now + 25, bookingKey);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  try {
    if (attempt.session_id) {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(attempt.session_id)}`, {
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000),
      });
      const old = await r.json();
      if (!r.ok) throw new Error('Stripe session lookup failed');
      if (old.status === 'open' && old.url) return { url: old.url };
      if (old.payment_status === 'paid') throw new Error('Payment already completed; awaiting webhook');
      if (old.status === 'expired') {
        db.prepare("UPDATE stripe_checkout_attempts SET state = 'expired' WHERE booking_key = ?").run(bookingKey);
        throw new Error('Stripe session expired; retry to start a new checkout');
      }
      throw new Error('Stripe session not available');
    }
    if (attempt.expires_at <= now) {
      // Stripe interdit de recréer la même requête avec un nouveau expires_at sous la même clé.
      // La tentative expirée est libérée uniquement après vérification dans le Dashboard.
      throw new Error('Checkout state uncertain; manual reconciliation required');
    }
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('customer_email', email);
    params.set('line_items[0][price_data][currency]', 'eur');
    params.set('line_items[0][price_data][unit_amount]', String(amount));
    params.set('line_items[0][price_data][product_data][name]', `PROPRIGO - ${bookings.length} prestation(s) de nettoyage`);
    params.set('line_items[0][quantity]', '1');
    params.set('metadata[booking_ids]', ids.join(','));
    params.set('metadata[client_id]', String(clientId));
    params.set('success_url', `${appUrl.replace(/\/$/, '')}/?stripe=success&booking=${ids[0]}#/mes-reservations`);
    params.set('cancel_url', `${appUrl.replace(/\/$/, '')}/?stripe=cancel#/mes-reservations`);
    params.set('expires_at', String(attempt.expires_at));
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': attempt.idempotency_key,
      }, body: params, signal: AbortSignal.timeout(15000),
    });
    const session = await resp.json();
    if (!resp.ok || !session.id || !session.url) {
      console.error('Stripe Checkout error:', { status: resp.status, code: session.error?.code, message: session.error?.message });
      throw new Error('Stripe session failed');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES (?, ?, ?, ?, ?)')
        .run(session.id, clientId, JSON.stringify(ids), amount, 'pending');
      db.prepare("UPDATE stripe_checkout_attempts SET session_id=?,session_url=?,state='open' WHERE booking_key=?")
        .run(session.id, session.url, bookingKey);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { url: session.url };
  } finally {
    db.prepare('UPDATE stripe_checkout_attempts SET lock_until=0 WHERE booking_key=? AND attempt_id=?')
      .run(bookingKey, attempt.attempt_id);
  }
}
/**
 * Remboursement réel dans Stripe. La clé d'idempotence est fixe pour une réservation et un montant :
 * deux clics ou deux essais ne peuvent jamais rembourser deux fois.
 */
async function refund({ db, bookingId, amountCents }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error('Invalid amount');
  const pay = db.prepare("SELECT * FROM stripe_payments WHERE status = 'paid' AND EXISTS (SELECT 1 FROM json_each(booking_ids) WHERE value = ?) ORDER BY created_at DESC LIMIT 1").get(bookingId);
  if (!pay) throw new Error('No Stripe payment for this booking');
  if ((pay.refunded_cents || 0) + amountCents > pay.amount_cents) throw new Error('Refund exceeds payment');
  let pi = pay.payment_intent;
  if (!pi) {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(pay.session_id)}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000) });
    const sess = await r.json().catch(() => ({}));
    if (!r.ok || !sess.payment_intent) throw new Error('Payment intent not found');
    pi = typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.payment_intent.id;
    db.prepare('UPDATE stripe_payments SET payment_intent = ? WHERE session_id = ?').run(pi, pay.session_id);
  }
  const params = new URLSearchParams({ payment_intent: pi, amount: String(amountCents), 'metadata[booking_id]': String(bookingId) });
  let resp;
  try {
    resp = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `proprigo-refund-${bookingId}-${amountCents}` },
      body: params, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Stripe refund network error:', { name: err.name, message: err.message });
    throw new Error('Stripe refund network error');
  }
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok || !out.id || !['succeeded', 'pending'].includes(out.status)) {
    console.error('Stripe refund error:', { status: resp.status, code: out.error?.code, message: out.error?.message });
    throw new Error(out.error?.message ? `Stripe : ${out.error.message}` : 'Stripe refund failed');
  }
  db.exec('CREATE TABLE IF NOT EXISTS stripe_refund_ledger (refund_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, amount_cents INTEGER NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare('INSERT OR IGNORE INTO stripe_refund_ledger (refund_id, session_id, amount_cents) VALUES (?, ?, ?)').run(out.id, pay.session_id, amountCents);
    if (inserted.changes) db.prepare('UPDATE stripe_payments SET refunded_cents = COALESCE(refunded_cents, 0) + ? WHERE session_id = ?').run(amountCents, pay.session_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { id: out.id, status: out.status };
}
/** Paiement d'une carte cadeau ou d'un pack d'heures : une session Stripe dédiée, reconnue par son identifiant. */
async function checkoutGift({ db, gift, email, appUrl }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (!validBaseUrl(appUrl)) throw new Error('Invalid public URL');
  const amount = Math.round(gift.price * 100);
  if (!Number.isSafeInteger(amount) || amount < 50 || amount > 500000) throw new Error('Invalid amount');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('customer_email', email);
  params.set('line_items[0][price_data][currency]', 'eur');
  params.set('line_items[0][price_data][unit_amount]', String(amount));
  params.set('line_items[0][price_data][product_data][name]', gift.kind === 'pack' ? `PROPRIGO - Pack ${gift.hours} h de ménage` : `PROPRIGO - Carte cadeau ${gift.amount} €`);
  params.set('line_items[0][quantity]', '1');
  params.set('metadata[gift_id]', String(gift.id));
  params.set('success_url', `${appUrl.replace(/\/$/, '')}/?stripe=success&gift=${gift.id}#/cadeau`);
  params.set('cancel_url', `${appUrl.replace(/\/$/, '')}/?stripe=cancel#/cadeau`);
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 1800));
  let resp;
  try {
    resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `proprigo-gift-${gift.id}` },
      body: params, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Stripe gift checkout network error:', { name: err.name, message: err.message });
    throw new Error('Stripe network error');
  }
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok || !out.id || !out.url) { console.error('Stripe gift checkout error:', { status: resp.status, message: out.error?.message }); throw new Error('Stripe checkout failed'); }
  db.prepare('UPDATE gift_cards SET session_id = ?, amount_cents = ? WHERE id = ?').run(out.id, amount, gift.id);
  return { url: out.url };
}
module.exports = { configured, validBaseUrl, verifyEvent, checkout, refund, checkoutGift };
