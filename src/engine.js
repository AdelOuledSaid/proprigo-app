'use strict';
// Attribution des missions.
// 1. Salariée active, disponible, la plus proche : la mission lui est attribuée.
// 2. Sinon, proposition aux 3 indépendantes les plus proches : libres d'accepter ou de refuser,
//    la première qui accepte prend la mission.
// 3. Sinon, la mission reste « en attente » et l'équipe est alertée.
const { STEPS, log } = require('./db');
const logEvent = log;
const mailer = require('./mailer');

const MAX_PER_DAY = 3;
const MAX_DISTANCE = 25; // en km : au-delà, pas le même secteur
const TRAVEL_MIN = 30; // temps de trajet minimum entre deux missions
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// Centres approximatifs des arrondissements de Paris et des départements d'Île-de-France.
const PARIS = {
  1: [48.862, 2.336], 2: [48.868, 2.343], 3: [48.863, 2.360], 4: [48.854, 2.357], 5: [48.845, 2.350],
  6: [48.849, 2.333], 7: [48.856, 2.312], 8: [48.873, 2.312], 9: [48.877, 2.338], 10: [48.876, 2.361],
  11: [48.859, 2.380], 12: [48.840, 2.388], 13: [48.828, 2.362], 14: [48.829, 2.327], 15: [48.840, 2.293],
  16: [48.863, 2.276], 17: [48.887, 2.307], 18: [48.893, 2.348], 19: [48.887, 2.385], 20: [48.863, 2.401],
};
const DEPTS = { 92: [48.84, 2.24], 93: [48.91, 2.45], 94: [48.78, 2.45], 77: [48.62, 2.98], 78: [48.80, 1.95], 91: [48.52, 2.24], 95: [49.05, 2.15] };
function centre(cp) {
  const d = Number(cp.slice(0, 2));
  if (d === 75) return PARIS[Number(cp.slice(3))] || PARIS[1];
  return DEPTS[d] || null;
}

/** Distance approximative en kilomètres entre deux codes postaux (999 = hors secteur). */
function distance(a, b) {
  if (a === b) return 0;
  const p = centre(a);
  const q = centre(b);
  if (!p || !q) return a.slice(0, 2) === b.slice(0, 2) ? 5 : 999;
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(q[0] - p[0]) / 2) ** 2 + Math.cos(rad(p[0])) * Math.cos(rad(q[0])) * Math.sin(rad(q[1] - p[1]) / 2) ** 2;
  return Math.max(1, Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10);
}

/** Temps de trajet entre deux missions : 30 min minimum, environ 4 min par km en transports en commun. */
function travelMinutes(a, b) {
  if (!a || !b) return TRAVEL_MIN;
  const d = distance(a, b);
  return d >= 999 ? 120 : Math.max(TRAVEL_MIN, Math.round(15 + 4 * d));
}

function isActive(w) {
  return w.step === STEPS[w.statut].length - 1;
}

function candidates(db, booking, { withRefused = false } = {}) {
  const refused = new Set(db.prepare("SELECT worker_id FROM offers WHERE booking_id = ? AND state = 'refused'").all(booking.id).map((r) => r.worker_id));
  const workers = db.prepare('SELECT w.*, u.name FROM workers w JOIN users u ON u.id = w.user_id WHERE w.absent = 0').all();
  // missions du jour : confirmées, et aussi celles qu'on lui propose déjà (une indépendante ne peut pas en accepter deux en même temps)
  const sameDay = db.prepare(`SELECT time, hours, cp FROM bookings WHERE date = ? AND id != ? AND (
      (worker_id = ? AND status IN ('attribuee','en_cours'))
      OR (status = 'proposee' AND id IN (SELECT booking_id FROM offers WHERE worker_id = ? AND state = 'offered')))`);
  const weekday = new Date(booking.date + 'T12:00:00Z').getUTCDay();
  const slot = db.prepare('SELECT start, end FROM availability WHERE worker_id = ? AND weekday = ?');
  const off = db.prepare('SELECT 1 FROM timeoff WHERE worker_id = ? AND start_date <= ? AND end_date >= ?');
  // la mission doit tenir dans ses horaires du jour, hors congés
  const isAvailable = (w) => {
    const a = slot.get(w.user_id, weekday);
    if (!a || off.get(w.user_id, booking.date, booking.date)) return false;
    return toMin(a.start) <= toMin(booking.time) && toMin(booking.time) + booking.hours * 60 <= toMin(a.end);
  };
  const start = toMin(booking.time);
  const end = start + booking.hours * 60;
  // libre si elle a moins de 3 missions ce jour-là et aucune qui chevauche celle-ci (trajet compris)
  const isFree = (w) => {
    const day = sameDay.all(booking.date, booking.id, w.user_id, w.user_id);
    if (day.length >= MAX_PER_DAY) return false;
    return day.every((o) => {
      const os = toMin(o.time);
      const oe = os + o.hours * 60;
      const gap = travelMinutes(o.cp, booking.cp);
      return end + gap <= os || oe + gap <= start;
    });
  };
  return workers
    .filter((w) => isActive(w) && (withRefused || !refused.has(w.user_id)))
    .map((w) => ({ ...w, refused: refused.has(w.user_id) }))
    .filter(isAvailable)
    .filter(isFree)
    .map((w) => ({ ...w, d: distance(w.cp, booking.cp) }))
    .filter((w) => w.d < MAX_DISTANCE)
    .sort((x, y) => x.d - y.d);
}

