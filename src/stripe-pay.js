'use strict';
const crypto = require('node:crypto');
// Serialize checkout creation for the same booking within one Node process.
const checkoutLocks = new Map();
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
  const key = `${clientId}:${[...ids].sort((a,b) => a-b).join(',')}`;
  const previous = checkoutLocks.get(key);
  if (previous) return previous;
  const pending = checkoutUnlocked({ db, ids, clientId, email, appUrl });
  checkoutLocks.set(key, pending);
  try { return await pending; }
  finally { if (checkoutLocks.get(key) === pending) checkoutLocks.delete(key); }
}
async function checkoutUnlocked({ db, ids, clientId, email, appUrl }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (!validBaseUrl(appUrl)) throw new Error('Invalid public URL');
  const bookings = ids.map((id) => db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(id, clientId));
  if (bookings.some((b) => !b || b.paid || b.status === 'annulee' || b.payment_status === 'paye')) throw new Error('Invalid bookings');
  const amount = bookings.reduce((sum, b) => sum + Math.round(b.total * 100), 0);
  if (!Number.isSafeInteger(amount) || amount < 50 || amount > 99999999) throw new Error('Invalid amount');
  // Une reservation en attente peut deja avoir une session Checkout ouverte.
  // La reutiliser plutot que creer un second paiement pour le meme menage.
  const previous = db.prepare("SELECT session_id FROM stripe_payments WHERE client_id = ? AND booking_ids = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(clientId, JSON.stringify(ids));
  if (previous) {
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(previous.session_id)}`, {
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000),
      });
      const old = await r.json();
      if (r.ok && old.status === 'open' && old.url) return { url: old.url };
      if (r.ok && (old.payment_status === 'paid' || old.status === 'complete')) throw new Error('Payment already completed; awaiting webhook');
      if (!r.ok) throw new Error(`Stripe session lookup failed (${r.status})`);
    } catch (err) {
      console.error('Stripe Checkout existing session:', { message: err.message });
      throw err; // Ne jamais creer un deuxieme paiement si l'etat du premier est inconnu.
    }
  }
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('customer_email', email);
  params.set('metadata[booking_ids]', JSON.stringify(ids));
  params.set('payment_intent_data[metadata][booking_ids]', JSON.stringify(ids));
  params.set('payment_intent_data[metadata][client_id]', String(clientId));
  // Paiement en deux temps : Stripe bloque le montant, PROPRIGO n'encaisse que le premier
  // paiement autorisé pour une réservation et annule les autres (aucun débit en double).
  params.set('payment_intent_data[capture_method]', 'manual');
  // Carte seulement (Apple Pay et Google Pay compris). Depuis l'API Stripe du 30/09/2026 (« endive »),
  // payment_method_types est refusé : on utilise allowed_payment_method_types. Pour un compte encore
  // sur une version plus ancienne, voir plus bas : un second essai avec l'ancien nom.
  params.set('allowed_payment_method_types[0]', 'card');
  
  params.set('line_items[0][price_data][currency]', 'eur');
  params.set('line_items[0][price_data][unit_amount]', String(amount));
  params.set('line_items[0][price_data][product_data][name]', `PROPRIGO - ${bookings.length} prestation(s) de nettoyage`);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', `${appUrl.replace(/\/$/, '')}/?stripe=success&booking=${ids[0]}#/mes-reservations`);
  params.set('cancel_url', `${appUrl.replace(/\/$/, '')}/?stripe=cancel#/mes-reservations`);
  // Stripe exige au moins 30 minutes entre la création et l'expiration : 35 minutes laissent une marge
  // (horloges légèrement décalées, réseau lent).
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 35 * 60));
  const send = async () => {
    let resp;
    try {
      resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Clé anti-doublon tirée de la demande exacte : deux envois identiques (double clic) donnent la même
          // session ; une demande différente (heure d'expiration, montant…) ne réutilise jamais une ancienne clé.
          'Idempotency-Key': `proprigo-checkout-${crypto.createHash('sha256').update(`${clientId}:${ids.join(',')}:${params.toString()}`).digest('hex')}`,
        },
        body: params,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      console.error('Stripe Checkout network error:', { name: err.name, message: err.message, cause: err.cause?.code });
      throw new Error('Stripe Checkout network error');
    }
    let body;
    try {
      body = await resp.json();
    } catch (err) {
      console.error('Stripe Checkout invalid response:', { status: resp.status, message: err.message });
      throw new Error('Stripe Checkout invalid response');
    }
    return { resp, session: body };
  };
  let { resp, session } = await send();
  // Compte Stripe sur une version d'API antérieure au 30/09/2026 : le nouveau nom n'y existe pas encore.
  if (resp.status === 400 && /allowed_payment_method_types/.test(session.error?.message || '') && session.error?.param === 'allowed_payment_method_types') {
    params.delete('allowed_payment_method_types[0]');
    params.set('payment_method_types[0]', 'card');
    ({ resp, session } = await send());
  }
  if (!resp.ok || !session.id || !session.url) {
    console.error('Stripe Checkout error:', {
      status: resp.status,
      type: session.error?.type,
      code: session.error?.code,
      message: session.error?.message,
    });
    throw new Error(`Stripe a refusé la session (${resp.status}${session.error?.code ? `, ${session.error.code}` : ''})${session.error?.message ? ` : ${session.error.message}` : ''}`);
  }
  try {
    // Recheck after Stripe API call: the webhook might have marked it paid meanwhile.
    if (ids.some((id) => { const b = db.prepare('SELECT paid FROM bookings WHERE id = ?').get(id); return !b || b.paid; })) {
      await expireCheckout(session.id);
      throw new Error('Booking already paid during checkout creation');
    }
    db.prepare('INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES (?, ?, ?, ?, ?)').run(session.id, clientId, JSON.stringify(ids), amount, 'pending');
  } catch (err) {
    console.error('Stripe Checkout database error:', { code: err.code, message: err.message });
    throw err;
  }
  return { url: session.url };
}

