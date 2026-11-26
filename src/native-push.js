'use strict';
// Notifications des applis Android et iPhone (Capacitor), sans dépendance.
// - iPhone : Apple Push Notification service (HTTP/2, jeton JWT ES256 signé avec la clé .p8).
// - Android : Firebase Cloud Messaging HTTP v1 (compte de service Google, jeton OAuth RS256).
// Rien n'est envoyé tant que les variables ne sont pas renseignées.
const crypto = require('node:crypto');
const http2 = require('node:http2');

const b64u = (b) => Buffer.from(b).toString('base64url');
const pem = (s) => String(s || '').replace(/\\n/g, '\n').trim();

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_push (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok TEXT, fails INTEGER NOT NULL DEFAULT 0)`);
}

const validToken = (platform, token) => (platform === 'ios' ? /^[0-9a-f]{64,200}$/i.test(token) : /^[\w:.-]{20,4096}$/.test(token));

// ---- configuration lue dans l'environnement ----
function config(env = process.env) {
  let sa = null;
  try { if (env.FCM_SERVICE_ACCOUNT) sa = JSON.parse(env.FCM_SERVICE_ACCOUNT); } catch { sa = null; }
  return {
    apns: env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID ? {
      key: pem(env.APNS_KEY), keyId: env.APNS_KEY_ID.trim(), teamId: env.APNS_TEAM_ID.trim(),
      topic: (env.APNS_BUNDLE_ID || 'fr.proprigo.app').trim(),
      host: env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
    } : null,
    fcm: sa && sa.private_key && sa.client_email && sa.project_id ? { email: sa.client_email, key: pem(sa.private_key), project: sa.project_id } : null,
  };
}

// ---- jetons d'accès, mis en cache ----
const cache = {};
function apnsJwt(c, now = Date.now()) {
  if (cache.apns && cache.apns.exp > now) return cache.apns.token;
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: c.keyId }));
  const claims = b64u(JSON.stringify({ iss: c.teamId, iat: Math.floor(now / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: c.key, dsaEncoding: 'ieee-p1363' });
  const token = `${head}.${claims}.${b64u(sig)}`;
  cache.apns = { token, exp: now + 40 * 60e3 }; // Apple : à renouveler entre 20 et 60 minutes
  return token;
}
async function fcmAccessToken(c, fetchImpl, now = Date.now()) {
  if (cache.fcm && cache.fcm.exp > now) return cache.fcm.token;
  const iat = Math.floor(now / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: c.email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), c.key);
  const r = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64u(sig)}` }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('FCM : authentification refusée');
  cache.fcm = { token: j.access_token, exp: now + (Number(j.expires_in || 3600) - 300) * 1000 };
  return cache.fcm.token;
}

// ---- envoi : renvoie 'ok', 'gone' (jeton à supprimer) ou 'fail' ----
function apnsSend(c, token, msg, { http2Connect = http2.connect } = {}) {
  return new Promise((resolve) => {
    let done = false; const end = (v) => { if (!done) { done = true; try { client.close(); } catch { /* déjà fermé */ } resolve(v); } };
    const client = http2Connect(c.host);
    client.on('error', () => end('fail'));
    const payload = JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default', 'thread-id': msg.tag || 'proprigo' }, url: msg.url || '/#/' });
    const req = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${apnsJwt(c)}`, 'apns-topic': c.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' });
    req.setTimeout(10e3, () => { req.close(); end('fail'); });
    req.on('response', (h) => { const st = Number(h[':status']); req.resume(); end(st === 200 ? 'ok' : st === 410 || st === 400 ? 'gone' : 'fail'); });
    req.on('error', () => end('fail'));
    req.end(payload);
  });
}
async function fcmSend(c, token, msg, fetchImpl) {
  const access = await fcmAccessToken(c, fetchImpl);
  const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(c.project)}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: msg.title, body: msg.body }, data: { url: String(msg.url || '/#/') }, android: { priority: 'HIGH', notification: { tag: msg.tag || undefined, channel_id: 'proprigo' } } } }),
  });
  if (r.ok) return 'ok';
  const j = await r.json().catch(() => ({}));
  const code = JSON.stringify(j);
  return r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(code) ? 'gone' : 'fail';
}

async function notifyUser(db, userId, msg, { env = process.env, fetchImpl = fetch, http2Connect } = {}) {
  try {
    ensureTable(db);
    const rows = db.prepare('SELECT * FROM native_push WHERE user_id = ?').all(userId);
    if (!rows.length) return 0;
    const c = config(env);
    let sent = 0;
    for (const row of rows) {
      let r = 'fail';
      try {
        if (row.platform === 'ios' && c.apns) r = await apnsSend(c.apns, row.token, msg, { http2Connect });
        else if (row.platform === 'android' && c.fcm) r = await fcmSend(c.fcm, row.token, msg, fetchImpl);
        else continue; // service pas encore configuré : on garde le jeton
      } catch { r = 'fail'; }
      if (r === 'ok') { sent += 1; db.prepare("UPDATE native_push SET last_ok = datetime('now'), fails = 0 WHERE id = ?").run(row.id); }
      else if (r === 'gone' || row.fails >= 9) db.prepare('DELETE FROM native_push WHERE id = ?').run(row.id);
      else db.prepare('UPDATE native_push SET fails = fails + 1 WHERE id = ?').run(row.id);
    }
    return sent;
  } catch { return 0; }
}

module.exports = { ensureTable, validToken, config, notifyUser, apnsJwt, fcmAccessToken, _cache: cache };
