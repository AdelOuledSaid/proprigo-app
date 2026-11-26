'use strict';
// Grille tarifaire Proprigo (prix TTC) — validée dans le tableau « Proprigo – prix et rentabilité ».
// Une seule grille pour la France, l'Île-de-France un peu plus chère.

const IDF_DEPTS = ['75', '77', '78', '91', '92', '93', '94', '95'];
const OPEN_ZONES = ['IDF']; // (ancien réglage, gardé pour compatibilité) : voir OPEN_DEPTS
// Départements où l'on peut réserver aujourd'hui. Modifiable depuis l'admin (Tarifs et zones).
const OPEN_DEPTS = [...IDF_DEPTS];

const GRID = {
  IDF: { menage: 36, grand: 44, bureau: 43.2, airbnb: { studio: 99, T2: 125, T3: 152, maison: 205 } },
  FR: { menage: 34, grand: 40, bureau: 40.8, airbnb: { studio: 93, T2: 121, T3: 146, maison: 195 } },
};
const AIRBNB_HOURS = { studio: 2, T2: 2.5, T3: 3, maison: 4 };
const SIZE_LABEL = { studio: 'Studio', T2: 'T2', T3: 'T3', maison: 'Maison' };
// Suppléments et remises : modifiables depuis l'admin. Les objets sont modifiés sur place,
// pour que tout le code qui les lit voie les nouvelles valeurs.
const RATES = { sunday: 0.20, urgent: 0.25, kit: 15, subscription: 0.10 };
const SERVICES = ['menage', 'grand', 'airbnb', 'bureau'];
// Options d'un ménage à domicile ou d'un grand nettoyage : du temps en plus, au tarif de l'heure.
const EXTRAS = {
  repassage: { label: 'Repassage', hours: 1, task: 'Repassage du linge propre (environ 1 h)' },
  vitres: { label: 'Vitres intérieures', hours: 1, task: 'Vitres intérieures accessibles' },
  four: { label: 'Intérieur du four', hours: 0.5, task: 'Intérieur du four' },
  frigo: { label: 'Intérieur du réfrigérateur', hours: 0.5, task: 'Intérieur du réfrigérateur (vidé avant le passage)' },
  draps: { label: 'Changement des draps', hours: 0.5, task: 'Changer les draps et faire les lits' },
};
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
  return OPEN_DEPTS.some((d) => (IDF_DEPTS.includes(d) ? 'IDF' : 'FR') === zone);
}
function isOpenCp(cp) {
  return Boolean(zoneOf(cp)) && OPEN_DEPTS.includes(cp.slice(0, 2));
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
  const extras = [];
  const extraLines = [];
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
      if (service !== 'bureau') {
        for (const k of [...new Set(Array.isArray(input.extras) ? input.extras : [])]) {
          if (!EXTRAS[k]) continue;
          extras.push(k);
          extraLines.push({ label: `Option : ${EXTRAS[k].label} (+${String(EXTRAS[k].hours).replace('.', ',')} h)`, amount: round2(EXTRAS[k].hours * rate) });
          hours += EXTRAS[k].hours;
          base += EXTRAS[k].hours * rate;
        }
      }
    }
  }

  const lines = [];
  let total = 0;
  if (!errors.length) {
    lines.push({ label, amount: round2(base - extraLines.reduce((t, l) => t + l.amount, 0)) }, ...extraLines);
    let rate = 0;
    if (isSundayOrHoliday(input.date)) {
      rate += RATES.sunday;
      lines.push({ label: 'Dimanche ou jour férié', amount: round2(base * RATES.sunday) });
    }
    if (input.urgent) {
      const t = typeof input.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ? Number(input.time.slice(0, 2)) * 60 + Number(input.time.slice(3)) : null;
      const n = nowParisMinutes(now);
      if (input.date !== todayParis(now)) errors.push("L'urgence n'est possible que pour aujourd'hui.");
      else if (t === null) errors.push("Choisissez l'heure d'arrivée pour une urgence.");
      else if (t < n || t > n + URGENT_WINDOW_MIN) errors.push("Le supplément urgence s'applique à une arrivée dans les 3 prochaines heures. Pour une heure plus tardive, décochez « Urgence ».");
      else {
        rate += RATES.urgent;
        lines.push({ label: 'Urgence (moins de 3 h)', amount: round2(base * RATES.urgent) });
      }
    }
    const subscription = (input.repeat === '7' || input.repeat === '14') && !input.urgent;
    // remise selon le volume, pour les comptes société et les prestations aux professionnels seulement ;
    // jamais cumulée avec l'abonnement (on garde la plus avantageuse), pour ne jamais travailler à perte
    const volume = PRO_SERVICES.includes(service) && [0.05, 0.1].includes(input.volume) ? input.volume : 0;
    if (volume && (!subscription || volume > RATES.subscription)) {
      rate -= volume;
      lines.push({ label: `Remise volume entreprise (−${Math.round(volume * 100)} %)`, amount: -round2(base * volume) });
    } else if (subscription) {
      rate -= RATES.subscription;
      lines.push({ label: `Abonnement ${input.repeat === '7' ? 'chaque semaine' : 'toutes les 2 semaines'} (−${Math.round(RATES.subscription * 100)} %)`, amount: -round2(base * RATES.subscription) });
    }
    total = Math.round(base * (1 + rate));
    if (input.kit) {
      if (service === 'airbnb') errors.push("L'option matériel n'existe pas pour Airbnb : le matériel reste dans le logement.");
      else {
        total += RATES.kit;
        lines.push({ label: 'Matériel et produits fournis', amount: RATES.kit });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    zone,
    open: zone ? isOpenCp(input.cp) : false,
    service,
    size: service === 'airbnb' ? input.size : null,
    hours,
    extras,
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

// ---- réglages modifiables depuis l'admin : grille, suppléments, départements ouverts
const clone = (o) => JSON.parse(JSON.stringify(o));
const DEFAULTS = Object.freeze(clone({ grid: GRID, sunday: RATES.sunday, urgent: RATES.urgent, kit: RATES.kit, subscription: RATES.subscription, openDepts: OPEN_DEPTS }));
function settings() {
  return clone({ grid: GRID, sunday: RATES.sunday, urgent: RATES.urgent, kit: RATES.kit, subscription: RATES.subscription, openDepts: OPEN_DEPTS });
}
const DEPT_RE = /^(0[1-9]|[1-8]\d|9[0-5]|97)$/;
/** Vérifie des réglages ; renvoie la liste des erreurs (vide si tout va bien). */
function validateSettings(st) {
  const errors = [];
  const num = (v, min, max, what) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errors.push(`${what} : entre ${min} et ${max}.`); };
  for (const z of ['IDF', 'FR']) {
    const g = st && st.grid && st.grid[z];
    if (!g) { errors.push(`Grille ${z} manquante.`); continue; }
    const where = z === 'IDF' ? 'Île-de-France' : 'hors Île-de-France';
    num(g.menage, 15, 150, `Ménage à domicile (${where}), prix de l'heure`);
    num(g.grand, 15, 150, `Grand nettoyage (${where}), prix de l'heure`);
    num(g.bureau, 15, 150, `Bureaux (${where}), prix TTC de l'heure`);
    for (const k of Object.keys(AIRBNB_HOURS)) num(g.airbnb && g.airbnb[k], 40, 600, `Airbnb ${SIZE_LABEL[k]} (${where})`);
  }
  num(st.sunday, 0, 1, 'Supplément dimanche et férié');
  num(st.urgent, 0, 1, 'Supplément urgence');
  num(st.subscription, 0, 0.3, 'Remise abonnement');
  num(st.kit, 0, 100, 'Matériel fourni');
  if (!Array.isArray(st.openDepts) || !st.openDepts.length) errors.push('Ouvrez au moins un département.');
  else for (const d of st.openDepts) if (!DEPT_RE.test(String(d))) errors.push(`Département « ${d} » inconnu (2 chiffres, ex. 75, 69).`);
  if (errors.length) return errors;
  // Jamais à perte : le prix HT de l'heure doit couvrir le coût d'une heure salariée.
  for (const z of ['IDF', 'FR']) {
    const g = st.grid[z];
    for (const svc of ['menage', 'grand', 'bureau']) {
      const ht = g[svc] / (1 + (PRO_SERVICES.includes(svc) ? COSTS.tvaPro : COSTS.tvaParticulier));
      if (ht * (1 - st.subscription) < COSTS.salarieeParHeureFacturee) errors.push(`${{ menage: 'Ménage', grand: 'Grand nettoyage', bureau: 'Bureaux' }[svc]} (${z === 'IDF' ? 'Île-de-France' : 'hors IDF'}) : ${g[svc]} € TTC ne couvre pas le coût d'une heure (${COSTS.salarieeParHeureFacturee} € HT), remise abonnement comprise.`);
    }
    for (const k of Object.keys(AIRBNB_HOURS)) {
      const margin = estimateMargin({ service: 'airbnb', size: k, total: g.airbnb[k], hours: AIRBNB_HOURS[k], kit: 0 });
      if (margin.marge < 0) errors.push(`Airbnb ${SIZE_LABEL[k]} (${z === 'IDF' ? 'Île-de-France' : 'hors IDF'}) : ${g.airbnb[k]} € donne une marge négative (${margin.marge} €).`);
    }
  }
  return errors;
}
/** Applique des réglages déjà vérifiés (sur place). */
function applySettings(st) {
  for (const z of ['IDF', 'FR']) {
    const g = st.grid[z];
    Object.assign(GRID[z], { menage: g.menage, grand: g.grand, bureau: g.bureau });
    Object.assign(GRID[z].airbnb, g.airbnb);
  }
  Object.assign(RATES, { sunday: st.sunday, urgent: st.urgent, kit: st.kit, subscription: st.subscription });
  OPEN_DEPTS.splice(0, OPEN_DEPTS.length, ...[...new Set(st.openDepts.map(String))].sort());
}
/** Prix affichés sur le site (accueil, pages de services). */
function publicPrices() {
  const g = GRID.IDF;
  return { menage: g.menage, grand: g.grand, bureau: g.bureau, bureauHT: Math.round((g.bureau / (1 + COSTS.tvaPro)) * 100) / 100, airbnb: { ...g.airbnb },
    kit: RATES.kit, sunday: RATES.sunday, urgent: RATES.urgent, subscription: RATES.subscription };
}

module.exports = {
  SERVICES, PRO_SERVICES, EXTRAS, RATES,
  GRID, AIRBNB_HOURS, SIZE_LABEL, IDF_DEPTS, OPEN_ZONES, OPEN_DEPTS, COSTS,
  get KIT_PRICE() { return RATES.kit; }, get SUBSCRIPTION_RATE() { return RATES.subscription; },
  DEFAULTS, settings, validateSettings, applySettings, publicPrices, isOpenCp,
  zoneOf, isOpen, quote, estimateMargin, todayParis, isValidDate, holidays, nowParisMinutes,
};
