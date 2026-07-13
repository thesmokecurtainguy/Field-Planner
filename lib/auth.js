const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { findUserByUsername, ensureSchema } = require('./db');

const COOKIE_NAME = 'fp_session';
const SESSION_DAYS = 30;

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(s, 'base64').toString('utf8');
}

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('Missing SESSION_SECRET');
  return s;
}

function signPayload(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = b64url(crypto.createHmac('sha256', sessionSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', sessionSecret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(fromB64url(payload));
  } catch (_) {
    return null;
  }
  if (!data || !data.u || !data.exp || Date.now() > data.exp) return null;
  return data;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieOptions(maxAgeSec) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts;
}

function setSessionCookie(res, username) {
  const token = signPayload({
    u: username,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  const parts = cookieOptions(SESSION_DAYS * 24 * 60 * 60);
  parts[0] = `${COOKIE_NAME}=${encodeURIComponent(token)}`;
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = cookieOptions(0);
  parts[0] = `${COOKIE_NAME}=`;
  res.setHeader('Set-Cookie', parts.join('; '));
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const data = verifyToken(cookies[COOKIE_NAME]);
  return data ? { username: data.u } : null;
}

function requireUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return user;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-FP-Base-Revision');
  res.setHeader('Access-Control-Expose-Headers', 'X-FP-Revision');
}

async function login(username, password) {
  await ensureSchema();
  const user = await findUserByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) return null;
  return { username: user.username };
}

module.exports = {
  COOKIE_NAME,
  cors,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  requireUser,
  login,
};
