// Vercel Serverless Function — Upstash Redis REST API
// Env vars: KV_REST_API_URL, KV_REST_API_TOKEN
// Single key "fp-data" stores the entire JSON blob.

const REDIS_KEY = 'fp-data';

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
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth !== secret) {
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