async function expireCheckout(sessionId) {
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) { const body = await resp.json().catch(() => ({}));
    if (body.error?.code !== 'checkout_succeeded_session' && body.error?.code !== 'checkout_expired_session')
      throw new Error(`Stripe expire failed (${resp.status}): ${body.error?.code || 'unknown'}`);
  }
}
async function expireOtherSessions(db, ids, completedSessionId) {
  const rows = db.prepare("SELECT session_id, booking_ids FROM stripe_payments WHERE status = 'pending' AND session_id <> ?").all(completedSessionId);
  for (const row of rows) {
    if (!JSON.parse(row.booking_ids).some((id) => ids.includes(id))) continue;
    try {
      await expireCheckout(row.session_id);
      db.prepare("UPDATE stripe_payments SET status = 'expired' WHERE session_id = ? AND status = 'pending'").run(row.session_id);
    } catch (err) { console.error('Stripe stale session expiry failed:', row.session_id, err.message); }
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
// ---- PaymentIntent : lecture, encaissement, annulation (paiement en deux temps)
async function stripeCall(method, path, params, idem) {
  const headers = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
  if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idem) headers['Idempotency-Key'] = idem;
  let resp;
  try { resp = await fetch(`https://api.stripe.com${path}`, { method, headers, body: params || undefined, signal: AbortSignal.timeout(15000) }); }
  catch (err) { throw new Error(`Stripe network error (${path.split('/')[2]})`); }
  const body = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, body };
}
const validPi = (pi) => typeof pi === 'string' && /^pi_[A-Za-z0-9_]+$/.test(pi);
async function getIntent(pi) {
  if (!validPi(pi)) throw new Error('Invalid payment intent');
  const r = await stripeCall('GET', `/v1/payment_intents/${pi}`);
  if (!r.ok || !r.body.id) throw new Error(`Stripe payment intent lookup failed (${r.status})`);
  return r.body;
}
async function captureIntent(pi) {
  if (!validPi(pi)) throw new Error('Invalid payment intent');
  const r = await stripeCall('POST', `/v1/payment_intents/${pi}/capture`, new URLSearchParams(), `proprigo-capture-${pi}`);
  if (r.ok && r.body.status === 'succeeded') return r.body;
  const now = await getIntent(pi); // déjà encaissé lors d'un essai précédent ?
  if (now.status === 'succeeded') return now;
  throw new Error(`Stripe capture failed: ${r.body.error?.code || now.status}`);
}
async function cancelIntent(pi) {
  if (!validPi(pi)) throw new Error('Invalid payment intent');
  const r = await stripeCall('POST', `/v1/payment_intents/${pi}/cancel`, new URLSearchParams({ cancellation_reason: 'duplicate' }), `proprigo-cancel-${pi}`);
  if (r.ok && r.body.status === 'canceled') return 'canceled';
  const now = await getIntent(pi);
  if (now.status === 'canceled') return 'canceled';
  if (now.status === 'succeeded') return 'captured'; // déjà encaissé : il faudra rembourser
  throw new Error(`Stripe cancel failed: ${r.body.error?.code || now.status}`);
}
async function sessionForIntent(pi) {
  if (!validPi(pi)) return null;
  const r = await stripeCall('GET', `/v1/checkout/sessions?payment_intent=${pi}&limit=1`);
  return r.ok && Array.isArray(r.body.data) && r.body.data[0] ? r.body.data[0].id : null;
}
/**
 * Remboursement automatique d'un encaissement en trop (deuxième onglet, deuxième session…).
 * Une ligne par PaymentIntent : jamais deux remboursements pour le même encaissement,
 * et la clé d'idempotence Stripe protège aussi contre les webhooks rejoués.
 */
