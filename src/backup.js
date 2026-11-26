'use strict';
// Sauvegarde de la base : copie cohérente (VACUUM INTO), même pendant que le site tourne.
// Les 14 dernières sauvegardes sont gardées sur le disque Render. Chaque sauvegarde est vérifiée,
// puis, si un stockage externe est configuré, chiffrée et envoyée hors de Render.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 14;

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

/** Crée une sauvegarde et supprime les plus anciennes. Renvoie le chemin du fichier créé. */
function backup(db, dir, { keep = KEEP, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `proprigo-${stamp(now)}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);
  const all = list(dir);
  for (const old of all.slice(keep)) fs.unlinkSync(path.join(dir, old.file));
  return file;
}

/** Sauvegardes présentes, de la plus récente à la plus ancienne. */
function list(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^proprigo-\d{8}-\d{4}\.db$/.test(f)).sort().reverse()
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size, time: fs.statSync(path.join(dir, f)).mtimeMs }));
}

/** Vérifie qu'une sauvegarde s'ouvre et qu'elle est intacte : c'est un essai de restauration. */
function verify(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').get();
    const ok = Object.values(check)[0] === 'ok';
    const count = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; } };
    return { ok, users: count('users'), bookings: count('bookings'), payments: count('stripe_payments') };
  } finally { db.close(); }
}

// ---- chiffrement AES-256-GCM (format : PGB1 | sel 16 | iv 12 | tag 16 | données)
const MAGIC = Buffer.from('PGB1');
function deriveKey(secret, salt) {
  if (typeof secret !== 'string' || secret.length < 20) throw new Error('BACKUP_ENCRYPTION_KEY : 20 caractères minimum.');
  return crypto.scryptSync(secret, salt, 32);
}
function encrypt(buf, secret) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), data]);
}
function decrypt(buf, secret) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Fichier non reconnu (pas une sauvegarde chiffrée Proprigo).');
  const salt = buf.subarray(4, 20); const iv = buf.subarray(20, 32); const tag = buf.subarray(32, 48);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(48)), d.final()]); }
  catch { throw new Error('Déchiffrement impossible : mauvaise clé ou fichier abîmé.'); }
}

// ---- envoi vers un stockage compatible S3 (Cloudflare R2, Backblaze B2, Scaleway, OVH, AWS…)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
/** Signature AWS Signature V4. headers : en-têtes à signer (noms en minuscules), host compris. */
function signV4({ method, path: p, query = '', headers, payloadHash, accessKey, secretKey, region, service = 's3', amzDate }) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, p, query, names.map((h) => `${h}:${lower[h]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { signature, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** Configuration lue dans les variables d'environnement ; null si le stockage externe n'est pas configuré. */
function offsiteConfig(env = process.env) {
  const c = { endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET, accessKey: env.BACKUP_S3_ACCESS_KEY, secretKey: env.BACKUP_S3_SECRET_KEY,
    region: env.BACKUP_S3_REGION || 'auto', prefix: (env.BACKUP_S3_PREFIX || 'proprigo').replace(/^\/+|\/+$/g, ''), encryptionKey: env.BACKUP_ENCRYPTION_KEY };
  if (!c.endpoint || !c.bucket || !c.accessKey || !c.secretKey) return null;
  if (!/^https:\/\//.test(c.endpoint)) throw new Error('BACKUP_S3_ENDPOINT doit commencer par https://');
  if (!c.encryptionKey) throw new Error('BACKUP_ENCRYPTION_KEY manquante : aucune sauvegarde ne part en clair.');
  return c;
}

/** Chiffre la sauvegarde et l'envoie. Renvoie le nom du fichier distant. */
async function uploadOffsite(file, cfg, { now = new Date(), fetchImpl = fetch } = {}) {
  const body = encrypt(fs.readFileSync(file), cfg.encryptionKey);
  const name = `${cfg.prefix ? cfg.prefix + '/' : ''}${path.basename(file)}.enc`;
  const base = new URL(cfg.endpoint);
  const p = `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(cfg.bucket)}/${name.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256(body);
  const headers = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const { authorization } = signV4({ method: 'PUT', path: p, headers, payloadHash, accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region, amzDate });
  const resp = await fetchImpl(`${base.origin}${p}`, {
    method: 'PUT', body,
    headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, Authorization: authorization, 'Content-Type': 'application/octet-stream' },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    throw new Error(`Stockage externe : refus ${resp.status}${code ? ` (${code})` : ''}`);
  }
  return name;
}

module.exports = { backup, list, verify, encrypt, decrypt, signV4, offsiteConfig, uploadOffsite, KEEP };
