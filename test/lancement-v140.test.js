'use strict';
// v1.4.0 : e-mails fiables, confirmation après paiement, e-mail à l'équipe, factures numérotées,
// avoirs, réservations en double, adresse e-mail confirmée.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const mailer = require('../src/mailer');

const NOW = new Date('2026-11-21T09:00:00Z');

async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = async (email, password) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  return { ...app, base, session, close: () => app.server.close() };
}
const outboxSubjects = () => mailer.outbox(200).map((m) => m.subject);

test('e-mails : nouveaux essais, même clé chez Resend, file d\'attente, jamais deux fois', async () => {
  const realFetch = global.fetch;
  const calls = [];
  let plan = [];
  global.fetch = async (url, init) => {
    if (String(url) !== 'https://api.resend.com/emails') return realFetch(url, init);
    calls.push(init.headers['Idempotency-Key']);
    const status = plan.length ? plan.shift() : 200;
    return new Response('{}', { status });
  };
  const a = await start({ mail: { provider: 'resend', apiKey: 're_test', retryDelaysMs: [0, 0] } });
  try {
    plan = [503, 503];
    assert.equal(await mailer.send('a@test.fr', 'Sujet', 'Titre', ['ligne']), 'envoye');
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls).size, 1, 'les trois essais portent la même clé : Resend n\'enverra qu\'une fois');

    calls.length = 0; plan = [422];
    assert.equal(await mailer.send('mauvaise@adresse', 'Sujet', 'Titre', ['ligne']), 'echec', 'erreur définitive : pas de nouvel essai');
    assert.equal(calls.length, 1);

    calls.length = 0; plan = [500, 500, 500];
    assert.equal(await mailer.send('b@test.fr', 'Plus tard', 'Titre', ['ligne']), 'en_attente');
    assert.deepEqual(mailer.queueState(), { attente: 1, abandon: 0 });
    assert.deepEqual(await mailer.processQueue(Date.now()), { sent: 0, failed: 0 }, 'pas avant l\'heure prévue');
    plan = [200];
    assert.deepEqual(await mailer.processQueue(Date.now() + 6 * 60e3), { sent: 1, failed: 0 });
    assert.deepEqual(mailer.queueState(), { attente: 0, abandon: 0 });

    calls.length = 0;
    assert.equal(await mailer.send('c@test.fr', 'Une fois', 'Titre', ['x'], null, { key: 'unique-1' }), 'envoye');
    assert.equal(await mailer.send('c@test.fr', 'Une fois', 'Titre', ['x'], null, { key: 'unique-1' }), 'deja');
    assert.equal(calls.length, 1);
  } finally { a.close(); global.fetch = realFetch; }
});

