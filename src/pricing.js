'use strict';
// Grille tarifaire Proprigo (prix TTC) — validée dans le tableau « Proprigo – prix et rentabilité ».
// Une seule grille pour la France, l'Île-de-France un peu plus chère.

const IDF_DEPTS = ['75', '77', '78', '91', '92', '93', '94', '95'];
const OPEN_ZONES = ['IDF']; // zones où l'on peut réserver aujourd'hui

const GRID = {
  IDF: { menage: 37, grand: 42, bureau: 42, airbnb: { studio: 95, T2: 119, T3: 145, maison: 195 } },
  FR: { menage: 34, grand: 38, bureau: 39, airbnb: { studio: 89, T2: 115, T3: 139, maison: 185 } },
};
const AIRBNB_HOURS = { studio: 2, T2: 2.5, T3: 3, maison: 4 };
const SIZE_LABEL = { studio: 'Studio', T2: 'T2', T3: 'T3', maison: 'Maison' };
const SUNDAY_RATE = 0.20;
const URGENT_RATE = 0.25;
const KIT_PRICE = 15;
const SERVICES = ['menage', 'grand', 'airbnb', 'bureau'];
const PRO_SERVICES = ['airbnb', 'bureau']; // facturés à des professionnels : TVA à 20 %, pas de crédit d'impôt
const MIN_HOURS = 2;
const MAX_HOURS = 8;