function assign(db, bookingId) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b) throw new Error('Réservation introuvable');
  if (b.payment_status === 'en_attente_paiement' || b.payment_status === 'paiement_echoue') return { status: 'en_attente', payment_pending: true };
  db.prepare("DELETE FROM offers WHERE booking_id = ? AND state = 'offered'").run(b.id);
  const r = pickAndAssign(db, b);
  // même intervenante qu'avant : rien n'a changé, on ne prévient personne une seconde fois
  if (r.status === 'attribuee' && b.status === 'attribuee' && r.worker === b.worker_id) return r;
  guarantee(db, b, r);
  tellWorkers(db, b.id, r);
  return r;
}

/** Intervenantes préférées, dans l'ordre : celle de la récurrence, celle du logement, la préférée du client. */
function preferredIds(db, b) {
  const ids = [];
  const series = b.series_id ? db.prepare('SELECT worker_id FROM series WHERE id = ?').get(b.series_id) : null;
  if (series && series.worker_id) ids.push(series.worker_id);
  const home = b.home_id ? db.prepare('SELECT preferred_worker_id FROM homes WHERE id = ?').get(b.home_id) : null;
  if (home && home.preferred_worker_id) ids.push(home.preferred_worker_id);
  const fav = db.prepare('SELECT worker_id FROM favorites WHERE client_id = ?').get(b.client_id);
  if (fav) ids.push(fav.worker_id);
  return ids;
}

function pickAndAssign(db, b) {
  const list = candidates(db, b);
  const unchanged = (wid) => b.status === 'attribuee' && b.worker_id === wid;
  const log = (d, text) => { if (!/attribuée à/.test(text) || !unchanged(lastPick)) logEvent(d, text); };
  let lastPick = null;
  // on garde l'intervenante habituelle ou préférée si elle est libre
  const usual = preferredIds(db, b).map((id) => list.find((w) => w.user_id === id)).find(Boolean);
  if (usual && usual.statut === 'S') {
    lastPick = usual.user_id;
    db.prepare("UPDATE bookings SET worker_id = ?, status = 'attribuee' WHERE id = ?").run(usual.user_id, b.id);
    rememberWorker(db, b, usual.user_id);
    log(db, `Réservation n° ${b.id} : attribuée à ${usual.name}, intervenante habituelle ou préférée du client.`);
    return { status: 'attribuee', worker: usual.user_id };
  }
  if (usual) {
    db.prepare("INSERT OR REPLACE INTO offers (booking_id, worker_id, state) VALUES (?, ?, 'offered')").run(b.id, usual.user_id);
    db.prepare("UPDATE bookings SET worker_id = NULL, status = 'proposee' WHERE id = ?").run(b.id);
    log(db, `Réservation n° ${b.id} : proposée d'abord à ${usual.name}, intervenante habituelle ou préférée (libre de refuser).`);
    return { status: 'proposee', offers: [usual.user_id] };
  }
  const sal = list.find((w) => w.statut === 'S');
  if (sal) {
    lastPick = sal.user_id;
    db.prepare("UPDATE bookings SET worker_id = ?, status = 'attribuee' WHERE id = ?").run(sal.user_id, b.id);
    rememberWorker(db, b, sal.user_id);
    log(db, `Réservation n° ${b.id} : attribuée à ${sal.name}, salariée disponible la plus proche (${sal.cp}).`);
    return { status: 'attribuee', worker: sal.user_id };
  }
  const ind = list.filter((w) => w.statut === 'I').slice(0, 3);
  if (ind.length) {
    const ins = db.prepare("INSERT OR REPLACE INTO offers (booking_id, worker_id, state) VALUES (?, ?, 'offered')");
    for (const w of ind) ins.run(b.id, w.user_id);
    db.prepare("UPDATE bookings SET worker_id = NULL, status = 'proposee' WHERE id = ?").run(b.id);
    log(db, `Réservation n° ${b.id} : aucune salariée libre, proposée à ${ind.map((w) => w.name).join(', ')}.`);
    return { status: 'proposee', offers: ind.map((w) => w.user_id) };
  }
  db.prepare("UPDATE bookings SET worker_id = NULL, status = 'en_attente' WHERE id = ?").run(b.id);
  log(db, `Réservation n° ${b.id} : personne de disponible dans le secteur, à traiter par l'équipe.`);
  return { status: 'en_attente' };
}