test('paiement Stripe confirmé : facture numérotée, e-mail client et e-mail équipe, une seule fois', async () => {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  global.fetch = async (url, init) => (String(url).startsWith('https://api.stripe.com/') ? new Response('{}', { status: 200 }) : realFetch(url, init));
  const a = await start({ paymentsEnabled: true, appUrl: 'https://proprigo.example' });
  try {
    const client = a.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const mk = (date) => Number(a.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
      VALUES (?, 'menage', 3, '75011', '12 rue Test', ?, '10:00', 0, 0, 111, 'IDF', 0, 'en_attente_paiement', 'en_attente', '[]')`).run(client, date).lastInsertRowid);
    const pay = async (id, session) => {
      a.db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES (?, ?, ?, 11100, 'pending')").run(session, client, JSON.stringify([id]));
      const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: session, payment_status: 'paid', currency: 'eur', amount_total: 11100, payment_intent: `pi_${session}` } } });
      const t = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${raw}`).digest('hex');
      return realFetch(a.base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
    };
    const before = outboxSubjects().length;
    const b1 = mk('2026-11-28');
    assert.equal((await pay(b1, 'cs_test_1')).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    let subjects = outboxSubjects().slice(0, outboxSubjects().length - before);
    assert.equal(subjects.filter((x) => x === 'Réservation confirmée : 28/11/2026 à 10:00' || /^Réservation confirmée/.test(x)).length, 1, 'e-mail de confirmation au client');
    assert.equal(subjects.filter((x) => x.startsWith(`Nouvelle réservation n° ${b1}`)).length, 1, 'e-mail à l\'équipe');
    const inv1 = a.db.prepare("SELECT number FROM invoices WHERE kind = 'facture' AND booking_id = ?").get(b1);
    assert.equal(inv1.number, 'F2026-000001');

    // Stripe renvoie le même événement : rien de plus
    await pay(b1, 'cs_test_1b').catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    subjects = outboxSubjects().slice(0, outboxSubjects().length - before);
    assert.equal(subjects.filter((x) => /^Réservation confirmée/.test(x)).length, 1);
    assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'facture'").get().n, 1);

    const b2 = mk('2026-11-29');
    await pay(b2, 'cs_test_2');
    assert.equal(a.db.prepare("SELECT number FROM invoices WHERE kind = 'facture' AND booking_id = ?").get(b2).number, 'F2026-000002', 'numéros qui se suivent');

    // remboursement partiel → avoir lié à la facture
    a.db.prepare("UPDATE bookings SET status = 'annulee', payment_status = 'a_rembourser', refund_amount = 55.5 WHERE id = ?").run(b1);
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    assert.equal((await admin('POST', `/api/admin/bookings/${b1}/refunded`, {})).status, 200);
    const avoir = a.db.prepare("SELECT * FROM invoices WHERE kind = 'avoir' AND booking_id = ?").get(b1);
    assert.equal(avoir.number, 'A2026-000001');
    assert.equal(avoir.amount_cents, 5550);
    assert.equal(avoir.ref_invoice, 'F2026-000001');

    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const fact = await claire('GET', `/api/bookings/${b1}/receipt`);
    assert.equal(fact.status, 200);
    assert.match(fact.data, /Facture F2026-000001/);
    assert.match(fact.data, /Facture acquittée/);
    assert.match(fact.data, /A2026-000001/);
    const av = await claire('GET', `/api/bookings/${b1}/receipt?doc=A2026-000001`);
    assert.match(av.data, /Avoir A2026-000001/);
    assert.match(av.data, /Avoir sur la facture F2026-000001/);
    assert.match(av.data, /55,50/);
    // un autre client ne voit pas cette facture
    a.db.prepare("INSERT INTO users (role, email, pass_hash, name) VALUES ('client', 'autre@test.fr', ?, 'Autre')").run(require('../src/db').hashPassword('motdepasse-autre'));
    const autre = await a.session('autre@test.fr', 'motdepasse-autre');
    assert.equal((await autre('GET', `/api/bookings/${b1}/receipt`)).status, 404);
  } finally {
    a.close(); global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});

test('double clic : la même réservation n\'est créée qu\'une fois, récurrente comprise', async () => {
  const a = await start();
  try {
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const body = { service: 'menage', hours: 3, cp: '75012', address: '10 rue de Charenton', date: '2026-11-25', time: '10:00' };
    const [r1, r2] = await Promise.all([claire('POST', '/api/bookings', body), claire('POST', '/api/bookings', body)]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    assert.match((r1.status === 409 ? r1 : r2).data.error, /existe déjà/);
    assert.equal((await claire('POST', '/api/bookings', { ...body, time: '14:00' })).status, 201, 'un autre créneau reste possible');
    const rec = { ...body, date: '2026-11-26', repeat: '7' };
    const first = await claire('POST', '/api/bookings', rec);
    assert.equal(first.status, 201);
    assert.ok(first.data.created > 1, 'série créée');
    const again = await claire('POST', '/api/bookings', rec);
    assert.equal(again.status, 409);
    assert.equal(a.db.prepare('SELECT COUNT(DISTINCT series_id) AS n FROM bookings WHERE series_id IS NOT NULL AND client_id = (SELECT id FROM users WHERE email = ?)').get('claire@proprigo.test').n, 1, 'une seule série');
  } finally { a.close(); }
});

test('adresse e-mail : lien de confirmation, exigé pour réserver en production', async () => {
  const a = await start({ production: true, appUrl: 'https://proprigo.example' });
  try {
    const before = mailer.outbox(500).length;
    const r = await fetch(a.base + '/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nina Test', email: 'nina@test.fr', password: 'motdepasse-solide' }) });
    assert.equal(r.status, 201);
    const nina = await a.session('nina@test.fr', 'motdepasse-solide');
    const me = await nina('GET', '/api/me');
    assert.equal(me.data.user.email_verified, 0);
    const blocked = await nina('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75012', address: '10 rue de Charenton', date: '2026-11-25', time: '10:00' });
    assert.equal(blocked.status, 403);
    assert.match(blocked.data.error, /Confirmez d'abord votre adresse/);

    const mails = mailer.outbox(500).slice(0, mailer.outbox(500).length - before);
    const welcome = mails.find((m) => m.subject === 'Bienvenue chez Proprigo');
    const html = mailer.readOutbox(welcome.file);
    const token = (html.match(/confirmer-email\?t=([0-9a-f]{64})/) || [])[1];
    assert.ok(token, 'le lien est dans l\'e-mail de bienvenue');
    assert.equal((await nina('POST', '/api/email/verify', { token: 'f'.repeat(64) })).status, 400);
    const ok = await nina('POST', '/api/email/verify', { token });
    assert.equal(ok.status, 200);
    assert.equal((await nina('POST', '/api/email/verify', { token })).status, 400, 'un lien ne sert qu\'une fois');
    assert.equal((await nina('GET', '/api/me')).data.user.email_verified, 1);
    const after = await nina('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75012', address: '10 rue de Charenton', date: '2026-11-25', time: '10:00' });
    assert.notEqual(after.status, 403, 'le blocage est levé');

    // renvoi du lien : limité à 3 par heure
    a.db.prepare('UPDATE users SET email_verified_at = NULL WHERE email = ?').run('nina@test.fr');
    for (let i = 0; i < 3; i++) assert.equal((await nina('POST', '/api/email/resend', {})).status, 200);
    assert.equal((await nina('POST', '/api/email/resend', {})).status, 429);
  } finally { a.close(); }
});