async function refundDuplicate({ db, paymentIntent, amountCents, sessionId, bookingIds, clientId }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (typeof paymentIntent !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntent)) throw new Error('Invalid payment intent');
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error('Invalid amount');
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_duplicate_refunds (payment_intent TEXT PRIMARY KEY, session_id TEXT, client_id INTEGER, booking_ids TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, refund_id TEXT, status TEXT NOT NULL DEFAULT 'a_rembourser', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const inserted = db.prepare('INSERT OR IGNORE INTO stripe_duplicate_refunds (payment_intent, session_id, client_id, booking_ids, amount_cents) VALUES (?, ?, ?, ?, ?)')
    .run(paymentIntent, sessionId || null, clientId || null, JSON.stringify(bookingIds), amountCents);
  const row = db.prepare('SELECT * FROM stripe_duplicate_refunds WHERE payment_intent = ?').get(paymentIntent);
  if (!inserted.changes && (row.refund_id || row.status === 'annule')) return { id: row.refund_id, status: row.status, already: true };
  const params = new URLSearchParams({ payment_intent: paymentIntent, amount: String(amountCents), reason: 'duplicate',
    'metadata[booking_ids]': JSON.stringify(bookingIds), 'metadata[proprigo]': 'duplicate_payment' });
  let resp;
  try {
    resp = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `proprigo-duplicate-${paymentIntent}` },
      body: params, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    db.prepare("UPDATE stripe_duplicate_refunds SET status = 'echec' WHERE payment_intent = ?").run(paymentIntent);
    throw new Error('Stripe refund network error');
  }
  const out = await resp.json().catch(() => ({}));
  // Déjà remboursé en totalité (par exemple à la main dans Stripe) : rien à refaire.
  if (!resp.ok && out.error?.code === 'charge_already_refunded') {
    db.prepare("UPDATE stripe_duplicate_refunds SET status = 'rembourse' WHERE payment_intent = ?").run(paymentIntent);
    return { id: null, status: 'succeeded', already: true };
  }
  if (!resp.ok || !out.id || !['succeeded', 'pending'].includes(out.status)) {
    db.prepare("UPDATE stripe_duplicate_refunds SET status = 'echec' WHERE payment_intent = ?").run(paymentIntent);
    throw new Error(out.error?.message ? `Stripe : ${out.error.message}` : 'Stripe refund failed');
  }
  db.prepare('UPDATE stripe_duplicate_refunds SET refund_id = ?, status = ? WHERE payment_intent = ?')
    .run(out.id, out.status === 'succeeded' ? 'rembourse' : 'remboursement_en_cours', paymentIntent);
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
// pourboire : paiement simple, encaissé tout de suite, reversé à 100 % à l'intervenante
async function checkoutTip({ db, tip, label, email, appUrl }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (!validBaseUrl(appUrl)) throw new Error('Invalid public URL');
  const amount = tip.amount_cents;
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 5000) throw new Error('Invalid amount');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('customer_email', email);
  params.set('line_items[0][price_data][currency]', 'eur');
  params.set('line_items[0][price_data][unit_amount]', String(amount));
  params.set('line_items[0][price_data][product_data][name]', label);
  params.set('line_items[0][quantity]', '1');
  params.set('metadata[tip_id]', String(tip.id));
  params.set('success_url', `${appUrl.replace(/\/$/, '')}/?stripe=success&tip=${tip.id}#/mes-reservations`);
  params.set('cancel_url', `${appUrl.replace(/\/$/, '')}/?stripe=cancel#/mes-reservations`);
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 1800));
  let resp;
  try {
    resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `proprigo-tip-${tip.id}` },
      body: params, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Stripe tip checkout network error:', { name: err.name, message: err.message });
    throw new Error('Stripe network error');
  }
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok || !out.id || !out.url) { console.error('Stripe tip checkout error:', { status: resp.status, message: out.error?.message }); throw new Error('Stripe checkout failed'); }
  db.prepare('UPDATE tips SET session_id = ? WHERE id = ?').run(out.id, tip.id);
  return { url: out.url };
}

