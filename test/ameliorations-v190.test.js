'use strict';
// v1.9.0 : intervenante demandée, pourboires, documents qui expirent, relevé, langues,
// absences non prévenues, paie, IBAN et virements SEPA, notes partagées.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const engine = require('../src/engine');
const tiers = require('../src/tiers');

const clock = new Date('2026-11-25T10:00:00Z'); // mercredi
async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => clock, ...opts });
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
const CLAIRE = 7; const FATIMA = 2; const INES = 4;
const mk = (db, extra = {}) => Number(db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, worker_id)
  VALUES (?, 'menage', 3, '75011', '12 rue Test', ?, ?, 0, 0, 111, 'IDF', 1, 'paye', ?, '[]', ?)`).run(CLAIRE, extra.date || '2026-11-20', extra.time || '10:00', extra.status || 'terminee', extra.worker ?? null).lastInsertRowid);

test('réservation : le client peut demander une intervenante déjà venue chez lui', async () => {
  const a = await start();
  try {
    mk(a.db, { worker: FATIMA });
    const c = await a.session('claire@proprigo.test', 'demo-proprigo');
    const mw = (await c('GET', '/api/my-workers')).data;
    assert.equal(mw.list[0].id, FATIMA);
    assert.equal(mw.list[0].name, 'Fatima K.');
    let s = (await c('GET', `/api/slots?date=2026-11-30&cp=75011&hours=3&service=menage&worker_id=${FATIMA}`)).data;
    assert.equal(s.preferred.id, FATIMA);
    s = (await c('GET', `/api/slots?date=2026-11-30&cp=75011&hours=3&service=menage&worker_id=${INES}`)).data;
    assert.notEqual(s.preferred && s.preferred.id, INES, 'jamais une intervenante inconnue du client');
    assert.deepEqual(engine.preferredIds(a.db, { client_id: CLAIRE, want_worker_id: FATIMA })[0], FATIMA);
  } finally { a.close(); }
});

test('pourboire : reversé à l\'intervenante, une seule fois, et ajouté au versement des indépendantes', async () => {
  const a = await start();
  try {
    const bid = mk(a.db, { worker: INES, date: '2026-11-20' });
    const c = await a.session('claire@proprigo.test', 'demo-proprigo');
    assert.equal((await c('POST', `/api/bookings/${bid}/tip`, { amount: 0 })).status, 400);
    assert.equal((await c('POST', `/api/bookings/${bid}/tip`, { amount: 80 })).status, 400);
    const r = await c('POST', `/api/bookings/${bid}/tip`, { amount: 5 });
    assert.equal(r.status, 200);
    assert.equal((await c('POST', `/api/bookings/${bid}/tip`, { amount: 5 })).status, 409, 'un seul pourboire par ménage');
    assert.equal((await c('GET', '/api/bookings/mine')).data.find((b) => b.id === bid).tip, 5);
    const ines = await a.session('ines@proprigo.test', 'demo-proprigo');
    assert.equal((await ines('GET', '/api/worker/earnings')).data.tipsMonth, 5);
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const owed = (await admin('GET', '/api/admin/payouts')).data.owed.filter((o) => o.worker_id === INES);
    const withTip = owed.find((o) => o.tips === 5);
    assert.ok(withTip, 'le pourboire est dans un versement');
    assert.equal((await admin('POST', '/api/admin/payouts', { worker_id: INES, week_start: withTip.week_start })).status, 200);
    const after = (await admin('GET', '/api/admin/payouts')).data.owed.filter((o) => o.worker_id === INES);
    assert.ok(!after.some((o) => o.tips), 'jamais versé deux fois');
    // un ménage pas terminé ou d'un autre client : refusé
    const future = mk(a.db, { worker: INES, date: '2026-12-02', status: 'attribuee' });
    assert.equal((await c('POST', `/api/bookings/${future}/tip`, { amount: 5 })).status, 404);
  } finally { a.close(); }
});

test('documents : date d\'expiration, alertes, plus de nouvelles missions à expiration', async () => {
  const a = await start();
  try {
    const f = await a.session('fatima@proprigo.test', 'demo-proprigo');
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64');
    assert.equal((await f('POST', '/api/worker/documents', { kind: 'identite', data: pdf, expires_on: '2026-01-01' })).status, 400, 'déjà expiré');
    assert.equal((await f('POST', '/api/worker/documents', { kind: 'identite', data: pdf, expires_on: '2026-12-10' })).status, 200);
    const doc = a.db.prepare("SELECT id FROM worker_docs WHERE worker_id = ? AND kind = 'identite' ORDER BY id DESC").get(FATIMA);
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    assert.equal((await admin('POST', `/api/admin/documents/${doc.id}/review`, { decision: 'valide' })).status, 200);
    let d = (await f('GET', '/api/worker/documents')).data.list.find((k) => k.kind === 'identite');
    assert.equal(d.valid_until, '2026-12-10');
    assert.equal(d.soon, true, '15 jours : bientôt');
    assert.ok(a.runDocExpiry() >= 1, 'alerte à 30 jours');
    assert.equal(a.runDocExpiry(), 0, 'une seule fois');
    assert.equal(a.db.prepare('SELECT docs_expired FROM workers WHERE user_id = ?').get(FATIMA).docs_expired, 0);
    // expiré
    a.db.prepare('UPDATE worker_docs SET expires_on = ? WHERE id = ?').run('2026-11-20', doc.id);
    a.runDocExpiry();
    assert.equal(a.db.prepare('SELECT docs_expired FROM workers WHERE user_id = ?').get(FATIMA).docs_expired, 1);
    d = (await f('GET', '/api/worker/documents')).data;
    assert.ok(d.expired.length, 'signalé à l\'intervenante');
    const bid = mk(a.db, { date: '2026-11-28', status: 'en_attente' });
    const b = a.db.prepare('SELECT * FROM bookings WHERE id = ?').get(bid);
    assert.ok(!engine.candidates(a.db, b).some((w) => w.user_id === FATIMA), 'plus de nouvelles missions');
    // nouvelle version validée : de nouveau active
    assert.equal((await f('POST', '/api/worker/documents', { kind: 'identite', data: pdf, expires_on: '2030-01-01' })).status, 200);
    const nd = a.db.prepare("SELECT id FROM worker_docs WHERE worker_id = ? AND kind = 'identite' ORDER BY id DESC").get(FATIMA);
    await admin('POST', `/api/admin/documents/${nd.id}/review`, { decision: 'valide' });
    assert.equal(a.db.prepare('SELECT docs_expired FROM workers WHERE user_id = ?').get(FATIMA).docs_expired, 0);
    assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM worker_docs WHERE worker_id = ? AND kind = 'identite' AND status = 'valide'").get(FATIMA).n, 1, 'l\'ancienne version est remplacée');
  } finally { a.close(); }
});

test('relevé mensuel, langue de l\'espace, paie des salariées', async () => {
  const a = await start();
  try {
    mk(a.db, { worker: INES, date: '2026-11-10' });
    mk(a.db, { worker: FATIMA, date: '2026-11-22' }); // dimanche
    const ines = await a.session('ines@proprigo.test', 'demo-proprigo');
    const st = await ines('GET', '/api/worker/statement?month=2026-11');
    assert.equal(st.status, 200);
    assert.match(st.data, /Relevé de novembre 2026/);
    assert.match(st.data, /72,00 €/, '3 h × 24 €');
    assert.match(st.data, /encaissées/);
    assert.equal((await ines('GET', '/api/worker/statement?month=2026-13')).status, 400);
    // langue
    assert.equal((await ines('POST', '/api/me/lang', { lang: 'xx' })).status, 400);
    assert.equal((await ines('POST', '/api/me/lang', { lang: 'pt' })).status, 200);
    assert.equal((await ines('GET', '/api/me')).data.user.lang, 'pt');
    // paie
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const csv = (await admin('GET', '/api/admin/payroll.csv?month=2026-11')).data;
    const line = csv.split('\r\n').find((l) => l.startsWith('Fatima K.'));
    assert.ok(line, 'une ligne par salariée');
    const cols = line.split(';');
    assert.equal(cols[2], '1');
    assert.equal(cols[3], '3,00');
    assert.equal(cols[4], '3,00', 'heures du dimanche');
    assert.ok(!csv.includes('Inès'), 'pas les indépendantes');
  } finally { a.close(); }
});

test('absence non prévenue : la mission repart, pas de Platine pendant 6 mois', async () => {
  const a = await start();
  try {
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const future = mk(a.db, { worker: FATIMA, date: '2026-11-30', status: 'attribuee' });
    assert.equal((await admin('POST', `/api/admin/bookings/${future}/no-show`, {})).status, 409, 'pas avant le ménage');
    const bid = mk(a.db, { worker: FATIMA, date: '2026-11-25', status: 'attribuee' });
    assert.equal((await admin('POST', `/api/admin/bookings/${bid}/no-show`, { note: 'porte fermée' })).status, 200);
    assert.equal((await admin('POST', `/api/admin/bookings/${bid}/no-show`, {})).status, 404, 'plus d\'intervenante sur la réservation');
    const b = a.db.prepare('SELECT status, worker_id FROM bookings WHERE id = ?').get(bid);
    assert.equal(b.status, 'en_attente');
    assert.equal(b.worker_id, null);
    for (let i = 0; i < 80; i++) a.db.prepare("INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist, worker_id, rating) VALUES (?, 'menage', 3, '75011', 'x', '2026-10-01', '10:00', 0, 0, 111, 'IDF', 1, 'paye', 'terminee', '[]', ?, 5)").run(CLAIRE, FATIMA);
    const t = tiers.tierOf(a.db, FATIMA);
    assert.equal(t.absences, 1);
    assert.equal(t.key, 'or', '80 ménages à 5/5 mais une absence : Or, pas Platine');
  } finally { a.close(); }
});

test('IBAN et fichier de virements groupés SEPA', async () => {
  const company = { raisonSociale: 'Adel TEST EI', adresse: '1 rue de Paris', siret: '12345678900011', regimeTVA: 'franchise', iban: 'FR76 3000 6000 0112 3456 7890 189' };
  const a = await start({ companyConfig: company });
  try {
    mk(a.db, { worker: INES, date: '2026-11-16' }); // semaine terminée
    const ines = await a.session('ines@proprigo.test', 'demo-proprigo');
    assert.equal((await ines('POST', '/api/worker/iban', { iban: 'FR76 3000 6000 0112 3456 7890 188', name: 'Inès M.' })).status, 400, 'clé de contrôle fausse');
    assert.equal((await ines('POST', '/api/worker/iban', { iban: 'fr76 3000 6000 0112 3456 7890 189', name: 'Inès M.' })).status, 200);
    assert.equal((await ines('GET', '/api/worker/iban')).data.iban, 'FR76 •••• 0189');
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    const r = await admin('GET', '/api/admin/payouts/sepa.xml');
    assert.equal(r.status, 200);
    assert.match(r.data, /pain\.001\.001\.03/);
    assert.match(r.data, /<IBAN>FR7630006000011234567890189<\/IBAN>/);
    assert.match(r.data, /<InstdAmt Ccy="EUR">72\.00<\/InstdAmt>/);
    assert.match(r.data, /<NbOfTxs>1<\/NbOfTxs>/);
  } finally { a.close(); }
  const b = await start();
  try {
    const admin = await b.session('admin@proprigo.test', 'admin-test-123');
    assert.equal((await admin('GET', '/api/admin/payouts/sepa.xml')).status, 409, 'sans IBAN de Proprigo : message clair');
  } finally { b.close(); }
});

test('notes sur un client : partagées avec l\'intervenante seulement si demandé', async () => {
  const a = await start();
  try {
    mk(a.db, { worker: FATIMA, date: '2026-11-27', status: 'attribuee' });
    const admin = await a.session('admin@proprigo.test', 'admin-test-123');
    await admin('POST', '/api/admin/notes', { kind: 'client', target_id: CLAIRE, text: 'Client exigeant, interne' });
    await admin('POST', '/api/admin/notes', { kind: 'client', target_id: CLAIRE, text: 'Chien à la maison, gentil', share: true });
    const f = await a.session('fatima@proprigo.test', 'demo-proprigo');
    const m = (await f('GET', '/api/worker/missions')).data.missions.find((x) => x.date === '2026-11-27');
    assert.deepEqual(m.team_notes.map((n) => n.text), ['Chien à la maison, gentil']);
    const c = await a.session('claire@proprigo.test', 'demo-proprigo');
    assert.doesNotMatch(JSON.stringify((await c('GET', '/api/bookings/mine')).data), /Chien|exigeant/, 'jamais visible du client');
  } finally { a.close(); }
});