test('factures : informations de l\'entreprise signalées si manquantes', async () => {
  const a = await start();
  try {
    const h = await (await fetch(a.base + '/api/health')).json();
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'entreprise.json'), 'utf8'));
    if (!cfg.siret) assert.match(h.factures, /à compléter/);
    else assert.equal(h.factures, 'ok');
  } finally { a.close(); }
});

test('surveillance : panne gardée en base, une alerte e-mail par heure au plus', async () => {
  const a = await start();
  try {
    const before = mailer.outbox(500).length;
    a.reportError('GET /api/test', new Error('panne 1'));
    a.reportError('GET /api/test', new Error('panne 2'));
    await new Promise((r) => setTimeout(r, 30));
    const alerts = mailer.outbox(500).slice(0, mailer.outbox(500).length - before).filter((m) => m.subject.startsWith('Alerte Proprigo'));
    assert.equal(alerts.length, 1, 'une seule alerte pour deux pannes dans l\'heure');
    const h = await (await fetch(a.base + '/api/health')).json();
    assert.equal(h.erreurs24h, 2);
  } finally { a.close(); }
});

test('vitesse : fichiers compressés, revisite sans retéléchargement, polices sur le site', async () => {
  const a = await start();
  try {
    const r = await fetch(a.base + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(a.base + '/app.js', { headers: { 'If-None-Match': r.headers.get('etag') } })).status, 304);
    const font = await fetch(a.base + '/fonts/inter-regular.woff');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff');
    assert.match(font.headers.get('cache-control'), /max-age=31536000/);
    const html = await (await fetch(a.base + '/')).text();
    assert.doesNotMatch(html, /googleapis|gstatic/, 'aucune police chargée chez Google');
    assert.doesNotMatch((await fetch(a.base + '/')).headers.get('content-security-policy'), /google/);
  } finally { a.close(); }
});

