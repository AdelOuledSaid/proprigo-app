'use strict';
// E-mails envoyés aux clients et aux intervenantes.
// Sans fournisseur configuré, les e-mails sont enregistrés dans data/outbox/ (visibles par l'équipe) :
// rien ne part vraiment. En production, définir MAIL_PROVIDER=brevo ou resend, MAIL_API_KEY et MAIL_FROM.
const fs = require('node:fs');
const path = require('node:path');

const crypto = require('node:crypto');

const cfg = { outbox: null, provider: null, apiKey: null, from: 'Proprigo <bonjour@proprigo.fr>', appUrl: 'http://localhost:3000', db: null, retryDelaysMs: [2000, 8000] };
let onError = () => {};

function configure(opts) {
  Object.assign(cfg, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)));
  // Le fournisseur se règle explicitement : sans fournisseur, on revient au mode local.
  if ('provider' in opts) cfg.provider = opts.provider || null;
  if ('apiKey' in opts) cfg.apiKey = opts.apiKey || null;
  if (cfg.outbox) fs.mkdirSync(cfg.outbox, { recursive: true });
  if (opts.onError) onError = opts.onError;
  if (cfg.db) {
    // mail_sent : un e-mail « unique » (clé) ne part qu'une fois, même si l'action est rejouée.
    // mail_queue : e-mails en échec temporaire, renvoyés plus tard, même après un redémarrage.
    cfg.db.exec(`CREATE TABLE IF NOT EXISTS mail_sent (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS mail_queue (id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, idem TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT, status TEXT NOT NULL DEFAULT 'attente', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function html(title, lines, cta) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f2f5ff;font-family:Arial,sans-serif;color:#0f1430">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p style="font-size:22px;font-weight:800;color:#1f4fff;margin:0 0 16px">proprigo</p>
<div style="background:#ffffff;border:1px solid #dce3f7;border-radius:16px;padding:20px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${lines.map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 10px">${esc(l)}</p>`).join('')}
${cta ? `<p style="margin:18px 0 0"><a href="${esc(cfg.appUrl + cta.path)}" style="background:#ff6a3d;color:#0f1430;font-weight:700;text-decoration:none;padding:12px 18px;border-radius:12px;display:inline-block">${esc(cta.label)}</a></p>` : ''}
</div>
<p style="font-size:12px;color:#596181;margin:16px 0 0">Proprigo, ménage à la demande. Vous recevez cet e-mail au sujet de votre compte ou d'une réservation.</p>
</div></body></html>`;
}

class MailError extends Error {
  constructor(message, transient) { super(message); this.transient = transient; }
}
const failure = (name, status) => new MailError(`${name} : erreur ${status}`, status === 429 || status >= 500);

async function deliver(to, subject, body, idem = crypto.randomUUID()) {
  if (cfg.provider === 'brevo') {
    const m = /^(.*)<(.+)>$/.exec(cfg.from) || [null, 'Proprigo', cfg.from];
    const r = await post('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: m[1].trim(), email: m[2].trim() }, to: [{ email: to }], subject, htmlContent: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw failure('Brevo', r.status);
    return;
  }
  if (cfg.provider === 'resend') {
    const r = await post('https://api.resend.com/emails', {
      method: 'POST',
      // Même clé à chaque nouvel essai : Resend n'envoie jamais deux fois le même e-mail.
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idem.slice(0, 256) },
      body: JSON.stringify({ from: cfg.from, to: [to], subject, html: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw failure('Resend', r.status);
    return;
  }
  // mode local : boîte d'envoi
  if (!cfg.outbox) return;
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.html`;
  fs.writeFileSync(path.join(cfg.outbox, name), `<!-- to: ${esc(to)} | subject: ${esc(subject)} -->\n${body}`);
}

