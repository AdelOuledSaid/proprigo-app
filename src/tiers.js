'use strict';
// Niveaux des intervenantes : Bleu (au départ), Or, Platine.
// On monte avec le nombre de ménages terminés ET la note moyenne de tous les avis :
// une seule mauvaise note ne suffit jamais à faire perdre un niveau.
// Avantages : badge visible des clients, bonus en € de l'heure, priorité sur les missions à distance comparable.

const DEFAULTS = Object.freeze({
  or: { missions: 25, rating: 4.6, bonus: 0 }, // Or : priorité sur les missions
  platine: { missions: 75, rating: 4.8, bonus: 1 }, // Platine : priorité + 1 € de l'heure
});
const MIN_RATINGS = 5; // en dessous, la note n'est pas encore représentative
const PRIORITY_KM = 3; // à distance comparable : 3 km d'avance pour l'Or, 6 km pour le Platine
const LABELS = { bleu: 'Bleu', or: 'Or', platine: 'Platine' };
const ICONS = { bleu: '🔵', or: '🥇', platine: '💎' };

const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : dflt; };

function settings(db) {
  let raw = {};
  try { const r = db.prepare("SELECT value FROM settings WHERE key = 'tiers'").get(); if (r) raw = JSON.parse(r.value); } catch { raw = {}; }
  const pick = (k) => ({
    missions: Math.round(num(raw[k] && raw[k].missions, 1, 10000, DEFAULTS[k].missions)),
    rating: num(raw[k] && raw[k].rating, 1, 5, DEFAULTS[k].rating),
    bonus: num(raw[k] && raw[k].bonus, 0, 20, DEFAULTS[k].bonus),
  });
  return { or: pick('or'), platine: pick('platine') };
}

/** Valide et normalise des réglages envoyés par l'admin (le Platine doit être au moins aussi exigeant que l'Or). */
function clean(input) {
  const out = {};
  for (const k of ['or', 'platine']) {
    const v = input && input[k] ? input[k] : {};
    const missions = Math.round(Number(v.missions)); const rating = Number(v.rating); const bonus = Number(v.bonus);
    if (!(missions >= 1 && missions <= 10000)) throw new Error(`Nombre de ménages invalide pour le niveau ${LABELS[k]}.`);
    if (!(rating >= 1 && rating <= 5)) throw new Error(`Note invalide pour le niveau ${LABELS[k]} (entre 1 et 5).`);
    if (!(bonus >= 0 && bonus <= 20)) throw new Error(`Bonus invalide pour le niveau ${LABELS[k]} (entre 0 et 20 € de l'heure).`);
    out[k] = { missions, rating: Math.round(rating * 10) / 10, bonus: Math.round(bonus * 100) / 100 };
  }
  if (out.platine.missions < out.or.missions || out.platine.rating < out.or.rating) throw new Error('Le niveau Platine doit demander au moins autant que le niveau Or.');
  return out;
}

function stats(db, workerId) {
  const r = db.prepare("SELECT COUNT(*) AS n, COUNT(rating) AS rated, COALESCE(SUM(rating), 0) AS sum, MIN(rating) AS worst FROM bookings WHERE worker_id = ? AND status = 'terminee'").get(workerId);
  // la plus mauvaise note est mise de côté dès qu'il y a assez d'avis : un client difficile ne fait pas perdre un niveau
  const forgive = r.rated > MIN_RATINGS;
  const count = forgive ? r.rated - 1 : r.rated;
  const sum = forgive ? r.sum - r.worst : r.sum;
  let absences = 0;
  try { absences = db.prepare("SELECT COUNT(*) AS n FROM worker_absences WHERE worker_id = ? AND created_at >= datetime('now', '-6 months')").get(workerId).n; } catch { absences = 0; }
  return { missions: r.n, rated: r.rated, rating: count ? Math.round((sum / count) * 100) / 100 : null, absences };
}

function reaches(st, t, key) {
  if (key === 'platine' && st.absences > 0) return false; // Platine : aucune absence non prévenue sur 6 mois
  return st.missions >= t.missions && st.rated >= MIN_RATINGS && st.rating >= t.rating;
}

function tierOf(db, workerId, cfg = settings(db)) {
  const st = stats(db, workerId);
  const key = reaches(st, cfg.platine, 'platine') ? 'platine' : reaches(st, cfg.or, 'or') ? 'or' : 'bleu';
  const rank = { bleu: 0, or: 1, platine: 2 }[key];
  const nextKey = key === 'bleu' ? 'or' : key === 'or' ? 'platine' : null;
  const next = nextKey ? {
    key: nextKey, label: LABELS[nextKey], icon: ICONS[nextKey],
    missions: cfg[nextKey].missions, rating: cfg[nextKey].rating, minRatings: MIN_RATINGS, bonus: cfg[nextKey].bonus,
    missionsLeft: Math.max(0, cfg[nextKey].missions - st.missions),
  } : null;
  return { key, label: LABELS[key], icon: ICONS[key], rank, bonus: key === 'bleu' ? 0 : cfg[key].bonus, ...st, next };
}

/** Rang de priorité pour l'attribution (0, 1 ou 2), sans recalculer les réglages pour chaque intervenante. */
function rankFor(db, workerId, cfg) {
  return tierOf(db, workerId, cfg).rank;
}

module.exports = { DEFAULTS, MIN_RATINGS, PRIORITY_KM, LABELS, ICONS, settings, clean, stats, tierOf, rankFor };
