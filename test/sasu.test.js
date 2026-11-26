'use strict';
// v1.9.3 : passage en SASU — factures et mentions légales remplies depuis config/entreprise.json
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');

const SASU = {
  nomCommercial: 'Proprigo', raisonSociale: 'PROPRIGO', formeJuridique: 'SASU', capital: '1 000 €',
  adresse: '12 rue Exemple, 75011 Paris', siret: '12345678900012', rcs: 'Paris 123 456 789',
  president: 'Adel TEST', emailContact: 'contact@proprigo.fr', regimeTVA: 'franchise',
  iban: 'FR76 3000 6000 0112 3456 7890 189', bic: 'AGRIFRPP',
};

test('SASU : identité publique sans IBAN, facture avec capital et RCS', async () => {
  const app = createApp({ dbFile: ':memory:', adminPassword: 'admin-test-123', companyConfig: SASU });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.legal.formeJuridique, 'SASU');
    assert.equal(cfg.legal.capital, '1 000 €');
    assert.equal(cfg.legal.president, 'Adel TEST');
    assert.equal(cfg.legal.iban, undefined, "l'IBAN n'est jamais public");
    assert.doesNotMatch(JSON.stringify(cfg), /FR76|AGRIFRPP/);
    const cid = app.db.prepare("SELECT id FROM users WHERE email = 'claire@proprigo.test'").get().id;
    const bid = Number(app.db.prepare(`INSERT INTO bookings (client_id, service, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, status, checklist)
      VALUES (?, 'menage', 3, '75011', '12 rue Test', '2026-11-20', '10:00', 0, 0, 108, 'IDF', 1, 'paye', 'terminee', '[]')`).run(cid).lastInsertRowid);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'claire@proprigo.test', password: 'demo-proprigo' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${base}/api/bookings/${bid}/receipt`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /PROPRIGO, SASU au capital de 1 000 €/);
    assert.match(html, /RCS Paris 123 456 789/);
    assert.match(html, /TVA non applicable, art\. 293 B du CGI/, 'une SASU peut rester en franchise sous 37 500 €');
  } finally { app.server.close(); }
});
