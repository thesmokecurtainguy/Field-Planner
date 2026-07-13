const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

let pool;
let ready;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

function normalizePayload(payload) {
  // node-pg may return jsonb as object, or as a string if it was double-encoded.
  if (payload == null) return {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      return {};
    }
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload;
}

async function ensureSchema() {
  if (ready) return;
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS app_data (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    INSERT INTO app_data (id, payload)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
  await seedUsers();
  await maybeImportFromRedis();
  await repairDoubleEncodedPayload();
  ready = true;
}

async function seedUser(username, passwordEnv) {
  const password = process.env[passwordEnv];
  if (!password) return;
  const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rowCount > 0) return;
  const hash = await bcrypt.hash(password, 10);
  await query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
    [username, hash]
  );
}

async function seedUsers() {
  await seedUser('john', 'AUTH_JOHN_PASSWORD');
  await seedUser('melissa', 'AUTH_MELISSA_PASSWORD');
}

async function redisGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result || null;
}

async function maybeImportFromRedis() {
  const { rows } = await query('SELECT payload FROM app_data WHERE id = 1');
  const payload = normalizePayload(rows[0]?.payload);
  if (Object.keys(payload).length > 0) return;

  const raw = await redisGet('fp-data');
  if (!raw) return;
  let imported;
  try {
    imported = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return;
  }
  imported = normalizePayload(imported);
  if (!Object.keys(imported).length) return;
  await query(
    `UPDATE app_data SET payload = $1::jsonb, updated_at = NOW() WHERE id = 1`,
    [imported]
  );
}

/** Fix rows accidentally stored as a JSON string instead of a JSON object. */
async function repairDoubleEncodedPayload() {
  const { rows } = await query('SELECT payload FROM app_data WHERE id = 1');
  const raw = rows[0]?.payload;
  if (typeof raw !== 'string') return;
  const fixed = normalizePayload(raw);
  await query(
    `UPDATE app_data SET payload = $1::jsonb, updated_at = NOW() WHERE id = 1`,
    [fixed]
  );
}

async function findUserByUsername(username) {
  await ensureSchema();
  const { rows } = await query('SELECT id, username, password_hash FROM users WHERE username = $1', [
    String(username || '').toLowerCase().trim(),
  ]);
  return rows[0] || null;
}

async function getAppData() {
  await ensureSchema();
  const { rows } = await query('SELECT payload FROM app_data WHERE id = 1');
  return normalizePayload(rows[0]?.payload);
}

async function setAppData(payload) {
  await ensureSchema();
  const clean = normalizePayload(payload);
  // Pass a JS object — node-pg serializes jsonb. Never JSON.stringify first
  // (that double-encodes and makes every GET look empty).
  await query(
    `UPDATE app_data SET payload = $1::jsonb, updated_at = NOW() WHERE id = 1`,
    [clean]
  );
  return clean;
}

module.exports = {
  ensureSchema,
  findUserByUsername,
  getAppData,
  setAppData,
};