// Jours fériés en France métropolitaine, calculés pour n'importe quelle année
// (dates fixes + lundi de Pâques, Ascension, lundi de Pentecôte).
function easterSunday(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
const holidayCache = new Map();
function holidays(y) {
  if (!holidayCache.has(y)) {
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    const e = easterSunday(y);
    const set = new Set(['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].map((md) => `${y}-${md}`));
    for (const plus of [1, 39, 50]) set.add(iso(e + plus * 864e5));
    holidayCache.set(y, set);
  }
  return holidayCache.get(y);
}

// Hypothèses de coût : fichier config/couts.json (modifiable sans toucher au code).
const DEFAULT_COSTS = {
  salarieeParHeureFacturee: 21.09, tvaParticulier: 0.10, tvaPro: 0.20, paiementPct: 0.015,
  paiementFixe: 0.25, produits: 2, kitCout: 4.5, linge: { studio: 8, T2: 12, T3: 15, maison: 22 },
};
function loadCosts() {
  try {
    const f = require('node:path').join(__dirname, '..', 'config', 'couts.json');
    const c = JSON.parse(require('node:fs').readFileSync(f, 'utf8'));
    return { ...DEFAULT_COSTS, ...c, linge: { ...DEFAULT_COSTS.linge, ...(c.linge || {}) } };
  } catch {
    return DEFAULT_COSTS;
  }
}
const COSTS = loadCosts();
const URGENT_WINDOW_MIN = 180;

function zoneOf(cp) {
  if (typeof cp !== 'string' || !/^\d{5}$/.test(cp)) return null;
  return IDF_DEPTS.includes(cp.slice(0, 2)) ? 'IDF' : 'FR';
}

function isOpen(zone) {
  return OPEN_ZONES.includes(zone);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isSundayOrHoliday(date) {
  return new Date(date + 'T12:00:00Z').getUTCDay() === 0 || holidays(Number(date.slice(0, 4))).has(date);
}

function nowParisMinutes(now = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
  return h * 60 + m;
}

function todayParis(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(now);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Calcule le prix d'une prestation. Toujours appelé côté serveur : le prix envoyé
 * par le navigateur n'est jamais utilisé.
 * input: { service: 'menage'|'grand'|'airbnb'|'bureau', size?, hours?, cp, date, urgent?, kit? }
 * Les bureaux sont une prestation aux entreprises : TVA à 20 %, pas de crédit d'impôt.
 */
function quote(input, now = new Date()) {
  const errors = [];
  const service = input.service;
  if (!SERVICES.includes(service)) errors.push('Prestation inconnue.');
  const zone = zoneOf(input.cp);
  if (!zone) errors.push('Code postal invalide (5 chiffres).');
  if (!isValidDate(input.date)) errors.push('Date invalide.');
  else if (input.date < todayParis(now)) errors.push('La date est déjà passée.');

  let hours = 0;
  let base = 0;
  let label = '';
  const g = GRID[zone || 'IDF'];
  if (service === 'airbnb') {
    if (!AIRBNB_HOURS[input.size]) errors.push('Taille de logement inconnue.');
    else {
      hours = AIRBNB_HOURS[input.size];
      base = g.airbnb[input.size];
      label = `Forfait Airbnb ${SIZE_LABEL[input.size]} (ménage + linge)`;
    }
  } else if (service === 'menage' || service === 'grand' || service === 'bureau') {
    hours = Number(input.hours);
    if (!Number.isInteger(hours * 2) || hours < MIN_HOURS || hours > MAX_HOURS) {
      errors.push(`Durée entre ${MIN_HOURS} h et ${MAX_HOURS} h, par demi-heure.`);
    } else {
      const rate = g[service];
      base = hours * rate;
      label = `${{ grand: 'Grand nettoyage', bureau: 'Nettoyage de bureaux' }[service] || 'Ménage'} ${String(hours).replace('.', ',')} h × ${rate} €`;
    }
  }

  const lines = [];
  let total = 0;
  if (!errors.length) {
    lines.push({ label, amount: round2(base) });
    let rate = 0;
    if (isSundayOrHoliday(input.date)) {
      rate += SUNDAY_RATE;
      lines.push({ label: 'Dimanche ou jour férié', amount: round2(base * SUNDAY_RATE) });
    }
    if (input.urgent) {
      const t = typeof input.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ? Number(input.time.slice(0, 2)) * 60 + Number(input.time.slice(3)) : null;
      const n = nowParisMinutes(now);
      if (input.date !== todayParis(now)) errors.push("L'urgence n'est possible que pour aujourd'hui.");
      else if (t === null) errors.push("Choisissez l'heure d'arrivée pour une urgence.");
      else if (t < n || t > n + URGENT_WINDOW_MIN) errors.push("Le supplément urgence s'applique à une arrivée dans les 3 prochaines heures. Pour une heure plus tardive, décochez « Urgence ».");
      else {
        rate += URGENT_RATE;
        lines.push({ label: 'Urgence (moins de 3 h)', amount: round2(base * URGENT_RATE) });
      }
    }
    total = Math.round(base * (1 + rate));
    if (input.kit) {
      if (service === 'airbnb') errors.push("L'option matériel n'existe pas pour Airbnb : le matériel reste dans le logement.");
      else {
        total += KIT_PRICE;
        lines.push({ label: 'Matériel et produits fournis', amount: KIT_PRICE });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    zone,
    open: zone ? isOpen(zone) : false,
    service,
    size: service === 'airbnb' ? input.size : null,
    hours,
    lines,
    total,
    pro: PRO_SERVICES.includes(service),
  };
}

/** Marge estimée d'une réservation, avec les mêmes formules que le tableau. */
function estimateMargin(b, worker) {
  const tva = PRO_SERVICES.includes(b.service) ? COSTS.tvaPro : COSTS.tvaParticulier;
  const ht = b.total / (1 + tva);
  const frais = b.total * COSTS.paiementPct + COSTS.paiementFixe + (b.kit ? COSTS.kitCout : COSTS.produits);
  const hourCost = worker && worker.statut === 'I' && worker.rate ? worker.rate : COSTS.salarieeParHeureFacturee;
  const linge = b.service === 'airbnb' ? COSTS.linge[b.size] || 0 : 0;
  return { ht: round2(ht), marge: round2(ht - frais - hourCost * b.hours - linge) };
}

module.exports = {
  SERVICES, PRO_SERVICES,
  GRID, AIRBNB_HOURS, SIZE_LABEL, IDF_DEPTS, OPEN_ZONES, KIT_PRICE, COSTS,
  zoneOf, isOpen, quote, estimateMargin, todayParis, isValidDate, holidays, nowParisMinutes,
};
