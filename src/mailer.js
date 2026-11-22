'use strict';
// E-mails envoyés aux clients et aux intervenantes.
// Sans fournisseur configuré, les e-mails sont enregistrés dans data/outbox/ (visibles par l'équipe) :
// rien ne part vraiment. En production, définir MAIL_PROVIDER=brevo ou resend, MAIL_API_KEY et MAIL_FROM.
const fs = require('node:fs');
const path = require('node:path');

const cfg = { outbox: null, provider: null, apiKey: null, from: 'Proprigo <bonjour@proprigo.fr>', appUrl: 'http://localhost:3000' };
let onError = () => {};

function configure(opts) {
  Object.assign(cfg, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)));
  if (cfg.outbox) fs.mkdirSync(cfg.outbox, { recursive: true });
  if (opts.onError) onError = opts.onError;
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

async function deliver(to, subject, body) {
  if (cfg.provider === 'brevo') {
    const m = /^(.*)<(.+)>$/.exec(cfg.from) || [null, 'Proprigo', cfg.from];
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: m[1].trim(), email: m[2].trim() }, to: [{ email: to }], subject, htmlContent: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Brevo : erreur ${r.status}`);
    return;
  }
  if (cfg.provider === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [to], subject, html: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Resend : erreur ${r.status}`);
    return;
  }
  // mode local : boîte d'envoi
  if (!cfg.outbox) return;
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.html`;
  fs.writeFileSync(path.join(cfg.outbox, name), `<!-- to: ${esc(to)} | subject: ${esc(subject)} -->\n${body}`);
}

/** Envoie sans bloquer l'action en cours ; une erreur est notée dans le journal. */
function send(to, subject, title, lines, cta) {
  if (!to) return Promise.resolve();
  return deliver(to, subject, html(title, lines, cta)).catch((e) => onError(`E-mail non envoyé à ${to} : ${e.message}`));
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

module.exports = { configure, send, outbox, readOutbox, cfg };
