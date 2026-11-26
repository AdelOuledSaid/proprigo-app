'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const tiers = require('../src/tiers');

// base minimale pour tester le calcul des niveaux sans serveur
function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by INTEGER);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, worker_id INTEGER, status TEXT, rating INTEGER);`);
  return db;
}
const add = (db, wid, n, rating = null, status = 'terminee') => { for (let i = 0; i < n; i++) db.prepare('INSERT INTO bookings (worker_id, status, rating) VALUES (?, ?, ?)').run(wid, status, rating); };

test('niveaux : Bleu, Or (priorité, sans argent), Platine (+1 €/h)', () => {
  const db = base();
  assert.equal(tiers.tierOf(db, 1).key, 'bleu');
  add(db, 1, 24, 5);
  assert.equal(tiers.tierOf(db, 1).key, 'bleu', '24 ménages : pas encore Or');
  assert.equal(tiers.tierOf(db, 1).next.missionsLeft, 1);
  add(db, 1, 1, 5);
  const or = tiers.tierOf(db, 1);
  assert.equal(or.key, 'or');
  assert.equal(or.bonus, 0, 'Or : priorité seulement');
  assert.equal(or.rank, 1);
  add(db, 1, 50, 5);
  const pl = tiers.tierOf(db, 1);
  assert.equal(pl.key, 'platine');
  assert.equal(pl.bonus, 1);
  assert.equal(pl.next, null);
});

test('niveaux : une mauvaise note isolée ne fait pas redescendre, la note compte à partir de 5 avis', () => {
  const db = base();
  add(db, 2, 30); // 30 ménages sans avis
  assert.equal(tiers.tierOf(db, 2).key, 'bleu', 'pas assez d\'avis');
  add(db, 2, 5, 5);
  assert.equal(tiers.tierOf(db, 2).key, 'or');
  add(db, 2, 1, 1); // une très mauvaise note
  assert.equal(tiers.tierOf(db, 2).key, 'or', 'la plus mauvaise note est mise de côté');
  add(db, 2, 1, 1); // une deuxième très mauvaise note : elle compte
  assert.equal(tiers.tierOf(db, 2).key, 'bleu');
});

test('niveaux : réglages validés, le Platine au moins aussi exigeant que l\'Or', () => {
  assert.throws(() => tiers.clean({ or: { missions: 50, rating: 4.6, bonus: 0 }, platine: { missions: 10, rating: 4.8, bonus: 1 } }), /Platine/);
  assert.throws(() => tiers.clean({ or: { missions: 5, rating: 7, bonus: 0 }, platine: { missions: 10, rating: 4.8, bonus: 1 } }), /Note invalide/);
  const v = tiers.clean({ or: { missions: '10', rating: '4.55', bonus: '0' }, platine: { missions: 40, rating: 4.8, bonus: 1.5 } });
  assert.deepEqual(v.or, { missions: 10, rating: 4.6, bonus: 0 });
});