// ----- prélèvement SEPA (entreprises) : mandat signé sur la page Stripe, prélèvement en fin de mois -----
async function sepaSetup({ db, user, appUrl, back = '/#/mes-reservations' }) {
  if (!configured()) throw new Error('Stripe not configured');
  if (!validBaseUrl(appUrl)) throw new Error('Invalid public URL');
  let customer = db.prepare('SELECT stripe_customer FROM users WHERE id = ?').get(user.id).stripe_customer;
  if (!customer) {
    const c = await stripeCall('POST', '/v1/customers', new URLSearchParams({ email: user.email, name: user.name || user.email, 'metadata[proprigo_user]': String(user.id) }), `proprigo-customer-${user.id}`);
    if (!c.ok || !c.body.id) throw new Error(`Stripe customer failed: ${c.body.error?.message || c.status}`);
    customer = c.body.id;
    db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').run(customer, user.id);
  }
  const base = appUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('mode', 'setup');
  params.set('currency', 'eur');
  params.set('customer', customer);
  params.set('payment_method_types[0]', 'sepa_debit');
  params.set('metadata[sepa_user]', String(user.id));
  params.set('success_url', `${base}/?stripe=sepa${back.startsWith('/#') ? back.slice(1) : back}`);
  params.set('cancel_url', `${base}/?stripe=cancel${back.startsWith('/#') ? back.slice(1) : back}`);
  const r = await stripeCall('POST', '/v1/checkout/sessions', params);
  if (!r.ok || !r.body.url) throw new Error(`Stripe SEPA setup failed: ${r.body.error?.message || r.status}`);
  return { url: r.body.url };
}
async function sepaSetupResult(setupIntentId) {
  if (typeof setupIntentId !== 'string' || !/^seti_[A-Za-z0-9_]+$/.test(setupIntentId)) throw new Error('Invalid setup intent');
  const si = await stripeCall('GET', `/v1/setup_intents/${setupIntentId}`);
  if (!si.ok) throw new Error('Stripe setup intent unavailable');
  const pm = typeof si.body.payment_method === 'string' ? si.body.payment_method : si.body.payment_method?.id;
  let last4 = null;
  if (pm) { const m = await stripeCall('GET', `/v1/payment_methods/${pm}`); if (m.ok) last4 = m.body.sepa_debit?.last4 || null; }
  return { status: si.body.status, paymentMethod: pm || null, mandate: typeof si.body.mandate === 'string' ? si.body.mandate : si.body.mandate?.id || null, last4 };
}
async function sepaCharge({ billId, amountCents, customer, paymentMethod, mandate, description }) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 100) throw new Error('Invalid amount');
  const params = new URLSearchParams();
  params.set('amount', String(amountCents));
  params.set('currency', 'eur');
  params.set('customer', customer);
  params.set('payment_method', paymentMethod);
  params.set('payment_method_types[0]', 'sepa_debit');
  if (mandate) params.set('mandate', mandate);
  params.set('confirm', 'true');
  params.set('off_session', 'true');
  params.set('description', description);
  params.set('metadata[bill_id]', String(billId));
  const r = await stripeCall('POST', '/v1/payment_intents', params, `proprigo-bill-${billId}-${Date.now() >> 20}`);
  if (!r.ok || !r.body.id) throw new Error(`Stripe SEPA charge failed: ${r.body.error?.message || r.status}`);
  return { id: r.body.id, status: r.body.status };
}
module.exports = { configured, validBaseUrl, verifyEvent, checkout, expireOtherSessions, refund, refundDuplicate, getIntent, captureIntent, cancelIntent, sessionForIntent, checkoutGift, checkoutTip, sepaSetup, sepaSetupResult, sepaCharge };
