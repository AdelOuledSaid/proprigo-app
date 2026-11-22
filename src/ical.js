'use strict';
// Synchronisation du calendrier d'une annonce (Airbnb, Abritel, Booking) au format iCal.
// À chaque départ de voyageurs, un ménage est créé automatiquement à l'heure de départ du logement.
const dns = require('node:dns/promises');
const net = require('node:net');
const pricing = require('./pricing');
const engine = require('./engine');
const { log } = require('./db');

const ALLOWED_HOSTS = /(^|\.)(airbnb\.[a-z.]+|abritel\.fr|vrbo\.com|homeaway\.[a-z.]+|booking\.com|admin\.booking\.com)$/i;
const HORIZON_DAYS = 60;
const MAX_BYTES = 1_000_000;
const MAX_EVENTS = 3000;
// Un séjour absent du calendrier n'annule jamais un ménage : il est signalé au client et à l'équipe
// s'il manque à deux synchronisations d'affilée, à au moins une heure d'écart.
const MISSING_CONFIRM_MS = 3600e3;

/** Lit les événements d'un fichier iCal : uid, début, fin (date de départ) et titre. */
function parse(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') { if (ev && ev.end) events.push(ev); ev = null; } else if (ev) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].toUpperCase();
      const val = line.slice(i + 1).trim();
      const date = (v) => (/^\d{8}/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
      if (key === 'UID') ev.uid = val;
      if (key === 'DTSTART') ev.start = date(val);
      if (key === 'DTEND') ev.end = date(val);
      if (key === 'SUMMARY') ev.summary = val;
    }
  }
  return events;
}

/** Les dates bloquées par l'hôte (« Not available ») ne sont pas des séjours : pas de ménage. */
const isStay = (e) => !/not available|indisponible|blocked|bloqu/i.test(e.summary || '');

/** Adresses internes ou réservées : jamais appelées (protection SSRF). */
function isPrivate(ip) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  return /^(::$|::1$|fc|fd|fe[89ab])/i.test(ip);
}

async function checkUrl(raw, allowAny) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Adresse du calendrier invalide.'); }
  if (allowAny) return u;
  if (u.protocol !== 'https:') throw new Error('Le lien du calendrier doit commencer par https://');
  if (u.username || u.password || (u.port && u.port !== '443')) throw new Error('Adresse du calendrier refusée.');
  if (!ALLOWED_HOSTS.test(u.hostname)) throw new Error('Lien accepté : calendrier Airbnb, Abritel ou Booking (exporter le calendrier, lien .ics).');
  // Seuls les domaines des plateformes sont acceptés (ils ne pointent pas vers nos adresses internes) ;
  // on vérifie en plus que leur adresse n'est pas interne.
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('Adresse du calendrier refusée.');
  return u;
}

/** Téléchargement limité : 10 secondes, 1 Mo lus au maximum, pas de redirection, type de contenu vérifié. */
async function download(url) {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'text/calendar, text/plain;q=0.5' } });
  if (!res.ok) throw new Error(`Le calendrier ne répond pas (erreur ${res.status}).`);
  if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Calendrier trop volumineux.');
  const type = res.headers.get('content-type') || '';
  if (type && !/text\/(calendar|plain)|application\/(octet-stream|ics)/i.test(type)) throw new Error('Ce lien ne renvoie pas un calendrier (.ics).');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Calendrier trop volumineux.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Un fichier coupé en route ou une page d'erreur ne doit jamais être pris pour un calendrier vide. */
function checkComplete(text) {
  const t = String(text);
  if (!/^\s*BEGIN:VCALENDAR/i.test(t) || !/END:VCALENDAR\s*$/i.test(t)) throw new Error('Calendrier incomplet ou illisible : aucun ménage n\'a été modifié. Nouvel essai à la prochaine synchronisation.');
  if ((t.match(/BEGIN:VEVENT/g) || []).length > MAX_EVENTS) throw new Error('Calendrier trop volumineux.');
}

/**
 * Synchronise un logement. Crée les ménages des départs à venir (60 jours).
 * Un séjour qui disparaît du calendrier n'annule rien : le ménage est seulement signalé « à vérifier ».
 */
