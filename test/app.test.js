'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quote, zoneOf, estimateMargin } = require('../src/pricing');
const { distance } = require('../src/engine');
const { createApp } = require('../src/app');

const NOW = new Date('2026-11-21T09:00:00Z'); // un samedi
const at = (d) => quote(d, NOW);

test('zones par code postal', () => {
  assert.equal(zoneOf('75011'), 'IDF');
  assert.equal(zoneOf('95100'), 'IDF');
  assert.equal(zoneOf('69003'), 'FR');
  assert.equal(zoneOf('7501'), null);
  assert.equal(zoneOf('abcde'), null);
});

test('prix de la grille', () => {
  assert.equal(at({ service: 'menage', hours: 3, cp: '75011', date: '2026-11-23' }).total, 111);
  assert.equal(at({ service: 'menage', hours: 2, cp: '69003', date: '2026-11-23' }).total, 68);
  assert.equal(at({ service: 'grand', hours: 3, cp: '75011', date: '2026-11-23' }).total, 126);
  assert.equal(at({ service: 'airbnb', size: 'T2', cp: '75011', date: '2026-11-23' }).total, 119);
  assert.equal(at({ service: 'airbnb', size: 'T2', cp: '33000', date: '2026-11-23' }).total, 115);
});

test('suppléments', () => {
  // dimanche 22 novembre 2026 : +20 %
  assert.equal(at({ service: 'airbnb', size: 'T2', cp: '75011', date: '2026-11-22' }).total, Math.round(119 * 1.2));
  // jour férié : 25 décembre
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-12-25' }).total, Math.round(74 * 1.2));
  // urgence le jour même : +25 %
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-11-21', time: '11:30', urgent: true }).total, Math.round(74 * 1.25));
  // urgence : arrivée obligatoirement dans les 3 heures (il est 10 h à Paris)
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-11-21', time: '15:00', urgent: true }).ok, false);
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-11-21', urgent: true }).ok, false);
  // jours fériés calculés pour toutes les années : lundi de Pâques 2028 = 17 avril
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2028-04-17' }).total, Math.round(74 * 1.2));
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2028-04-18' }).total, 74);
  // urgence refusée un autre jour
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-11-23', urgent: true }).ok, false);
  // option matériel : +15 €, pas pour Airbnb
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-11-23', kit: true }).total, 89);
  assert.equal(at({ service: 'airbnb', size: 'studio', cp: '75011', date: '2026-11-23', kit: true }).ok, false);
});

test('erreurs de saisie', () => {
  assert.equal(at({ service: 'menage', hours: 1, cp: '75011', date: '2026-11-23' }).ok, false);
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-11-20' }).ok, false);
  assert.equal(at({ service: 'menage', hours: 2, cp: '75011', date: '2026-02-30' }).ok, false);
  assert.equal(at({ service: 'x', cp: '75011', date: '2026-11-23' }).ok, false);
});

test('aucune prestation de la grille à perte', () => {
  const cases = [];
  for (const cp of ['75011', '69003']) {
    for (const h of [2, 3]) cases.push({ service: 'menage', hours: h, cp }, { service: 'grand', hours: h, cp });
    for (const size of ['studio', 'T2', 'T3', 'maison']) cases.push({ service: 'airbnb', size, cp });
  }
  for (const c of cases) {
    const q = at({ ...c, date: '2026-11-23' });
    const m = estimateMargin({ ...c, total: q.total, hours: q.hours, kit: 0 });
    assert.ok(m.marge / m.ht >= 0.25, `${JSON.stringify(c)} : marge ${Math.round((m.marge / m.ht) * 100)} %`);
  }
});

test('distances', () => {
  assert.equal(distance('75011', '75011'), 0);
  assert.ok(distance('75011', '75012') < distance('75011', '75018'));
  assert.ok(distance('75011', '92100') < distance('75011', '78000'));
  assert.ok(distance('75011', '69003') >= 25);
  assert.ok(distance('75011', '75020') < distance('75011', '75018')); // le 20e est plus près du 11e que le 18e
});

// ---------- parcours complet par l'API ----------
async function startServer(opts = {}) {
  const { server, db, runReminders, runBackup } = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', now: () => NOW, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  return { server, db, agent, runReminders, runBackup };
}

