'use strict';
// v1.12.0 : version anglaise pour les visiteurs et les clients
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('anglais : dictionnaire client chargé, choix FR / EN, admin toujours en français', () => {
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const sandbox = { window: {}, document: { documentElement: {} } };
  vm.runInNewContext(i18n, sandbox);
  assert.ok(sandbox.window.PROPRIGO_I18N, 'le fichier se charge');
  const en = i18n.slice(i18n.indexOf('const EN = '), i18n.indexOf('const IDX'));
  for (const k of ['Mes réservations', 'Voir les créneaux', 'Réserver ce ménage', 'Signaler un problème', 'Ce qui a été fait']) assert.ok(en.includes(JSON.stringify(k)), k);
  assert.match(ui, /if \(me && me\.role === 'admin'\) return 'fr';/);
  assert.match(ui, /id="langToggle"/);
  assert.doesNotMatch(ui, /toLocaleDateString\('fr-FR'/, 'les dates suivent la langue choisie');
});
