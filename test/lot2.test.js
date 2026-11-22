'use strict';
// Lot 2 : gains, problème sur place, avis, parrainage, attestation, fiches, chiffres, compte planning.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const NOW = new Date('2026-11-21T09:00:00Z'); // samedi 21 novembre, 10 h à Paris
const ADMIN = ['admin@proprigo.test', 'admin-test-123'];

async function startServer(opts = {}) {
  const { server, db } = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  const logged = async (email, password = 'demo-proprigo') => {
    const a = agent();
    assert.equal((await a('POST', '/api/login', { email, password })).status, 200);
    return a;
  };
  return { server, db, agent, logged };
}
const uid = (db, email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const addBooking = (db, f) => Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, worker_id, checklist)
  VALUES (?, 'menage', 3, '75011', '12 rue Test', ?, ?, 0, 0, ?, 'IDF', ?, ?, ?, ?, '[]')`).run(f.client, f.date, f.time || '10:00', f.total || 111, f.paid ? 1 : 0, f.pay || 'paye', f.status || 'attribuee', f.worker || null).lastInsertRowid);


test('parrainage : code, 10 € pour le filleul au premier ménage, 10 € pour le parrain une fois servi', async () => {
  const { server, db, agent, logged } = await startServer();
  try {
    const claire = await logged('claire@proprigo.test');
    const ref = (await claire('GET', '/api/referral')).data;
    assert.match(ref.code, /^[A-Z]{1,6}\d{3}$/);
    assert.equal((await claire('GET', '/api/referral')).data.code, ref.code, 'le code ne change pas');
    const anon = agent();
    assert.equal((await anon('POST', '/api/signup', { name: 'Paul Test', email: 'paul@test.fr', password: 'motdepasse-123', ref: 'FAUX999' })).status, 400);
    const paul = agent();
    assert.equal((await paul('POST', '/api/signup', { name: 'Paul Test', email: 'paul@test.fr', password: 'motdepasse-123', ref: ref.code })).status, 201);
    const q = (await paul('POST', '/api/quote', { service: 'menage', hours: 3, cp: '75011', date: '2026-11-25' })).data;
    assert.equal(q.discount, 10);
    assert.equal(q.total, 101);
    const r = await paul('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75011', address: '3 rue Test', date: '2026-11-25', time: '10:00', checklist: [] });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const pid = uid(db, 'paul@test.fr');
    const b = db.prepare('SELECT * FROM bookings WHERE client_id = ? ORDER BY id LIMIT 1').get(pid);
    assert.equal(b.total, 101);
    assert.equal(b.discount, 10);
    assert.equal((await paul('POST', '/api/quote', { service: 'menage', hours: 3, cp: '75011', date: '2026-11-26' })).data.discount, undefined, 'crédit déjà utilisé');
    // ménage terminé → le parrain reçoit 10 €, une seule fois
    const fatima = uid(db, 'fatima@proprigo.test');
    db.prepare("UPDATE bookings SET status = 'en_cours', worker_id = ?, paid = 1, payment_status = 'paye', date = '2026-11-21' WHERE id = ?").run(fatima, b.id);
    const w = await logged('fatima@proprigo.test');
    assert.equal((await w('POST', `/api/worker/missions/${b.id}/finish`)).status, 200);
    assert.equal((await claire('GET', '/api/referral')).data.credit, 10);
    assert.equal((await claire('GET', '/api/referral')).data.friends, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credits WHERE reason = 'Parrainage : filleul servi'").get().n, 1);
  } finally { server.close(); }
});

test('avis avec commentaire, note basse transmise à l\'équipe', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const a = addBooking(db, { client: claire, worker: uid(db, 'fatima@proprigo.test'), date: '2026-11-15', paid: true, status: 'terminee' });
    const b = addBooking(db, { client: claire, worker: uid(db, 'fatima@proprigo.test'), date: '2026-11-16', paid: true, status: 'terminee' });
    const c = await logged('claire@proprigo.test');
    assert.equal((await c('POST', `/api/bookings/${a}/rate`, { stars: 5, review: 'Parfait, merci !' })).status, 200);
    assert.equal(db.prepare('SELECT review FROM bookings WHERE id = ?').get(a).review, 'Parfait, merci !');
    assert.equal((await c('POST', `/api/bookings/${b}/rate`, { stars: 2, review: 'Salle de bain oubliée.' })).status, 200);
    assert.ok(db.prepare("SELECT 1 FROM incidents WHERE booking_id = ? AND source = 'note'").get(b));
  } finally { server.close(); }
});

test('intervenante : gains du mois et problème sur place qui alerte l\'équipe', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const ines = uid(db, 'ines@proprigo.test');
    addBooking(db, { client: claire, worker: ines, date: '2026-11-10', paid: true, status: 'terminee' });
    addBooking(db, { client: claire, worker: ines, date: '2026-10-10', paid: true, status: 'terminee' });
    const now = addBooking(db, { client: claire, worker: ines, date: '2026-11-21', time: '14:00', paid: true, status: 'attribuee' });
    const i = await logged('ines@proprigo.test');
    const g = (await i('GET', '/api/worker/earnings')).data;
    assert.equal(g.month.n, 1);
    assert.equal(g.month.eur, 3 * 24, 'indépendante : heures × son tarif');
    assert.equal(g.lastMonth.n, 1);
    assert.equal(g.upcoming.n, 1);
    assert.equal((await i('POST', `/api/worker/missions/${now}/problem`, { kind: 'nimporte' })).status, 400);
    const p = await i('POST', `/api/worker/missions/${now}/problem`, { kind: 'acces', text: 'Digicode faux' });
    assert.equal(p.status, 200);
    assert.ok(db.prepare("SELECT 1 FROM incidents WHERE booking_id = ? AND source = 'intervenante'").get(now));
    const ov = (await (await logged(...ADMIN))('GET', '/api/admin/overview')).data;
    assert.ok(ov.incidents.some((x) => x.booking_id === now));
  } finally { server.close(); }
});

test('attestation annuelle : ménages à domicile terminés de l\'année, sans Airbnb', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    addBooking(db, { client: claire, date: '2026-03-10', paid: true, status: 'terminee', total: 111 });
    const air = addBooking(db, { client: claire, date: '2026-04-10', paid: true, status: 'terminee', total: 95 });
    db.prepare("UPDATE bookings SET service = 'airbnb' WHERE id = ?").run(air);
    addBooking(db, { client: claire, date: '2025-12-10', paid: true, status: 'terminee', total: 74 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(base + '/api/me/attestation?year=2026', { headers: { Cookie: cookie } })).text();
    assert.match(html, /Attestation fiscale annuelle 2026/);
    assert.match(html, /111,00 €/);
    assert.ok(!html.includes('95,00 €'), 'pas d\'Airbnb');
    assert.ok(!html.includes('74,00 €'), 'pas l\'année précédente');
    assert.match(html, /Document provisoire/);
    assert.equal((await fetch(base + '/api/me/attestation')).status, 401);
  } finally { server.close(); }
});

test('fiches, notes internes, vrais chiffres et compte « planning » limité', async () => {
  const { server, db, logged } = await startServer();
  try {
    const claire = uid(db, 'claire@proprigo.test');
    const fatima = uid(db, 'fatima@proprigo.test');
    const id = addBooking(db, { client: claire, worker: fatima, date: '2026-11-15', paid: true, status: 'terminee' });
    db.prepare("INSERT INTO stripe_payments (session_id, client_id, booking_ids, amount_cents, status, refunded_cents) VALUES ('cs_m', ?, ?, 11100, 'paid', 1100)").run(claire, JSON.stringify([id]));
    const a = await logged(...ADMIN);
    const ov = (await a('GET', '/api/admin/overview')).data;
    assert.equal(ov.metrics.encaisseTotal, 100, 'encaissé moins remboursé');
    assert.equal(ov.staff, 'owner');
    assert.equal((await a('POST', '/api/admin/notes', { kind: 'client', target_id: claire, text: 'Préfère le matin.' })).status, 200);
    const fc = (await a('GET', `/api/admin/clients/${claire}`)).data;
    assert.equal(fc.notes[0].text, 'Préfère le matin.');
    assert.equal(fc.stats.menages, 1);
    const fw = (await a('GET', `/api/admin/workers/${fatima}/file`)).data;
    assert.equal(fw.stats.missions, 1);
    // compte planning
    assert.equal((await a('POST', '/api/admin/staff', { name: 'Sami Planning', email: 'sami@proprigo.test', password: 'planning-secret-1' })).status, 201);
    const pl = await logged('sami@proprigo.test', 'planning-secret-1');
    const o2 = (await pl('GET', '/api/admin/overview')).data;
    assert.equal(o2.staff, 'planning');
    assert.equal(o2.metrics, null, 'pas de chiffres d\'argent');
    assert.ok(o2.bookings.every((b) => b.total === null));
    assert.equal((await pl('GET', '/api/admin/planning')).status, 200);
    assert.equal((await pl('POST', `/api/admin/bookings/${id}/refund`)).status, 403, 'pas de remboursement');
    assert.equal((await pl('POST', '/api/admin/staff', { name: 'X', email: 'x@x.fr', password: 'xxxxxxxxxxxxxx' })).status, 403);
    assert.equal((await pl('GET', `/api/admin/clients/${claire}`)).data.client.email, '', 'coordonnées masquées');
    assert.equal((await (await logged('claire@proprigo.test'))('GET', `/api/admin/clients/${claire}`)).status, 403);
  } finally { server.close(); }
});

test('nettoyage de bureaux : prix HT, TVA 20 %, jamais à perte, pas dans l\'attestation', async () => {
  const pricing = require('../src/pricing');
  const at = new Date('2026-11-23T08:00:00Z');
  const idf = pricing.quote({ service: 'bureau', hours: 3, cp: '75008', date: '2026-12-01' }, at);
  assert.ok(idf.ok);
  assert.equal(idf.total, 126, '3 h × 42 € TTC');
  assert.equal(idf.pro, true);
  const fr = pricing.quote({ service: 'bureau', hours: 3, cp: '69001', date: '2026-12-01' }, at);
  assert.equal(fr.total, 117);
  for (const q of [idf, fr]) {
    const m = pricing.estimateMargin({ service: 'bureau', total: q.total, hours: 3, kit: 0 }, null);
    assert.ok(m.marge / m.ht >= 0.25, `marge ${Math.round((m.marge / m.ht) * 100)} %`);
  }
  const { server, db, logged } = await startServer();
  try {
    const c = await logged('claire@proprigo.test');
    const r = await c('POST', '/api/bookings', { service: 'bureau', hours: 3, cp: '75008', address: '10 avenue Test, 2e étage', date: '2026-12-01', time: '08:00', checklist: [] });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const b = db.prepare("SELECT * FROM bookings WHERE service = 'bureau'").get();
    assert.match(b.checklist, /Postes de travail|postes de travail/);
    db.prepare("UPDATE bookings SET status = 'terminee', paid = 1 WHERE id = ?").run(b.id);
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(base + '/api/me/attestation?year=2026', { headers: { Cookie: cookie } })).text();
    assert.ok(!html.includes('126,00 €'), 'les bureaux n\'ouvrent pas droit au crédit d\'impôt');
    const receipt = await (await fetch(base + `/api/bookings/${b.id}/receipt`, { headers: { Cookie: cookie } })).text();
    assert.match(receipt, /Nettoyage de bureaux/);
    assert.match(receipt, /professionnel/);
  } finally { server.close(); }
});