test('e-mails : version texte et adresse de réponse envoyées à Resend', async () => {
  const realFetch = global.fetch;
  let sent;
  global.fetch = async (url, init) => { if (String(url) === 'https://api.resend.com/emails') { sent = JSON.parse(init.body); return new Response('{}', { status: 200 }); } return realFetch(url, init); };
  const a = await start({ mail: { provider: 'resend', apiKey: 're_test', from: 'Proprigo <contact@proprigo.fr>', replyTo: 'Proprigo <contact@proprigo.fr>', retryDelaysMs: [0, 0] } });
  try {
    assert.equal(await mailer.send('a@test.fr', 'Bienvenue', 'Bienvenue Léa', ['Votre compte est créé.'], { label: 'Confirmer mon adresse', path: '/#/confirmer-email?t=abc' }), 'envoye');
    assert.equal(sent.from, 'Proprigo <contact@proprigo.fr>');
    assert.equal(sent.reply_to, 'contact@proprigo.fr');
    assert.match(sent.text, /Bienvenue Léa/);
    assert.match(sent.text, /Confirmer mon adresse : http/);
    assert.doesNotMatch(sent.text, /<[a-z]/i, 'aucune balise dans la version texte');
    const h = await (await fetch(a.base + '/api/health')).json();
    assert.equal(h.emails, 'resend (contact@proprigo.fr, réponses à contact@proprigo.fr)');
  } finally { a.close(); global.fetch = realFetch; }
});

test('ADMIN_EMAIL : le compte responsable prend la vraie adresse et reçoit les alertes', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-admin-'));
  const dbFile = path.join(dir, 'p.db');
  let a = await start({ dbFile });
  a.close(); a.db.close();
  a = await start({ dbFile, seed: false, adminEmail: 'Contact@Proprigo.fr' });
  try {
    assert.ok(a.db.prepare("SELECT 1 FROM users WHERE email = 'contact@proprigo.fr' AND role = 'admin'").get());
    assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@proprigo.test'").get().n, 0);
    const admin = await a.session('contact@proprigo.fr', 'admin-test-123');
    assert.equal((await admin('GET', '/api/me')).data.user.role, 'admin');
  } finally { a.close(); a.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  // base de production vide : le responsable est créé avec cette adresse
  const b = await start({ seed: false, adminEmail: 'contact@proprigo.fr' });
  try {
    assert.ok(b.db.prepare("SELECT 1 FROM users WHERE email = 'contact@proprigo.fr' AND role = 'admin' AND email_verified_at IS NOT NULL").get());
  } finally { b.close(); }
});

test('paiement refusé par Stripe : la vraie raison est notée au journal ; clé anti-doublon et expiration sûres', async () => {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  const sent = [];
  let refuse = true;
  global.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions' && init.method === 'POST') {
      sent.push({ key: init.headers['Idempotency-Key'], body: new URLSearchParams(init.body.toString()) });
      if (refuse) return new Response(JSON.stringify({ error: { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'Keys for idempotent requests can only be used with the same parameters' } }), { status: 400 });
      return new Response(JSON.stringify({ id: `cs_test_${sent.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${sent.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const a = await start({ paymentsEnabled: true, appUrl: 'https://proprigo.example' });
  try {
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const body = { service: 'menage', hours: 3, cp: '75012', address: '10 rue de Charenton', date: '2026-11-25', time: '10:00' };
    const r = await claire('POST', '/api/bookings', body);
    assert.equal(r.status, 502);
    const log = a.db.prepare("SELECT text FROM events WHERE text LIKE 'PAIEMENT IMPOSSIBLE%'").all().map((x) => x.text).join(' ');
    assert.match(log, /idempotency_key_in_use/);
    assert.match(log, /same parameters/);
    const exp = Number(sent[0].body.get('expires_at'));
    assert.ok(exp - Math.floor(Date.now() / 1000) >= 34 * 60, 'au moins 30 minutes, avec une marge');
    refuse = false;
    const ok = await claire('POST', '/api/bookings', { ...body, time: '14:00' });
    assert.equal(ok.status, 201);
    assert.ok(ok.data.checkout_url);
    assert.notEqual(sent[0].key, sent[1].key, 'une autre demande ne réutilise jamais la même clé');
  } finally {
    a.close(); global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});

test('page d\'accueil : code appelé avec le numéro de version, jamais gardé en mémoire', async () => {
  const a = await start();
  try {
    const { version } = require('../package.json');
    const r = await fetch(a.base + '/');
    const html = await r.text();
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(html, new RegExp(`src="/app\\.js\\?v=${version.replace(/\./g, '\\.')}"`));
    assert.match(html, new RegExp(`href="/styles\\.css\\?v=${version.replace(/\./g, '\\.')}"`));
    assert.match(html, new RegExp(`<meta name="proprigo-version" content="${version.replace(/\./g, '\\.')}">`));
    assert.equal((await fetch(a.base + `/app.js?v=${version}`)).status, 200);
  } finally { a.close(); }
});