test('parcours : réservation, attribution, mission, note, administration', async () => {
  const { server, agent } = await startServer();
  try {
    const client = agent();
    let r = await client('POST', '/api/signup', { role: 'client', name: 'Jeanne', email: 'jeanne@example.fr', password: 'motdepasse123' });
    assert.equal(r.status, 201);

    // le prix envoyé par le navigateur est ignoré
    r = await client('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75012', address: '10 rue de Charenton', date: '2026-11-23', time: '10:00', total: 1 });
    assert.equal(r.status, 201);
    assert.equal(r.data.total, 111);
    assert.equal(r.data.status, 'attribuee');
    assert.equal(r.data.worker_name, 'Fatima K.'); // salariée la plus proche (75011)
    const bid = r.data.id;

    // heure déjà passée aujourd'hui (il est 10 h à Paris)
    r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75012', address: '10 rue de Charenton', date: '2026-11-21', time: '09:00' });
    assert.equal(r.status, 400);

    // zone pas encore ouverte
    r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '69003', address: '1 rue de Lyon', date: '2026-11-23', time: '10:00' });
    assert.equal(r.status, 409);

    // un client ne peut pas utiliser l'espace administrateur
    r = await client('GET', '/api/admin/overview');
    assert.equal(r.status, 403);

    // l'intervenante fait la mission
    const fatima = agent();
    r = await fatima('POST', '/api/login', { email: 'fatima@proprigo.test', password: 'demo-proprigo' });
    assert.equal(r.status, 200);
    r = await fatima('GET', '/api/worker/missions');
    assert.equal(r.data.missions.length, 1);
    assert.equal((await fatima('POST', `/api/worker/missions/${bid}/finish`)).status, 409); // pas encore commencée
    assert.equal((await fatima('POST', `/api/worker/missions/${bid}/start`)).status, 200);
    assert.equal((await fatima('POST', `/api/worker/missions/${bid}/finish`)).status, 200);

    // le client note
    assert.equal((await client('POST', `/api/bookings/${bid}/rate`, { stars: 5 })).status, 200);
    assert.equal((await client('POST', `/api/bookings/${bid}/rate`, { stars: 4 })).status, 409);

    // l'administrateur voit le chiffre d'affaires
    const admin = agent();
    assert.equal((await admin('POST', '/api/login', { email: 'admin@proprigo.test', password: 'admin-test-123' })).status, 200);
    r = await admin('GET', '/api/admin/overview');
    assert.equal(r.data.kpis.terminees, 1);
    assert.equal(r.data.kpis.caHT, Math.round(111 / 1.1));
    assert.ok(r.data.kpis.marge > 0);
  } finally {
    server.close();
  }
});

test('parcours : absence, remplacement par une indépendante, refus sans pénalité', async () => {
  const { server, agent } = await startServer();
  try {
    const admin = agent();
    await admin('POST', '/api/login', { email: 'admin@proprigo.test', password: 'admin-test-123' });
    let r = await admin('GET', '/api/admin/overview');
    for (const name of ['Fatima K.', 'Aïssata D.']) {
      const w = r.data.workers.find((x) => x.name === name);
      await admin('POST', `/api/admin/workers/${w.user_id}/absent`);
    }
    const client = agent();
    await client('POST', '/api/login', { email: 'claire@proprigo.test', password: 'demo-proprigo' });
    r = await client('POST', '/api/bookings', { service: 'airbnb', size: 'T2', cp: '75020', address: '5 rue des Pyrénées', date: '2026-11-22', time: '11:00' });
    assert.equal(r.data.status, 'proposee');
    assert.equal(r.data.total, Math.round(119 * 1.2)); // dimanche
    const bid = r.data.id;

    const ines = agent();
    await ines('POST', '/api/login', { email: 'ines@proprigo.test', password: 'demo-proprigo' });
    r = await ines('GET', '/api/worker/missions');
    assert.equal(r.data.offers.length, 1);
    assert.equal(r.data.offers[0].address, undefined); // adresse cachée avant acceptation
    assert.equal((await ines('POST', `/api/worker/missions/${bid}/refuse`)).status, 200);

    const lucia = agent();
    await lucia('POST', '/api/login', { email: 'lucia@proprigo.test', password: 'demo-proprigo' });
    assert.equal((await lucia('POST', `/api/worker/missions/${bid}/accept`)).status, 200);
    assert.equal((await ines('POST', `/api/worker/missions/${bid}/accept`)).status, 409);

    // une candidate pas encore active ne peut rien faire
    const cand = agent();
    await cand('POST', '/api/signup', { role: 'intervenante', name: 'Nora', email: 'nora@example.fr', password: 'motdepasse123', statut: 'I', cp: '75019', rate: 23 });
    r = await cand('GET', '/api/worker/missions');
    assert.equal(r.data.active, false);
    assert.equal((await cand('POST', `/api/worker/missions/${bid}/accept`)).status, 403);
  } finally {
    server.close();
  }
});

test('sécurité de base', async () => {
  const { server, agent } = await startServer();
  try {
    const a = agent();
    assert.equal((await a('POST', '/api/signup', { name: 'X', email: 'x@example.fr', password: 'court' })).status, 400);
    for (let i = 0; i < 5; i++) await a('POST', '/api/login', { email: 'admin@proprigo.test', password: 'mauvais' });
    assert.equal((await a('POST', '/api/login', { email: 'admin@proprigo.test', password: 'admin-test-123' })).status, 429);
    assert.equal((await a('GET', '/api/bookings/mine')).status, 401);
  } finally {
    server.close();
  }
});

