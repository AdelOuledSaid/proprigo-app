'use strict';
// v1.5.0 : documents des intervenantes, refus de candidature, paiements, contestations, statistiques, tarifs et zones.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const db_ = require('../src/db');
const mailer = require('../src/mailer');
const pricing = require('../src/pricing');

const NOW = new Date('2026-11-21T09:00:00Z');
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = async (email, password) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(r.status, 200, `connexion ${email}`);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    };
  };
  return { ...app, base, session, close: () => app.server.close() };
}
const subjectsSince = (n) => mailer.outbox(500).slice(0, mailer.outbox(500).length - n).map((m) => m.subject);

test('documents : dépôt, vérification, refus avec raison, activation bloquée sans pièces, refus de candidature', async () => {
  const a = await start({ production: true, appUrl: 'https://proprigo.example' });
  try {
    const mk = (email, statut) => {
      const id = db_.createUser(a.db, { role: 'intervenante', email, password: 'motdepasse-cand', name: `Cand ${statut}` });
      a.db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(id);
      a.db.prepare('INSERT INTO workers (user_id, statut, cp, rate) VALUES (?, ?, ?, ?)').run(id, statut, '75011', statut === 'I' ? 25 : null);
      return id;
    };
    const wid = mk('cand-i@test.fr', 'I');
    const cand = await a.session('cand-i@test.fr', 'motdepasse-cand');
    const list = await cand('GET', '/api/worker/documents');
    assert.deepEqual(list.data.list.filter((k) => k.required).map((k) => k.kind).sort(), ['assurance', 'identite', 'rib', 'siret', 'urssaf']);
    assert.equal(list.data.complete, false);
    assert.equal((await cand('POST', '/api/worker/documents', { kind: 'identite', data: 'data:application/pdf;base64,' + Buffer.from('pas un pdf').toString('base64') })).status, 400, 'contenu vérifié, pas seulement le type annoncé');
    assert.equal((await cand('POST', '/api/worker/documents', { kind: 'secu', data: PDF })).status, 400, 'pièce de salariée refusée pour une indépendante');
    for (const k of ['identite', 'rib', 'siret', 'urssaf', 'assurance']) assert.equal((await cand('POST', '/api/worker/documents', { kind: k, data: k === 'identite' ? PNG : PDF })).status, 200);

    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    // la candidate est à l'avant-dernière étape : activation refusée tant que les pièces ne sont pas validées
    a.db.prepare('UPDATE workers SET step = ? WHERE user_id = ?').run(db_.STEPS.I.length - 2, wid);
    const blocked = await admin('POST', `/api/admin/workers/${wid}/advance`, {});
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /pièces non validées/);

    const file = await admin('GET', `/api/admin/workers/${wid}/file`);
    const docs = file.data.documents.list;
    const idDoc = docs.find((k) => k.kind === 'identite').latest;
    const view = await fetch(a.base + `/api/documents/${idDoc.id}`, { headers: { Cookie: '' } });
    assert.equal(view.status, 404, 'un visiteur ne voit pas le document');
    const seen = await admin('GET', `/api/documents/${idDoc.id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get('content-type'), 'image/png');
    assert.match(seen.headers.get('content-security-policy'), /sandbox/);

    const before = mailer.outbox(500).length;
    assert.equal((await admin('POST', `/api/admin/documents/${docs.find((k) => k.kind === 'urssaf').latest.id}/review`, { decision: 'refuse' })).status, 400, 'raison obligatoire');
    const ko = await admin('POST', `/api/admin/documents/${docs.find((k) => k.kind === 'urssaf').latest.id}/review`, { decision: 'refuse', note: 'Attestation de plus de 6 mois' });
    assert.equal(ko.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(subjectsSince(before).includes('Un document est à renvoyer'));
    for (const k of docs.filter((x) => x.kind !== 'urssaf' && x.latest)) await admin('POST', `/api/admin/documents/${k.latest.id}/review`, { decision: 'valide' });
    assert.equal((await admin('POST', `/api/admin/workers/${wid}/advance`, {})).status, 409, 'URSSAF refusée : toujours bloquée');
    // nouveau dépôt de la pièce refusée, puis validation
    const again = await cand('POST', '/api/worker/documents', { kind: 'urssaf', data: PDF });
    assert.equal(again.status, 200);
    const newId = again.data.list.find((k) => k.kind === 'urssaf').latest.id;
    assert.equal((await admin('POST', `/api/admin/documents/${newId}/review`, { decision: 'valide' })).status, 200);
    assert.equal((await admin('POST', `/api/admin/workers/${wid}/advance`, {})).status, 200, 'pièces complètes : activation possible');

    // la candidate ne voit pas les documents d'une autre
    const wid2 = mk('cand-s@test.fr', 'S');
    const cand2 = await a.session('cand-s@test.fr', 'motdepasse-cand');
    assert.equal((await cand2('GET', `/api/documents/${newId}`)).status, 404);
    // refus de candidature : raison interne, message neutre, plus de dépôt possible
    assert.equal((await admin('POST', `/api/admin/workers/${wid}/reject`, { reason: 'test' })).status, 409, 'une intervenante active ne se refuse pas');
    const b2 = mailer.outbox(500).length;
    assert.equal((await admin('POST', `/api/admin/workers/${wid2}/reject`, { reason: 'Entretien non concluant' })).status, 200);
    await new Promise((r) => setTimeout(r, 30));
    const mail = mailer.outbox(500).slice(0, mailer.outbox(500).length - b2).find((m) => m.subject === 'Votre candidature Proprigo');
    assert.ok(mail);
    assert.doesNotMatch(mailer.readOutbox(mail.file), /Entretien non concluant/, 'la raison interne n\'est pas envoyée');
    assert.equal((await cand2('POST', '/api/worker/documents', { kind: 'identite', data: PDF })).status, 409);
    const mine = await cand2('GET', '/api/worker/missions');
    assert.equal(mine.data.profile.reject_reason, undefined, 'la raison interne n\'est pas visible par la candidate');
  } finally { a.close(); }
});

test('contestation Stripe : alerte, incident, dossier de preuve, clôture ; écran des paiements et export', async () => {
  const env = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  const realFetch = global.fetch;
  global.fetch = async (url, init) => (String(url).startsWith('https://api.stripe.com/') ? new Response('{}', { status: 200 }) : realFetch(url, init));
  const a = await start({ paymentsEnabled: true, appUrl: 'https://proprigo.example' });
  const send = (type, object) => {
    const raw = JSON.stringify({ type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${t}.${raw}`).digest('hex');
    return realFetch(a.base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
  };
  try {
    const client = a.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const bid = Number(a.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
      VALUES (?, 'menage', 3, '75011', '12 rue Test', '2026-11-20', '10:00', 0, 0, 111, 'IDF', 0, 'en_attente_paiement', 'en_attente', '[{"task":"Cuisine","done":true}]')`).run(client).lastInsertRowid);
    a.db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status) VALUES ('cs_test_d', ?, ?, 11100, 'pending')").run(client, JSON.stringify([bid]));
    await send('checkout.session.completed', { id: 'cs_test_d', payment_status: 'paid', currency: 'eur', amount_total: 11100, payment_intent: 'pi_disp' });
    a.db.prepare("UPDATE bookings SET status = 'terminee' WHERE id = ?").run(bid);

    const before = mailer.outbox(500).length;
    const due = Math.floor(Date.parse('2026-12-05T23:00:00Z') / 1000);
    const dp = { id: 'dp_test123', amount: 11100, currency: 'eur', reason: 'product_not_received', status: 'needs_response', payment_intent: 'pi_disp', charge: 'ch_1', evidence_details: { due_by: due } };
    assert.equal((await send('charge.dispute.created', dp)).status, 200);
    await send('charge.dispute.created', dp); // rejoué
    await new Promise((r) => setTimeout(r, 40));
    const subjects = subjectsSince(before);
    assert.equal(subjects.filter((x) => x.startsWith('Contestation bancaire : 111,00 €')).length, 1, 'une seule alerte');
    assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE booking_id = ? AND source = 'litige'").get(bid).n, 1);

    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const month = '2026-11';
    const pay = await admin('GET', `/api/admin/payments?month=${month}`);
    assert.equal(pay.status, 200);
    assert.equal(pay.data.disputes.length, 1);
    assert.equal(pay.data.disputes[0].open, true);
    assert.deepEqual(pay.data.disputes[0].bookings, [bid]);
    assert.match(pay.data.disputes[0].stripeUrl, /dashboard\.stripe\.com\/test\/disputes\/dp_test123/);
    const ev = await admin('GET', `/api/admin/disputes/${pay.data.disputes[0].id}/evidence`);
    assert.equal(ev.status, 200);
    assert.match(ev.data, /Dossier de preuve/);
    assert.match(ev.data, /F2026-000001/);
    assert.match(ev.data, /1\/1 cochées/);

    // paiement listé avec sa facture ; un remboursement partiel apparaît avec son avoir
    const real = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    a.db.prepare("UPDATE bookings SET payment_status = 'a_rembourser', refund_amount = 20 WHERE id = ?").run(bid);
    await admin('POST', `/api/admin/bookings/${bid}/refunded`, {});
    const list = await admin('GET', `/api/admin/payments?month=${real}`);
    const types = list.data.rows.map((r) => `${r.type}:${r.ref || ''}:${r.amount_cents}`);
    assert.ok(types.includes('Paiement:F2026-000001:11100'), types.join(' | '));
    assert.ok(types.includes('Remboursement:A2026-000001:-2000'), types.join(' | '));
    assert.equal(list.data.totals.net, 9100);
    const csv = await admin('GET', `/api/admin/payments.csv?month=${real}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.data, /Date;Type;Pièce;Client/);
    assert.match(csv.data, /F2026-000001/);
    const planner = a.db.prepare("INSERT INTO users (role, email, pass_hash, name, staff_level) VALUES ('admin', 'p@test.fr', ?, 'P', 'planning')").run(db_.hashPassword('motdepasse-plan'));
    assert.ok(planner);
    const plan = await a.session('p@test.fr', 'motdepasse-plan');
    assert.equal((await plan('GET', `/api/admin/payments?month=${real}`)).status, 403, 'le planificateur ne voit pas l\'argent');

    const b2 = mailer.outbox(500).length;
    await send('charge.dispute.closed', { ...dp, status: 'won' });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(subjectsSince(b2).includes('Contestation gagnée : 111,00 €'));
    assert.equal((await admin('GET', `/api/admin/payments?month=${month}`)).data.disputes[0].open, false);
  } finally {
    a.close(); global.fetch = realFetch;
    if (env.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = env.k;
    if (env.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = env.w;
  }
});

test('statistiques : chiffre d\'affaires par mois, annulations et taux', async () => {
  const a = await start();
  try {
    const client = a.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    a.db.exec("DELETE FROM bookings");
    const mk = (date, status, total = 111, extra = {}) => a.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
      VALUES (?, 'menage', 3, '75011', '1 rue', ?, '10:00', 0, 0, ?, 'IDF', ?, ?, ?, '[]')`).run(client, date, total, extra.paid ?? 0, extra.ps ?? 'simule', status);
    mk('2026-10-05', 'terminee'); mk('2026-10-12', 'terminee'); mk('2026-10-19', 'annulee'); mk('2026-10-26', 'annulee', 111, { ps: 'paiement_echoue' });
    mk('2026-11-02', 'terminee', 74);
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const st = await admin('GET', '/api/admin/stats?months=12');
    assert.equal(st.status, 200);
    assert.equal(st.data.theoretical, true);
    assert.equal(st.data.rows.length, 12);
    const oct = st.data.rows.find((r) => r.month === '2026-10');
    assert.equal(oct.prestations, 2);
    assert.equal(oct.caTTC, 22200);
    assert.equal(oct.reservations, 3, 'paiement abandonné exclu');
    assert.equal(oct.annulees, 1);
    assert.equal(oct.tauxAnnulation, 33.3);
    assert.equal(oct.panierMoyen, 11100);
    assert.equal(st.data.rows.find((r) => r.month === '2026-11').caTTC, 7400);
    assert.equal(st.data.total.netTTC, 29600);
  } finally { a.close(); }
});

test('tarifs et zones : vérifiés, appliqués aux nouvelles réservations seulement, gardés après redémarrage', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proprigo-prix-'));
  const dbFile = path.join(dir, 'p.db');
  let a = await start({ dbFile });
  try {
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const cur = (await admin('GET', '/api/admin/pricing')).data.current;
    assert.deepEqual(cur, JSON.parse(JSON.stringify(pricing.DEFAULTS)));
    const claire = await a.session('claire@proprigo.test', 'demo-proprigo');
    const old = await claire('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75012', address: '10 rue de Charenton', date: '2026-11-25', time: '10:00' });
    assert.equal(old.data.total, 111);

    const loss = JSON.parse(JSON.stringify(cur)); loss.grid.IDF.menage = 20;
    const refused = await admin('POST', '/api/admin/pricing', loss);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /ne couvre pas le coût/);
    const badDept = JSON.parse(JSON.stringify(cur)); badDept.openDepts = ['75', 'XX'];
    assert.equal((await admin('POST', '/api/admin/pricing', badDept)).status, 400);

    const next = JSON.parse(JSON.stringify(cur));
    next.grid.IDF.menage = 39; next.kit = 18; next.openDepts = [...cur.openDepts, '69'];
    const ok = await admin('POST', '/api/admin/pricing', next);
    assert.equal(ok.status, 200);
    assert.match(ok.data.message, /3 changement/);
    const q = await claire('POST', '/api/quote', { service: 'menage', hours: 3, cp: '75012', date: '2026-11-26', kit: true });
    assert.equal(q.data.total, 135, '3 × 39 + 18');
    const lyon = await claire('POST', '/api/quote', { service: 'menage', hours: 3, cp: '69003', date: '2026-11-26' });
    assert.equal(lyon.data.open, true, 'Lyon ouvert, au prix hors IDF');
    assert.equal(lyon.data.total, 102);
    assert.equal(a.db.prepare('SELECT total FROM bookings WHERE id = ?').get(old.data.id).total, 111, 'la réservation existante garde son prix');
    const cfg = await (await fetch(a.base + '/api/config')).json();
    assert.equal(cfg.prices.menage, 39);
    const seoPage = await (await fetch(a.base + '/menage-a-domicile/paris-11')).text();
    assert.match(seoPage, /39 € de l(&#39;|')heure/);
    assert.match(seoPage, /Matériel apporté : \+18 €/);
    const hist = (await admin('GET', '/api/admin/pricing')).data.history;
    assert.match(hist[0].changes.join(' '), /37 → 39/);
  } finally { a.close(); a.db.close(); }
  // après redémarrage, la grille enregistrée est reprise
  a = await start({ dbFile, seed: false });
  try {
    assert.equal(pricing.GRID.IDF.menage, 39);
    assert.ok(pricing.OPEN_DEPTS.includes('69'));
  } finally { a.close(); a.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  // une autre application démarre avec la grille d'origine
  const b = await start();
  try { assert.equal(pricing.GRID.IDF.menage, 37); assert.equal(pricing.RATES.kit, 15); } finally { b.close(); }
});

test('pièces demandées : liste modifiable par le responsable, appliquée aux candidates', async () => {
  const a = await start();
  try {
    const id = db_.createUser(a.db, { role: 'intervenante', email: 'cand@test.fr', password: 'motdepasse-cand', name: 'Cand' });
    a.db.prepare("INSERT INTO workers (user_id, statut, cp) VALUES (?, 'S', '75011')").run(id);
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const cand = await a.session('cand@test.fr', 'motdepasse-cand');
    const cur = (await admin('GET', '/api/admin/worker-docs')).data;
    assert.ok(cur.list.length >= 5);
    // sans pièce obligatoire pour les indépendantes : refusé
    assert.equal((await admin('POST', '/api/admin/worker-docs', { list: [{ label: 'Pièce d\'identité', for: ['S'], required: true }] })).status, 400);
    const next = [
      { kind: 'identite', label: 'Pièce d\'identité ou titre de séjour', for: ['S', 'I'], required: true },
      { label: 'Justificatif de domicile de moins de 3 mois', for: ['S'], required: true },
      { label: 'Permis de conduire', for: ['S', 'I'], required: false },
    ];
    const r = await admin('POST', '/api/admin/worker-docs', { list: next });
    assert.equal(r.status, 200);
    const mine = (await cand('GET', '/api/worker/documents')).data;
    assert.deepEqual(mine.list.map((k) => k.label), ['Pièce d\'identité ou titre de séjour', 'Justificatif de domicile de moins de 3 mois', 'Permis de conduire']);
    const dom = mine.list[1].kind;
    assert.equal((await cand('POST', '/api/worker/documents', { kind: dom, data: PDF })).status, 200);
    assert.equal((await cand('POST', '/api/worker/documents', { kind: 'secu', data: PDF })).status, 400, 'pièce retirée de la liste : plus demandée');
    assert.deepEqual((await cand('GET', '/api/worker/documents')).data.missing.sort(), ['Justificatif de domicile de moins de 3 mois', 'Pièce d\'identité ou titre de séjour'].sort());
    assert.equal((await cand('POST', '/api/admin/worker-docs', { list: next })).status, 403);
  } finally { a.close(); }
});
