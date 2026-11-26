'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const stripe = fs.readFileSync(path.join(__dirname, '..', 'src', 'stripe-pay.js'), 'utf8');
test('les réservations annulées et terminées sont dans l historique', () => {
  assert.match(ui, /const isHistory = \(b\) => \['annulee', 'terminee'\]\.includes\(b\.status\)/);
  assert.match(ui, /visibleBookings\.filter\(isHistory\)\.map\(\(b\) => renderBooking\(b\)\)/);
});
test('une réservation annulée ne propose pas de paiement dans le client ou le serveur', () => {
  assert.match(ui, /active && b\.payment_status === 'en_attente_paiement'/);
  assert.match(server, /b\.status === 'annulee' \|\| b\.paid/);
  assert.match(stripe, /b\.status === 'annulee'/);
});
test('annulation : confirmation avec montant retenu et remboursement', () => {
  assert.match(ui, /Annuler ce ménage \?/);
  assert.match(ui, /sont retenus/);
  assert.match(ui, /vous serez remboursé de|Vous serez remboursé de/);
  assert.match(ui, /if \(!confirm\(`/);
});
