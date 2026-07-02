// Vercel Serverless Function — Upstash Redis REST API
// Env vars: KV_REST_API_URL, KV_REST_API_TOKEN
// Redis key "fp-data" stores one JSON object (POST from client). Typical keys:
//   YYYY-MM-DD-day notes, *-events / *-flights, __recurring__, __todos__, __projects__,
//   fp-dash-top3-project, fp-dash-show-hidden-plates, ...
// __todos__ / __projects__ hold JSON.stringify(arrays); todo objects may include importance,
// project objects may include dashboardHidden — both sync with the blob.
const REDIS_KEY = 'fp-data';

/** Merge JSON.stringify'd object arrays by id; incoming wins on field conflicts. */
function mergeTodoObjects(prev, incoming) {
  if (!prev) return { ...incoming };
  const out = { ...prev, ...incoming };
  for (const f of ['dueBy', 'blockDate', 'blockStart', 'blockEnd', 'importance']) {
    if (!(f in incoming)) delete out[f];
  }
  return out;
}

function mergeStoredJsonArrays(baseRaw, overlayRaw, idKey, mergeItem) {
  let base = [], overlay = [];
  try { base = JSON.parse(baseRaw || '[]'); } catch (_) {}
  try { overlay = JSON.parse(overlayRaw || '[]'); } catch (_) {}
  if (!Array.isArray(base)) base = [];
  if (!Array.isArray(overlay)) overlay = [];

  const combine = mergeItem || ((a, b) => (a ? { ...a, ...b } : { ...b }));

  const byId = new Map();
  base.forEach(item => {
    if (item && item[idKey]) byId.set(item[idKey], { ...item });
  });
  overlay.forEach(item => {
    if (!item || !item[idKey]) return;
    const prev = byId.get(item[idKey]);
    byId.set(item[idKey], combine(prev, item));
  });

  const order = [];
  const seen = new Set();
  overlay.forEach(item => {
    if (item && item[idKey] && byId.has(item[idKey])) {
      order.push(byId.get(item[idKey]));
      seen.add(item[idKey]);
    }
  });
  base.forEach(item => {
    if (item && item[idKey] && !seen.has(item[idKey])) {
      order.push(byId.get(item[idKey]));
      seen.add(item[idKey]);
    }
  });
  return JSON.stringify(order);
}

async function redis(method, ...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Missing KV_REST_API_URL or KV_REST_API_TOKEN env vars');

  const res = await fetch(`${url}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([method, ...args]),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  // CORS — allow the Vercel-hosted frontend (same origin) and local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Auth: require a shared secret so strangers can't read/write your calendar.
  // Set FP_API_SECRET in Vercel env vars, then pass it from the client as
  // Authorization: Bearer <secret>.
  const secret = process.env.FP_API_SECRET;
  if (secret) {
    const authHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const authQuery  = (req.query && req.query.secret) || '';
    if (authHeader !== secret && authQuery !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    if (req.method === 'GET') {
      const { result } = await redis('GET', REDIS_KEY);
      const data = result ? JSON.parse(result) : {};
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      // Merge strategy: read current, merge incoming on top, write back.
      // This prevents one user from overwriting the other's changes on
      // keys they didn't touch.
      const { result: existing } = await redis('GET', REDIS_KEY);
      const current = existing ? JSON.parse(existing) : {};

      // Null / empty-string values are deletions
      for (const [k, v] of Object.entries(body)) {
        if (v === null || v === '') {
          delete current[k];
        } else if (k === '__todos__' || k === '__projects__') {
          const itemMerge = k === '__todos__' ? mergeTodoObjects : null;
          current[k] = mergeStoredJsonArrays(current[k], v, 'id', itemMerge);
        } else {
          current[k] = v;
        }
      }

      await redis('SET', REDIS_KEY, JSON.stringify(current));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
