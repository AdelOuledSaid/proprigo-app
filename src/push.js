'use strict';
// Notifications sur téléphone (Web Push), sans dépendance : identification VAPID (RFC 8292)
// et chiffrement du message (RFC 8291, aes128gcm de RFC 8188).
// Android (Chrome, Firefox) : directement. iPhone : après « Sur l'écran d'accueil » (iOS 16.4 et plus).
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// Seuls les services de notification des navigateurs sont contactés (jamais une adresse quelconque).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];
function validEndpoint(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname)) && url.length < 1000;
  } catch { return false; }
}

/** Clés VAPID : gardées dans la base (table settings) ou fournies par VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. */
function vapidKeys(db, env = process.env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const row = db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (row) return JSON.parse(row.value);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}

function privateKeyObject(keys) {
  const pub = fromB64u(keys.publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/** Jeton VAPID signé (ES256) pour le service de notification de l'abonnement. */
function vapidHeader(endpoint, keys, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Chiffre le message pour un abonnement (p256dh, auth). salt et clé serveur injectables pour les tests. */
function encrypt(payload, sub, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Abonnement invalide');
  const server = ecdh || (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e; })();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // un seul enregistrement : délimiteur 0x02
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Envoie une notification. Renvoie 'ok', 'gone' (abonnement expiré, à supprimer) ou 'error'. */
async function send(sub, message, { keys, subject, fetchImpl = fetch }) {
  if (!validEndpoint(sub.endpoint)) return 'gone';
  const body = encrypt(JSON.stringify(message), sub);
  let r;
  try {
    r = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidHeader(sub.endpoint, keys, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' },
      body, signal: AbortSignal.timeout(10000),
    });
  } catch { return 'error'; }
  if (r.status === 404 || r.status === 410) return 'gone';
  return r.ok ? 'ok' : 'error';
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_ok TEXT, fails INTEGER NOT NULL DEFAULT 0)`);
}
/** Notifie tous les téléphones d'un utilisateur. Les abonnements expirés sont supprimés. Ne lève jamais d'erreur. */
async function notifyUser(db, userId, message, { subject = 'mailto:contact@proprigo.fr', fetchImpl = fetch } = {}) {
  try {
    ensureTable(db);
    const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
    if (!subs.length) return 0;
    const keys = vapidKeys(db);
    let sent = 0;
    for (const s of subs) {
      const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message, { keys, subject, fetchImpl });
      if (r === 'ok') { sent += 1; db.prepare("UPDATE push_subs SET last_ok = datetime('now'), fails = 0 WHERE id = ?").run(s.id); }
      else if (r === 'gone' || s.fails >= 9) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      else db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE id = ?').run(s.id);
    }
    return sent;
  } catch { return 0; }
}

module.exports = { ensureTable, notifyUser, validEndpoint, vapidKeys, vapidHeader, encrypt, send, b64u, fromB64u };