async function post(url, init) {
  try { return await fetch(url, init); }
  catch (e) { throw new MailError(`réseau (${e.name === 'TimeoutError' ? 'délai dépassé' : 'connexion impossible'})`, true); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
// Nouveaux essais en file : 5 min, 15 min, 1 h, 3 h, 6 h, puis abandon (signalé au journal).
const QUEUE_DELAYS_MIN = [5, 15, 60, 180, 360];

function enqueue(to, subject, body, idem, error) {
  if (!cfg.db) return false;
  cfg.db.prepare('INSERT INTO mail_queue (to_addr, subject, body, idem, attempts, next_at, last_error) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(to, subject, body, idem, Date.now() + QUEUE_DELAYS_MIN[0] * 60e3, error);
  return true;
}

/**
 * Envoie sans bloquer l'action en cours.
 * opts.key : e-mail unique (ex. « confirm-12 ») ; s'il est déjà parti, rien n'est renvoyé.
 * Erreur temporaire (réseau, 429, 5xx) : 2 nouveaux essais rapides, puis file d'attente.
 * Erreur définitive (adresse refusée…) : notée au journal.
 */
async function send(to, subject, title, lines, cta, opts = {}) {
  if (!to) return 'aucun';
  if (opts.key && cfg.db) {
    const r = cfg.db.prepare('INSERT OR IGNORE INTO mail_sent (key) VALUES (?)').run(String(opts.key));
    if (!r.changes) return 'deja';
  }
  const body = html(title, lines, cta);
  const idem = opts.key ? `proprigo-${opts.key}` : crypto.randomUUID();
  for (let i = 0; ; i++) {
    try { await deliver(to, subject, body, idem); return 'envoye'; }
    catch (e) {
      const transient = e.transient !== false;
      if (transient && i < cfg.retryDelaysMs.length) { await sleep(cfg.retryDelaysMs[i]); continue; }
      if (transient && enqueue(to, subject, body, idem, e.message)) {
        onError(`E-mail « ${subject} » à ${to} en attente : ${e.message}. Nouvel essai automatique dans ${QUEUE_DELAYS_MIN[0]} min.`);
        return 'en_attente';
      }
      onError(`E-mail non envoyé à ${to} (« ${subject} ») : ${e.message}`);
      return 'echec';
    }
  }
}

/** Renvoie les e-mails en attente dont l'heure est venue. Appelé toutes les 5 minutes. */
async function processQueue(now = Date.now()) {
  if (!cfg.db) return { sent: 0, failed: 0 };
  let sent = 0; let failed = 0;
  for (const m of cfg.db.prepare("SELECT * FROM mail_queue WHERE status = 'attente' AND next_at <= ? ORDER BY id LIMIT 50").all(now)) {
    try {
      await deliver(m.to_addr, m.subject, m.body, m.idem);
      cfg.db.prepare("UPDATE mail_queue SET status = 'envoye', attempts = attempts + 1, last_error = NULL WHERE id = ?").run(m.id);
      sent += 1;
    } catch (e) {
      const attempts = m.attempts + 1;
      if (e.transient === false || attempts >= QUEUE_DELAYS_MIN.length) {
        cfg.db.prepare("UPDATE mail_queue SET status = 'abandon', attempts = ?, last_error = ? WHERE id = ?").run(attempts, e.message, m.id);
        onError(`E-mail abandonné après ${attempts + cfg.retryDelaysMs.length + 1} essais : « ${m.subject} » à ${m.to_addr} (${e.message}).`);
        failed += 1;
      } else {
        cfg.db.prepare('UPDATE mail_queue SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(attempts, now + QUEUE_DELAYS_MIN[attempts] * 60e3, e.message, m.id);
      }
    }
  }
  cfg.db.prepare("DELETE FROM mail_queue WHERE status = 'envoye' AND created_at < datetime('now', '-7 days')").run();
  return { sent, failed };
}

function queueState() {
  if (!cfg.db) return { attente: 0, abandon: 0 };
  const n = (st) => cfg.db.prepare('SELECT COUNT(*) AS n FROM mail_queue WHERE status = ?').get(st).n;
  return { attente: n('attente'), abandon: n('abandon') };
}

function outbox(limit = 30) {
  if (!cfg.outbox || !fs.existsSync(cfg.outbox)) return [];
  return fs.readdirSync(cfg.outbox).filter((f) => f.endsWith('.html')).sort().reverse().slice(0, limit).map((f) => {
    const head = fs.readFileSync(path.join(cfg.outbox, f), 'utf8').split('\n')[0];
    const m = /to: (.*) \| subject: (.*) -->/.exec(head) || [];
    return { file: f, to: m[1] || '', subject: m[2] || '' };
  });
}

function readOutbox(file) {
  if (!/^[\w.-]+\.html$/.test(file)) return null;
  const p = path.join(cfg.outbox, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

module.exports = { configure, send, processQueue, queueState, outbox, readOutbox, cfg, MailError };
