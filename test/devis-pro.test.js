'use strict';
// v1.10.0 : devis envoyé au professionnel, consulté et accepté en ligne
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

test('devis : envoi, page publique, acceptation, admin prévenu', async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', companyConfig: { raisonSociale: 'PROPRIGO', regimeTVA: 'franchise' } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const j = (path, method = 'GET', body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json() }));
  try {
    const ask = await j('/api/quote-requests', 'POST', { company: 'Agence Test', name: 'Paul Martin', email: 'paul@exemple.fr', phone: '0600000000', cp: '75010', kind: 'bureaux', surface: 120, frequency: '2 fois par semaine' });
    assert.equal(ask.status, 200);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'admin@proprigo.test', password: 'admin-test-123' }) });
    const admin = login.headers.get('set-cookie').split(';')[0];
    const list = (await j('/api/admin/quote-requests', 'GET', null, admin)).data;
    const q = list.find((x) => x.company === 'Agence Test');
    assert.equal(q.status, 'nouveau');
    assert.equal(q.offer_token, undefined, 'le jeton reste secret');
    const bad = await j(`/api/admin/quote-requests/${q.id}/offer`, 'POST', { label: 'Bureaux', hours: 2, rate: 5, frequency: 'twice' }, admin);
    assert.equal(bad.status, 400);
    const sent = await j(`/api/admin/quote-requests/${q.id}/offer`, 'POST', { label: 'Nettoyage de bureaux', hours: 2, rate: 36, frequency: 'twice', message: 'Matériel fourni.' }, admin);
    assert.equal(sent.status, 200);
    assert.match(sent.data.quote.offer_number, /^D\d{4}-0001$/);
    assert.equal(sent.data.quote.offer.perVisitHT, 72);
    assert.equal(sent.data.quote.offer.vatRate, 0, 'franchise : pas de TVA');
    const t = sent.data.quote.link.split('t=')[1];
    assert.equal((await j('/api/devis?t=abc')).status, 404);
    const pub = (await j(`/api/devis?t=${t}`)).data;
    assert.equal(pub.client.company, 'Agence Test');
    assert.equal(pub.offer.perVisitTTC, 72);
    assert.equal(pub.legal.raisonSociale, 'PROPRIGO');
    assert.equal((await j('/api/devis/answer', 'POST', { t, accept: true, name: '' })).status, 400, 'un nom est demandé');
    const yes = await j('/api/devis/answer', 'POST', { t, accept: true, name: 'Paul Martin' });
    assert.equal(yes.status, 200);
    assert.equal((await j('/api/devis/answer', 'POST', { t, accept: true, name: 'Paul Martin' })).status, 409, 'pas deux fois');
    const after = (await j('/api/admin/quote-requests', 'GET', null, admin)).data.find((x) => x.id === q.id);
    assert.equal(after.status, 'accepte');
    assert.equal(after.answer_name, 'Paul Martin');
    assert.equal((await j(`/api/admin/quote-requests/${q.id}/offer`, 'POST', { label: 'X', hours: 2, rate: 40, frequency: 'once' }, admin)).status, 409, 'devis accepté : plus modifiable');
  } finally { app.server.close(); }
});