function accept(db, bookingId, workerId) {
  const offer = db.prepare("SELECT * FROM offers WHERE booking_id = ? AND worker_id = ? AND state = 'offered'").get(bookingId, workerId);
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!offer || !b || b.status !== 'proposee') return false;
  // elle a pu accepter entre-temps une mission qui tombe à la même heure
  if (!candidates(db, b, { withRefused: true }).some((w) => w.user_id === workerId)) return 'occupee';
  db.prepare("UPDATE bookings SET worker_id = ?, status = 'attribuee' WHERE id = ?").run(workerId, bookingId);
  db.prepare("DELETE FROM offers WHERE booking_id = ? AND state = 'offered'").run(bookingId);
  rememberWorker(db, b, workerId);
  if (db.prepare("SELECT 1 FROM messages WHERE booking_id = ? AND text LIKE '%viendra à sa place%'").get(bookingId)) {
    notify(db, bookingId, `Votre ménage sera fait par ${firstName(db, workerId)}, intervenante vérifiée Proprigo.`);
  }
  return true;
}

function refuse(db, bookingId, workerId) {
  const r = db.prepare("UPDATE offers SET state = 'refused' WHERE booking_id = ? AND worker_id = ? AND state = 'offered'").run(bookingId, workerId);
  if (!r.changes) return false;
  const left = db.prepare("SELECT COUNT(*) AS n FROM offers WHERE booking_id = ? AND state = 'offered'").get(bookingId).n;
  if (!left) assign(db, bookingId);
  return true;
}

const firstName = (db, id) => {
  const u = id && db.prepare('SELECT name FROM users WHERE id = ?').get(id);
  return u ? u.name.split(' ')[0] : null;
};

/** Message de l'équipe dans la conversation de la réservation (visible par le client). */
function notify(db, bookingId, text) {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (admin) db.prepare('INSERT INTO messages (booking_id, sender_id, text) VALUES (?, ?, ?)').run(bookingId, admin.id, text);
  const c = db.prepare('SELECT u.email, b.date, b.time FROM bookings b JOIN users u ON u.id = b.client_id WHERE b.id = ?').get(bookingId);
  if (c) mailer.send(c.email, `Votre ménage du ${frDate(c.date)} à ${c.time}`, 'Information sur votre ménage', [text], { label: 'Voir ma réservation', path: '/#/mes-reservations' });
}

const frDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Prévient l'intervenante d'une nouvelle mission ou d'une nouvelle proposition. */
function tellWorkers(db, bookingId, r) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  const ids = r.status === 'attribuee' ? [r.worker] : r.status === 'proposee' ? r.offers || [] : [];
  for (const id of ids) {
    const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(id);
    if (!u) continue;
    mailer.send(u.email, r.status === 'attribuee' ? `Nouvelle mission le ${frDate(b.date)}` : `Nouvelle proposition de mission le ${frDate(b.date)}`,
      r.status === 'attribuee' ? 'Une nouvelle mission vous est attribuée' : 'Une mission vous est proposée',
      [`${frDate(b.date)} à ${b.time}, code postal ${b.cp}, ${b.hours} h.`, r.status === 'attribuee' ? "L'adresse et les consignes sont dans votre espace." : "Vous êtes libre d'accepter ou de refuser. La première intervenante qui accepte prend la mission."],
      { label: 'Voir mes missions', path: '/#/intervenante' });
  }
}