test('pas deux missions en même temps, et réattribution vers une autre intervenante', async () => {
  const { server, agent } = await startServer();
  try {
    const client = agent();
    await client('POST', '/api/login', { email: 'claire@proprigo.test', password: 'demo-proprigo' });
    const a = await client('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-23', time: '10:00' });
    const b = await client('POST', '/api/bookings', { service: 'airbnb', size: 'T2', cp: '75011', address: '2 rue Oberkampf', date: '2026-11-23', time: '10:00' });
    assert.equal(a.data.worker_name, 'Fatima K.');
    assert.notEqual(b.data.worker_name, 'Fatima K.'); // Fatima est déjà prise à 10 h
    const c = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '3 rue Oberkampf', date: '2026-11-23', time: '14:00' });
    assert.equal(c.data.worker_name, 'Fatima K.'); // 13 h + 30 min de trajet : libre à 14 h

    const admin = agent();
    await admin('POST', '/api/login', { email: 'admin@proprigo.test', password: 'admin-test-123' });
    // l'équipe voit la liste des intervenantes libres et choisit directement
    const cand = await admin('GET', `/api/admin/bookings/${c.data.id}/candidates`);
    assert.ok(cand.data.list.length >= 2);
    assert.ok(!cand.data.list.some((w) => w.name === 'Fatima K.')); // déjà sur la mission
    const aissata = cand.data.list.find((w) => w.name === 'Aïssata D.');
    let r = await admin('POST', `/api/admin/bookings/${c.data.id}/assign`, { worker_id: aissata.user_id });
    assert.equal(r.status, 200);
    let list = await client('GET', '/api/bookings/mine');
    assert.equal(list.data.find((x) => x.id === c.data.id).worker_name, 'Aïssata D.');
    // une indépendante choisie reçoit une proposition, pas la mission
    const ines = cand.data.list.find((w) => w.name === 'Inès M.');
    r = await admin('POST', `/api/admin/bookings/${c.data.id}/assign`, { worker_id: ines.user_id });
    assert.equal(r.data.status, 'proposee');
    // une intervenante occupée à cette heure-là ne peut pas être choisie
    const fatimaId = (await admin('GET', '/api/admin/overview')).data.workers.find((w) => w.name === 'Fatima K.').user_id;
    r = await admin('POST', `/api/admin/bookings/${b.data.id}/assign`, { worker_id: fatimaId });
    assert.equal(r.status, 409);

    // une candidate activée récupère les réservations restées sans intervenante
    const far = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '93200', address: '1 rue de la République', date: '2026-11-24', time: '10:00' });
    for (const w of (await admin('GET', '/api/admin/overview')).data.workers) {
      if (w.active && !w.absent) await admin('POST', `/api/admin/workers/${w.user_id}/absent`);
    }
    await admin('POST', `/api/admin/bookings/${far.data.id}/assign`, { worker_id: 'auto' });
    list = await client('GET', '/api/bookings/mine');
    assert.equal(list.data.find((x) => x.id === far.data.id).status, 'en_attente');
    const mariam = (await admin('GET', '/api/admin/overview')).data.workers.find((w) => w.name === 'Mariam S.');
    for (let i = mariam.step; i < mariam.steps.length - 1; i++) await admin('POST', `/api/admin/workers/${mariam.user_id}/advance`);
    list = await client('GET', '/api/bookings/mine');
    assert.equal(list.data.find((x) => x.id === far.data.id).worker_name, 'Mariam S.');
  } finally {
    server.close();
  }
});