async function syncHome(db, home, { now = new Date(), allowAny = false, fetchText = download, canBook = true } = {}) {
  if (!home.ical_url) throw new Error('Aucun calendrier relié à ce logement.');
  const url = await checkUrl(home.ical_url, allowAny);
  const text = await fetchText(url.toString());
  checkComplete(text);
  const events = parse(text).filter(isStay);
  const today = pricing.todayParis(now);
  const limit = new Date(Date.parse(today + 'T12:00:00Z') + HORIZON_DAYS * 864e5).toISOString().slice(0, 10);
  const wanted = events.filter((e) => e.end > today && e.end <= limit);
  let created = 0;
  let flagged = 0;
  const seen = new Set(events.map((e) => (e.uid || `${e.start}-${e.end}`).slice(0, 200)));
  for (const e of wanted) {
    const uid = (e.uid || `${e.start}-${e.end}`).slice(0, 200);
    if (db.prepare('SELECT 1 FROM bookings WHERE home_id = ? AND ical_uid = ?').get(home.id, uid)) continue;
    if (!canBook) continue;
    const q = pricing.quote({ service: home.service, size: home.size, hours: home.hours, cp: home.cp, date: e.end }, now);
    if (!q.ok || !q.open) continue;
    const r = db.prepare(`INSERT INTO bookings (client_id, service, size, hours, cp, address, date, time, urgent, kit, total, zone, paid, payment_status, checklist, photo_consent, home_id, source, ical_uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 'simule', ?, ?, ?, 'ical', ?)`).run(
      home.client_id, q.service, q.size, q.hours, home.cp, home.address, e.end, home.checkout_time, q.total, q.zone, home.checklist, home.photo_consent, home.id, uid);
    const id = Number(r.lastInsertRowid);
    log(db, `Calendrier « ${home.name} » : départ des voyageurs le ${e.end}, ménage n° ${id} créé automatiquement (${q.total} €, paiement simulé).`);
    engine.assign(db, id);
    created += 1;
  }
  // Séjours absents du calendrier : jamais d'annulation automatique.
  const future = db.prepare("SELECT * FROM bookings WHERE home_id = ? AND source = 'ical' AND date > ? AND status IN ('en_attente','proposee','attribuee')").all(home.id, today);
  const t = now.getTime();
  for (const b of future) {
    if (seen.has(b.ical_uid)) {
      if (b.ical_missing_since) {
        db.prepare('UPDATE bookings SET ical_missing_since = NULL, ical_flagged = 0 WHERE id = ?').run(b.id);
        if (b.ical_flagged) log(db, `Calendrier « ${home.name} » : le séjour du ménage n° ${b.id} est réapparu, rien à faire.`);
      }
      continue;
    }
    if (b.ical_keep || b.ical_flagged) continue; // déjà signalé, ou le client a choisi de garder le ménage
    if (!b.ical_missing_since) {
      db.prepare('UPDATE bookings SET ical_missing_since = ? WHERE id = ?').run(t, b.id); // première absence : on attend
      continue;
    }
    if (t - Number(b.ical_missing_since) < MISSING_CONFIRM_MS) continue;
    db.prepare('UPDATE bookings SET ical_flagged = 1 WHERE id = ?').run(b.id);
    engine.notify(db, b.id, `Le séjour lié au ménage du ${engine.frDate(b.date)} n'apparaît plus dans le calendrier de « ${home.name} ». Le ménage reste prévu. Si le séjour est bien annulé, vous pouvez annuler le ménage depuis « Mes réservations » ; sinon, choisissez « Garder le ménage ».`);
    log(db, `Calendrier « ${home.name} » : séjour absent du calendrier pour le ménage n° ${b.id}. Ménage maintenu, à vérifier.`);
    flagged += 1;
  }
  const result = `${created} ménage(s) créé(s)${flagged ? `, ${flagged} séjour(s) à vérifier` : ''}`;
  db.prepare("UPDATE homes SET last_sync = datetime('now'), last_sync_result = ? WHERE id = ?").run(result, home.id);
  return { created, flagged, message: `Calendrier synchronisé : ${result}.` };
}

module.exports = { parse, syncHome, ALLOWED_HOSTS, isPrivate, checkComplete, download, MISSING_CONFIRM_MS };