/** Garantie de remplacement : si l'intervenante prévue change, le client est prévenu. */
function guarantee(db, before, result) {
  if (!before.worker_id) return;
  const after = db.prepare('SELECT worker_id, status FROM bookings WHERE id = ?').get(before.id);
  if (after.worker_id === before.worker_id) return;
  const old = firstName(db, before.worker_id);
  if (after.worker_id && after.worker_id === preferredIds(db, before)[0]) {
    notify(db, before.id, `${firstName(db, after.worker_id)}, votre intervenante préférée, fera ce ménage.`);
    return;
  }
  const text = after.worker_id
    ? `${old} n'est pas disponible pour ce ménage. ${firstName(db, after.worker_id)}, intervenante vérifiée Proprigo, viendra à sa place. Vous préférez garder ${old} ? Choisissez un autre créneau depuis « Mes réservations ».`
    : `${old} n'est pas disponible pour ce ménage. Une autre intervenante vérifiée Proprigo viendra à sa place. Vous préférez garder ${old} ? Choisissez un autre créneau depuis « Mes réservations ».`;
  notify(db, before.id, text);
  log(db, `Réservation n° ${before.id} : client prévenu du changement d'intervenante.`);
}

/** Une réservation récurrente retient la première intervenante qui la prend. */
function rememberWorker(db, booking, workerId) {
  if (booking.series_id) db.prepare('UPDATE series SET worker_id = COALESCE(worker_id, ?) WHERE id = ?').run(workerId, booking.series_id);
}

/** Heures d'une journée où une intervenante précise est libre pour ce ménage. */
function slotsFor(db, workerId, { id = -1, date, cp, hours }) {
  const out = [];
  for (let m = 7 * 60; m + hours * 60 <= 20 * 60; m += 30) {
    const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 ? '30' : '00'}`;
    if (candidates(db, { id, date, cp, time, hours }).some((w) => w.user_id === workerId)) out.push(time);
  }
  return out;
}

/** Heures de la journée (toutes les 30 min) où au moins une intervenante peut venir. */
function freeSlots(db, { date, cp, hours }) {
  const out = [];
  for (let m = 7 * 60; m + hours * 60 <= 20 * 60; m += 30) {
    const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 ? '30' : '00'}`;
    if (candidates(db, { id: -1, date, cp, time, hours }).length) out.push(time);
  }
  return out;
}

function proximity(d) {
  return d === 0 ? 'même code postal' : `environ ${Math.round(d)} km`;
}

/** Attribution choisie par l'équipe : une salariée reçoit la mission, une indépendante la reçoit en proposition. */
function assignTo(db, bookingId, workerId) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b || !['en_attente', 'proposee', 'attribuee'].includes(b.status)) return { error: 'Réservation non modifiable.' };
  if (b.payment_status === 'en_attente_paiement' || b.payment_status === 'paiement_echoue') return { error: 'Paiement requis avant attribution.' };
  const w = candidates(db, b, { withRefused: true }).find((x) => x.user_id === workerId);
  if (!w) return { error: "Cette intervenante n'est pas disponible à cette heure-là." };
  db.prepare("DELETE FROM offers WHERE booking_id = ? AND state = 'offered'").run(b.id);
  if (w.statut === 'S') {
    db.prepare("UPDATE bookings SET worker_id = ?, status = 'attribuee' WHERE id = ?").run(w.user_id, b.id);
    guarantee(db, b, { status: 'attribuee' });
    log(db, `Réservation n° ${b.id} : attribuée à ${w.name} par l'équipe.`);
    return { status: 'attribuee', message: `${w.name} reçoit la réservation n° ${b.id}.` };
  }
  db.prepare("INSERT OR REPLACE INTO offers (booking_id, worker_id, state) VALUES (?, ?, 'offered')").run(b.id, w.user_id);
  db.prepare("UPDATE bookings SET worker_id = NULL, status = 'proposee' WHERE id = ?").run(b.id);
  guarantee(db, b, { status: 'proposee' });
  log(db, `Réservation n° ${b.id} : proposée à ${w.name} par l'équipe (indépendante, libre de refuser).`);
  return { status: 'proposee', message: `Réservation n° ${b.id} proposée à ${w.name} : elle doit l'accepter.` };
}

/** Relance l'attribution des réservations sans intervenante (après une activation ou un retour d'absence). */
function retryPending(db) {
  const ids = db.prepare("SELECT id FROM bookings WHERE status = 'en_attente'").all().map((r) => r.id);
  for (const id of ids) assign(db, id);
  return ids.length;
}

module.exports = {
  travelMinutes, frDate, tellWorkers, notify, preferredIds, slotsFor, firstName, freeSlots, toMin, assign, assignTo, retryPending, accept, refuse, candidates, proximity, distance, isActive, MAX_PER_DAY };