test('paiement simulé, annulation à rembourser, production sans paiement bloquée', async () => {
  const { server, agent } = await startServer();
  try {
    const client = agent();
    await client('POST', '/api/login', { email: 'claire@proprigo.test', password: 'demo-proprigo' });
    const r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-25', time: '10:00' });
    assert.equal(r.data.payment_status, 'simule');
    assert.equal(r.data.paid, 0);
    await client('POST', `/api/bookings/${r.data.id}/cancel`);
    const admin = agent();
    await admin('POST', '/api/login', { email: 'admin@proprigo.test', password: 'admin-test-123' });
    let o = await admin('GET', '/api/admin/overview');
    assert.equal(o.data.kpis.aRembourser.montant, 74);
    assert.equal((await admin('POST', `/api/admin/bookings/${r.data.id}/refunded`)).status, 200);
    o = await admin('GET', '/api/admin/overview');
    assert.equal(o.data.kpis.aRembourser.n, 0);
  } finally {
    server.close();
  }
  const { server: prod } = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', production: true, now: () => NOW });
  await new Promise((res) => prod.listen(0, res));
  try {
    const base = `http://127.0.0.1:${prod.address().port}`;
    const h = { 'Content-Type': 'application/json' };
    const login = await fetch(base + '/api/login', { method: 'POST', headers: h, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const res = await fetch(base + '/api/bookings', { method: 'POST', headers: { ...h, Cookie: cookie }, body: JSON.stringify({ service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-25', time: '10:00' }) });
    assert.equal(res.status, 503);
  } finally {
    prod.close();
  }
});

// ---------- fonctionnalités ajoutées ----------
async function logged(agent, email, password = 'demo-proprigo') {
  const a = agent();
  const r = await a('POST', '/api/login', { email, password });
  assert.equal(r.status, 200);
  return a;
}
const ADMIN = ['admin@proprigo.test', 'admin-test-123'];

test('les créneaux restent proposés sans intervenante et la commande est créée', async () => {
  const { server, agent } = await startServer();
  try {
    const admin = await logged(agent, ...ADMIN);
    for (const w of (await admin('GET', '/api/admin/overview')).data.workers) if (w.active) await admin('POST', `/api/admin/workers/${w.user_id}/absent`);
    const client = await logged(agent, 'claire@proprigo.test');
    const slots = (await client('GET', '/api/slots?date=2026-11-24&cp=75011&hours=2')).data.slots;
    assert.ok(slots.includes('10:00'));
    const r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-24', time: '10:00' });
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'en_attente');
  } finally { server.close(); }
});

test('réservation récurrente avec la même intervenante, puis arrêt', async () => {
  const { server, agent } = await startServer();
  try {
    const client = await logged(agent, 'claire@proprigo.test');
    let r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75018', address: '5 rue Lepic', date: '2026-11-23', time: '10:00', repeat: '7', occurrences: 4 });
    assert.equal(r.status, 201);
    assert.equal(r.data.created, 4);
    const list = (await client('GET', '/api/bookings/mine')).data.filter((b) => b.series_id === r.data.series_id);
    assert.deepEqual(list.map((b) => b.date).sort(), ['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']);
    assert.equal(new Set(list.map((b) => b.worker_name)).size, 1); // toujours la même intervenante
    r = await client('POST', `/api/series/${r.data.series_id}/stop`);
    assert.equal(r.status, 200);
    const after = (await client('GET', '/api/bookings/mine')).data.filter((b) => b.series_id === list[0].series_id);
    assert.ok(after.every((b) => b.status === 'annulee'));
  } finally { server.close(); }
});

test('modification : nouveau prix, vérification des disponibilités, délai de 24 h', async () => {
  const { server, agent } = await startServer();
  try {
    const client = await logged(agent, 'claire@proprigo.test');
    let r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-25', time: '10:00' });
    const id = r.data.id;
    r = await client('POST', `/api/bookings/${id}/update`, { date: '2026-11-29', hours: 3 }); // un dimanche, 3 h
    assert.equal(r.status, 200);
    assert.equal(r.data.total, Math.round(111 * 1.2));
    assert.equal(r.data.diff, Math.round(111 * 1.2) - 74);
    r = await client('POST', `/api/bookings/${id}/update`, { date: '2026-11-21', time: '18:00' }); // moins de 24 h
    assert.equal(r.status, 409);
    r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-22', time: '09:00' });
    assert.equal((await client('POST', `/api/bookings/${r.data.id}/update`, { time: '11:00' })).status, 409); // ménage dans moins de 24 h
  } finally { server.close(); }
});

test('checklist, photos avec consentement, signalement, messagerie sans numéros', async () => {
  const { server, agent } = await startServer();
  try {
    const client = await logged(agent, 'claire@proprigo.test');
    let r = await client('POST', '/api/bookings', { service: 'airbnb', size: 'studio', cp: '75011', address: '1 rue Oberkampf', date: '2026-11-24', time: '10:00', photoConsent: true, checklist: ['Changer les draps et les serviettes', 'Arroser la plante du salon'] });
    const id = r.data.id;
    assert.deepEqual(r.data.checklist.map((t) => t.task), ['Changer les draps et les serviettes', 'Arroser la plante du salon']);
    const noPhoto = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '9 rue Oberkampf', date: '2026-11-25', time: '10:00' });
    assert.equal(noPhoto.data.checklist.length, 5); // tâches par défaut

    const fatima = await logged(agent, 'fatima@proprigo.test');
    const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
    assert.equal((await fatima('POST', `/api/bookings/${id}/photos`, { kind: 'avant', data: jpeg })).status, 409); // pas encore commencé
    await fatima('POST', `/api/worker/missions/${id}/start`);
    assert.equal((await fatima('POST', `/api/bookings/${id}/photos`, { kind: 'avant', data: 'data:image/jpeg;base64,AAAA' })).status, 400);
    assert.equal((await fatima('POST', `/api/bookings/${id}/photos`, { kind: 'avant', data: jpeg })).status, 200);
    assert.equal((await fatima('POST', `/api/worker/missions/${id}/checklist`, { index: 1, done: true })).status, 200);
    assert.equal((await fatima('POST', `/api/worker/missions/${id}/finish`)).status, 409); // photo « après » obligatoire
    await fatima('POST', `/api/bookings/${id}/photos`, { kind: 'apres', data: jpeg });
    assert.equal((await fatima('POST', `/api/worker/missions/${id}/finish`)).status, 200);
    await fatima('POST', `/api/worker/missions/${noPhoto.data.id}/start`);
    assert.equal((await fatima('POST', `/api/bookings/${noPhoto.data.id}/photos`, { kind: 'avant', data: jpeg })).status, 403); // pas de consentement

    // le client voit la checklist cochée et les photos ; un autre client non
    const mine = (await client('GET', '/api/bookings/mine')).data.find((b) => b.id === id);
    assert.equal(mine.checklist[1].done, true);
    assert.equal(mine.photos.length, 2);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/photos/${mine.photos[0].id}`)).status, 404); // sans session
    const other = agent();
    await other('POST', '/api/signup', { role: 'client', name: 'Autre', email: 'autre@example.fr', password: 'motdepasse123' });
    assert.equal((await other('GET', `/api/bookings/${id}/messages`)).status, 404);

    // messagerie : numéros et e-mails masqués ; l'intervenante ne voit pas le téléphone du client
    await client('POST', `/api/bookings/${id}/messages`, { text: 'Appelez-moi au 06 12 34 56 78 ou claire@mail.fr' });
    const msgs = (await fatima('GET', `/api/bookings/${id}/messages`)).data;
    assert.equal(msgs[0].text, 'Appelez-moi au [numéro masqué] ou [e-mail masqué]');
    const missions = (await fatima('GET', '/api/worker/missions')).data.missions;
    assert.ok(missions.every((m) => m.client_phone === undefined));

    // signalement puis traitement
    assert.equal((await client('POST', `/api/bookings/${id}/report`, { text: 'La salle de bain n\'a pas été faite.' })).status, 200);
    const admin = await logged(agent, ...ADMIN);
    const inc = (await admin('GET', '/api/admin/overview')).data.incidents;
    assert.equal(inc.length, 1);
    assert.equal((await admin('POST', `/api/admin/incidents/${inc[0].id}/resolve`)).status, 200);
  } finally { server.close(); }
});

test('une réservation reste à attribuer par l’administrateur si aucune intervenante n’est libre', async () => {
  const { server, agent } = await startServer();
  try {
    const admin = await logged(agent, ...ADMIN);
    for (const w of (await admin('GET', '/api/admin/overview')).data.workers) if (w.active) await admin('POST', `/api/admin/workers/${w.user_id}/absent`);
    const client = await logged(agent, 'claire@proprigo.test');
    const r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-24', time: '14:00' });
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'en_attente');
    const overview = (await admin('GET', '/api/admin/overview')).data;
    assert.ok(overview.bookings.some((b) => b.id === r.data.id && b.status === 'en_attente'));
  } finally { server.close(); }
});

test('espace propriétaires : logements, consignes, calendrier Airbnb', async () => {
  let cal = '';
  const ics = (events) => ['BEGIN:VCALENDAR', ...events.flatMap(([uid, a, b, sum]) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, `SUMMARY:${sum}`, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
  let clock = new Date('2026-11-21T10:00:00Z');
  const { server, agent, db } = await startServer({ icalAllowAny: true, icalFetch: async () => cal, now: () => clock });
  const later = (min) => { clock = new Date(clock.getTime() + min * 60e3); };
  try {
    const client = await logged(agent, 'claire@proprigo.test');
    let r = await client('POST', '/api/homes', { name: 'Studio Oberkampf', address: '12 rue Oberkampf', cp: '75011', service: 'airbnb', size: 'studio', instructions: 'Boîte à clés 1234, draps dans le placard du couloir', photo_consent: true, ical_url: 'https://www.airbnb.fr/calendar/ical/1.ics', checklist: ['Changer les draps et les serviettes', 'Réassort café'] });
    assert.equal(r.status, 201);
    const hid = r.data.id;
    cal = ics([['a1', '20261125', '20261128', 'Reserved'], ['b2', '20261128', '20261201', 'Airbnb (Not available)'], ['c3', '20270220', '20270301', 'Reserved']]);
    r = await client('POST', `/api/homes/${hid}/sync`);
    assert.equal(r.data.created, 1); // seulement le séjour dans les 60 jours ; dates bloquées ignorées
    later(3);
    r = await client('POST', `/api/homes/${hid}/sync`);
    assert.equal(r.data.created, 0); // pas de doublon
    assert.equal((await client('POST', `/api/homes/${hid}/sync`)).status, 429, 'une synchronisation manuelle toutes les 2 minutes');
    let b = (await client('GET', '/api/bookings/mine')).data.find((x) => x.home_id === hid);
    assert.equal(b.date, '2026-11-28');
    assert.equal(b.time, '11:00');
    assert.equal(b.total, 95);
    assert.equal(b.source, 'ical');
    assert.deepEqual(b.checklist.map((t) => t.task), ['Changer les draps et les serviettes', 'Réassort café']);
    // l'intervenante voit les consignes du logement
    const fatima = await logged(agent, 'fatima@proprigo.test');
    const m = (await fatima('GET', '/api/worker/missions')).data.missions.find((x) => x.id === b.id);
    assert.equal(m.instructions, 'Boîte à clés 1234, draps dans le placard du couloir');
    // calendrier coupé en route : erreur, rien n'est modifié
    cal = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1';
    later(3);
    assert.equal((await client('POST', `/api/homes/${hid}/sync`)).status, 400);
    // le séjour disparaît : jamais d'annulation automatique
    cal = ics([]);
    later(3);
    r = await client('POST', `/api/homes/${hid}/sync`);
    assert.equal(r.data.flagged, 0, 'première absence : on attend une confirmation');
    later(30);
    r = await client('POST', `/api/homes/${hid}/sync`);
    assert.equal(r.data.flagged, 0, 'moins d\'une heure après : toujours rien');
    later(40);
    r = await client('POST', `/api/homes/${hid}/sync`);
    assert.equal(r.data.flagged, 1, 'absent deux fois à plus d\'une heure d\'écart : signalé');
    b = (await client('GET', '/api/bookings/mine')).data.find((x) => x.id === b.id);
    assert.equal(b.status, 'attribuee', 'le ménage reste prévu');
    assert.equal(b.ical_flagged, 1);
    const adm = await logged(agent, ...ADMIN);
    assert.equal((await adm('GET', '/api/admin/overview')).data.icalFlagged.length, 1);
    // le séjour réapparaît : le signalement disparaît
    cal = ics([['a1', '20261125', '20261128', 'Reserved']]);
    later(3);
    await client('POST', `/api/homes/${hid}/sync`);
    assert.equal((await client('GET', '/api/bookings/mine')).data.find((x) => x.id === b.id).ical_flagged, 0);
    // il disparaît pour de bon : le client choisit de garder le ménage, il n'est plus signalé
    cal = ics([]);
    later(3); await client('POST', `/api/homes/${hid}/sync`);
    later(70); await client('POST', `/api/homes/${hid}/sync`);
    assert.equal((await client('POST', `/api/bookings/${b.id}/ical-keep`)).status, 200);
    later(70); r = await client('POST', `/api/homes/${hid}/sync`);
    assert.equal(r.data.flagged, 0);
    // l'équipe peut annuler avec remboursement complet
    assert.equal((await adm('POST', `/api/admin/bookings/${b.id}/cancel`)).status, 200);
    b = (await client('GET', '/api/bookings/mine')).data.find((x) => x.id === b.id);
    assert.equal(b.status, 'annulee');
    assert.equal(b.refund_amount, b.total);
    // réservation manuelle rattachée au logement
    r = await client('POST', '/api/bookings', { home_id: hid, service: 'airbnb', size: 'studio', cp: '75011', address: '12 rue Oberkampf', date: '2026-11-26', time: '11:00' });
    assert.equal(r.data.home_id, hid);
    // logement d'un autre client inaccessible
    const other = agent();
    await other('POST', '/api/signup', { role: 'client', name: 'Autre', email: 'autre2@example.fr', password: 'motdepasse123' });
    assert.equal((await other('POST', `/api/homes/${hid}/sync`)).status, 404);
  } finally { server.close(); }

  // sans l'option de test, seuls les liens https des plateformes sont acceptés
  const { server: s2, agent: a2 } = await startServer({ icalFetch: async () => '' });
  try {
    const client = await logged(a2, 'claire@proprigo.test');
    const r = await client('POST', '/api/homes', { name: 'Test', address: '1 rue Test', cp: '75011', ical_url: 'http://127.0.0.1/cal.ics' });
    assert.equal((await client('POST', `/api/homes/${r.data.id}/sync`)).status, 400);
  } finally { s2.close(); }
});

test('e-mails, règle d\'annulation, rappel la veille et reçu', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
  const { server, agent, runReminders } = await startServer({ mail: { outbox } });
  const wait = () => new Promise((r) => setTimeout(r, 50));
  const mails = () => fs.readdirSync(outbox).map((f) => fs.readFileSync(path.join(outbox, f), 'utf8').split('\n')[0]);
  try {
    const client = await logged(agent, 'claire@proprigo.test');
    // annulation gratuite à plus de 24 h
    let r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-25', time: '10:00' });
    await wait();
    assert.ok(mails().some((m) => /claire@proprigo.test.*Réservation confirmée/.test(m)));
    assert.ok(mails().some((m) => /fatima@proprigo.test.*Nouvelle mission/.test(m)));
    r = await client('POST', `/api/bookings/${r.data.id}/cancel`);
    assert.equal(r.data.refund, 74);
    // annulation tardive : 50 % remboursés
    r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-22', time: '09:00' });
    const late = r.data.id;
    // rappel la veille (nous sommes le 21) : une seule fois
    assert.equal(runReminders(), 1);
    assert.equal(runReminders(), 0);
    await wait();
    assert.ok(mails().some((m) => /Rappel : votre ménage demain/.test(m)));
    r = await client('POST', `/api/bookings/${late}/cancel`);
    assert.equal(r.data.refund, Math.round(Math.round(74 * 1.2) * 0.5 * 100) / 100);
    // reçu : seulement une fois terminé, seulement pour le client
    r = await client('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Oberkampf', date: '2026-11-26', time: '10:00' });
    const id = r.data.id;
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await client('GET', `/api/bookings/${id}/receipt`)).status, 409);
    const fatima = await logged(agent, 'fatima@proprigo.test');
    await fatima('POST', `/api/worker/missions/${id}/start`);
    await fatima('POST', `/api/worker/missions/${id}/finish`);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const html = await (await fetch(`${base}/api/bookings/${id}/receipt`, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } })).text();
    assert.match(html, /Facture TEST-\d+/); // démo : document de test, sans numéro comptable
    assert.match(html, /DOCUMENT DE TEST/);
    assert.match(html, /74,00/);
    await wait();
    assert.ok(mails().some((m) => /Votre ménage est terminé/.test(m)));
    // l'équipe voit les e-mails envoyés
    const admin = await logged(agent, ...ADMIN);
    const ob = await admin('GET', '/api/admin/outbox');
    assert.ok(ob.data.list.length >= 5);
    assert.equal((await client('GET', '/api/admin/outbox')).status, 403);
  } finally { server.close(); }
});

test('réattribuer à la même intervenante ne crée ni doublon dans le journal ni second e-mail', async () => {
  const { server, db, agent } = await startServer({ seed: true });
  try {
    const c = await logged(agent, 'claire@proprigo.test');
    const r = await c('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75011', address: '1 rue Test', date: '2026-11-25', time: '10:00', checklist: [] });
    assert.equal(r.status, 201);
    const id = r.data.id;
    const a = await logged(agent, ...ADMIN);
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM events WHERE text LIKE ?').get(`Réservation n° ${id} : attribuée%`).n;
    const before = count();
    for (let i = 0; i < 3; i++) assert.equal((await a('POST', `/api/admin/bookings/${id}/assign`, { worker_id: 'auto' })).status, 200);
    assert.equal(count(), before);
  } finally { server.close(); }
});

test('mot de passe oublié, mon compte et suppression du compte', async () => {
  const mailer = require('../src/mailer');
  const { server, db, agent } = await startServer({ seed: true });
  try {
    const anon = agent();
    // même réponse que le compte existe ou non
    const a1 = await anon('POST', '/api/password/forgot', { email: 'claire@proprigo.test' });
    const a2 = await anon('POST', '/api/password/forgot', { email: 'personne@proprigo.test' });
    assert.equal(a1.status, 200); assert.equal(a1.data.message, a2.data.message);
    const mail = mailer.outbox().find((m) => m.to === 'claire@proprigo.test' && /Nouveau mot de passe/.test(m.subject));
    const token = /t=([0-9a-f]{64})/.exec(mailer.readOutbox(mail.file))[1];
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resets WHERE token_hash = ?').get(token).n, 0, 'le jeton est stocké haché');
    assert.equal((await anon('POST', '/api/password/reset', { token, password: 'court' })).status, 400);
    assert.equal((await anon('POST', '/api/password/reset', { token, password: 'nouveau-mdp-123' })).status, 200);
    assert.equal((await anon('POST', '/api/password/reset', { token, password: 'encore-un-123' })).status, 400, 'lien à usage unique');
    assert.equal((await agent()('POST', '/api/login', { email: 'claire@proprigo.test', password: 'demo-proprigo' })).status, 401);
    const c = await logged(agent, 'claire@proprigo.test', 'nouveau-mdp-123');
    // informations
    assert.equal((await c('POST', '/api/account', { name: 'Claire Martin', phone: '06 12 34 56 78' })).status, 200);
    assert.equal((await c('GET', '/api/me')).data.user.name, 'Claire Martin');
    assert.equal((await c('POST', '/api/account/password', { current: 'faux', password: 'autre-mdp-123' })).status, 400);
    assert.equal((await c('POST', '/api/account/password', { current: 'nouveau-mdp-123', password: 'autre-mdp-123' })).status, 200);
    // suppression : refusée tant qu'un ménage est prévu
    const b = await c('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75011', address: '1 rue Test', date: '2026-11-28', time: '10:00', checklist: [] });
    assert.equal(b.status, 201);
    assert.equal((await c('POST', '/api/account/delete', { password: 'autre-mdp-123' })).status, 409);
    await c('POST', `/api/bookings/${b.data.id}/cancel`, {});
    assert.equal((await c('POST', '/api/account/delete', { password: 'mauvais' })).status, 400);
    assert.equal((await c('POST', '/api/account/delete', { password: 'autre-mdp-123' })).status, 200);
    const u = db.prepare("SELECT * FROM users WHERE name = 'Client supprimé'").get();
    assert.ok(u && /^supprime-/.test(u.email) && !u.phone);
    assert.equal((await c('GET', '/api/me')).data.user, null);
    assert.equal((await agent()('POST', '/api/login', { email: 'claire@proprigo.test', password: 'autre-mdp-123' })).status, 401);
    // une intervenante ne peut pas supprimer son compte seule
    const w = await logged(agent, 'fatima@proprigo.test');
    assert.equal((await w('POST', '/api/account/delete', { password: 'demo-proprigo' })).status, 400);
  } finally { server.close(); }
});

test('calendriers : téléchargement limité, adresses internes refusées, fichier incomplet rejeté', async () => {
  const http = require('node:http');
  const ical = require('../src/ical');
  const srv = http.createServer((req, res) => {
    if (req.url === '/gros.ics') { // 2 Mo envoyés sans annoncer la taille
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      const chunk = 'X'.repeat(64 * 1024);
      let n = 0;
      const push = () => { while (n < 32) { n += 1; if (!res.write(chunk)) return res.once('drain', push); } res.end(); };
      return push();
    }
    if (req.url === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Connexion</html>'); }
    if (req.url === '/redir.ics') { res.writeHead(302, { Location: 'http://127.0.0.1/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await assert.rejects(ical.download(`${base}/gros.ics`), /trop volumineux/);
    await assert.rejects(ical.download(`${base}/page.html`), /pas un calendrier/);
    await assert.rejects(ical.download(`${base}/redir.ics`));
    assert.match(await ical.download(`${base}/ok.ics`), /END:VCALENDAR/);
  } finally { srv.close(); }
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.10.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) assert.ok(ical.isPrivate(ip), ip);
  for (const ip of ['54.239.28.85', '2a03:2880::1']) assert.ok(!ical.isPrivate(ip), ip);
  assert.throws(() => ical.checkComplete('BEGIN:VCALENDAR\r\nBEGIN:VEVENT'), /incomplet/);
  assert.throws(() => ical.checkComplete('<html>erreur</html>'), /incomplet/);
  assert.doesNotThrow(() => ical.checkComplete('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'));
});

test('sauvegardes et adresse de surveillance', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const { server, agent, runBackup } = await startServer({ backupDir: dir });
  try {
    const anon = agent();
    const h = await anon('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.data.ok, true);
    assert.equal(h.data.database, 'ok');
    assert.ok(!JSON.stringify(h.data).includes('@'), 'aucune donnée personnelle');
    const a = await logged(agent, ...ADMIN);
    assert.equal((await anon('POST', '/api/admin/backups', {})).status, 401);
    assert.equal((await a('POST', '/api/admin/backups', {})).status, 200);
    const l = (await a('GET', '/api/admin/backups')).data.list;
    assert.equal(l.length, 1);
    const copy = new DatabaseSync(path.join(dir, l[0].file));
    assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0, 'la sauvegarde contient les données');
    copy.close();
    // seules les 14 dernières sont gardées
    const backups = require('../src/backup');
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `proprigo-202601${String(i + 10).padStart(2, '0')}-0300.db`), '');
    runBackup();
    assert.equal(backups.list(dir).length, 14);
  } finally { server.close(); }
});

test('indépendantes : une proposition reste « en attente » et ne peut pas chevaucher une autre mission', async () => {
  const { server, db, agent } = await startServer({ seed: true });
  try {
    const a = await logged(agent, ...ADMIN);
    // aucune salariée disponible : les missions partent aux indépendantes
    for (const w of db.prepare("SELECT user_id FROM workers WHERE statut = 'S'").all()) db.prepare('UPDATE workers SET absent = 1 WHERE user_id = ?').run(w.user_id);
    const ines = db.prepare("SELECT id FROM users WHERE email = 'ines@proprigo.test'").get().id;
    const c = await logged(agent, 'claire@proprigo.test');
    const r1 = await c('POST', '/api/bookings', { service: 'menage', hours: 3, cp: '75020', address: '1 rue Test', date: '2026-11-25', time: '10:00', checklist: [] });
    assert.equal(r1.status, 201);
    let b1 = (await c('GET', '/api/bookings/mine')).data.find((x) => x.id === r1.data.id);
    assert.equal(b1.status, 'proposee', 'proposée, pas confirmée');
    assert.equal(b1.worker_id, null, 'aucune intervenante tant qu\'elle n\'a pas accepté');
    assert.ok(db.prepare("SELECT 1 FROM offers WHERE booking_id = ? AND worker_id = ? AND state = 'offered'").get(r1.data.id, ines));
    // une deuxième mission au même moment n'est pas proposée à Inès (elle a déjà une proposition en attente)
    const r2 = await c('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75020', address: '2 rue Test', date: '2026-11-25', time: '11:00', checklist: [] });
    if (r2.status === 201) assert.ok(!db.prepare("SELECT 1 FROM offers WHERE booking_id = ? AND worker_id = ? AND state = 'offered'").get(r2.data.id, ines));
    // si elle a entre-temps une mission confirmée à la même heure, elle ne peut pas accepter
    db.prepare("INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, status, worker_id) VALUES (?, 'menage', 2, '75020', 'x', '2026-11-25', '09:30', 0, 0, 74, 'IDF', 0, 'attribuee', ?)").run(db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id, ines);
    const i = await logged(agent, 'ines@proprigo.test');
    const acc = await i('POST', `/api/worker/missions/${r1.data.id}/accept`);
    assert.equal(acc.status, 409);
    assert.match(acc.data.error, /déjà une mission/);
    b1 = (await c('GET', '/api/bookings/mine')).data.find((x) => x.id === r1.data.id);
    assert.equal(b1.status, 'proposee');
    void a;
  } finally { server.close(); }
});

test('créneaux proposés : durée et délai minimal le jour même', async () => {
  const engine = require('../src/engine');
  assert.ok(engine.requestSlots({ hours: 2 }).includes('10:00'));
  assert.ok(!engine.requestSlots({ hours: 8 }).includes('18:00'));
  const { server, agent } = await startServer({ seed: true });
  try {
    const c = await logged(agent, 'claire@proprigo.test');
    const slots = (await c('GET', '/api/slots?date=2026-11-25&cp=75011&hours=2')).data.slots;
    assert.ok(slots.includes('10:00'));
    const today = (await c('GET', '/api/slots?date=2026-11-21&cp=75011&hours=2')).data.slots;
    assert.ok(today.every((t) => t >= '11:00'), today.join(' '));
    assert.equal((await c('POST', '/api/bookings', { service: 'menage', hours: 2, cp: '75011', address: '1 rue Test', date: '2026-11-21', time: '10:30', checklist: [] })).status, 400);
  } finally { server.close(); }
});


test('administration : création contrôlée et protection des profils fictifs', async () => {
  const { server, agent, db } = await startServer({ seed: false, production: false });
  try {
    const adminId = require('../src/db').createUser(db, { role: 'admin', email: 'admin@exemple.fr', password: 'secret-admin-123', name: 'Admin' });
    const admin = agent();
    assert.equal((await admin('POST', '/api/login', { email: 'admin@exemple.fr', password: 'secret-admin-123' })).status, 200);
    const worker = { name: 'Marie Dupont', email: 'marie@example.fr', password: 'temporaire123', cp: '75011', statut: 'S' };
    let r = await admin('POST', '/api/admin/workers', worker);
    assert.equal(r.status, 201);
    assert.equal(db.prepare('SELECT step FROM workers WHERE user_id=?').get(r.data.id).step, 0);
    assert.equal((await admin('POST', '/api/admin/workers', worker)).status, 409);
    r = await admin('POST', '/api/admin/workers/demo', {});
    assert.equal(r.data.created, 5);
    assert.equal((await admin('POST', '/api/admin/workers/demo', {})).data.created, 0);
    const demo = db.prepare("SELECT u.id, w.step, w.absent FROM users u JOIN workers w ON w.user_id=u.id WHERE u.email='fatima@proprigo.test'").get();
    assert.equal(demo.step, 0);
    assert.equal(demo.absent, 1);
    assert.equal((await admin('POST', `/api/admin/workers/${demo.id}/advance`, {})).status, 403);
    assert.equal((await admin('GET', '/api/admin/overview')).data.workers.length, 6);
    assert.ok(adminId > 0);
  } finally { server.close(); }
});
