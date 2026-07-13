// Vercel Serverless — household JSON blob in Railway Postgres.
// Env: DATABASE_URL, SESSION_SECRET
// Optional one-time import: KV_REST_API_URL, KV_REST_API_TOKEN
// Seed users: AUTH_JOHN_PASSWORD, AUTH_MELISSA_PASSWORD
const { cors, requireUser } = require('../lib/auth');
const { getAppData, setAppData } = require('../lib/db');

const TODO_OPT_FIELDS = ['dueBy', 'blockDate', 'blockStart', 'blockEnd', 'importance'];

function todoTs(t) {
  return (t && (t.updatedAt || t.createdAt)) || 0;
}

function mergeTodoObjects(prev, incoming) {
  if (!prev) return { ...incoming };
  if (!incoming) return { ...prev };
  if (todoTs(incoming) >= todoTs(prev)) {
    const out = { ...prev, ...incoming };
    for (const f of TODO_OPT_FIELDS) {
      if (f in incoming && incoming[f] == null) delete out[f];
    }
    return out;
  }
  return { ...prev };
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

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = requireUser(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const data = await getAppData();
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = null; }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }

      const current = await getAppData();

      for (const [k, v] of Object.entries(body)) {
        if (v === null || v === '') {
          delete current[k];
        } else if (k === '__todos__' || k === '__projects__') {
          const itemMerge = k === '__todos__' ? mergeTodoObjects : null;
          current[k] = mergeStoredJsonArrays(current[k], v, 'id', itemMerge);
        } else if (k.endsWith('-events') || k.endsWith('-flights') || k === '__recurring__') {
          if (v === '[]' && current[k] && current[k] !== '[]') continue;
          current[k] = mergeStoredJsonArrays(current[k], v, 'id');
        } else {
          current[k] = v;
        }
      }

      await setAppData(current);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
