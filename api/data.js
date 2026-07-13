// Vercel Serverless — household JSON blob in Railway Postgres.
// Env: DATABASE_URL, SESSION_SECRET
// Optional one-time import: KV_REST_API_URL, KV_REST_API_TOKEN
// Seed users: AUTH_JOHN_PASSWORD, AUTH_MELISSA_PASSWORD
const { cors, requireUser } = require('../lib/auth');
const { getAppData, setAppData } = require('../lib/db');

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

      // Last-write-wins: client sends the full household blob.
      // Avoid merge/empty-string deletion bugs that were wiping locations and edits.
      const saved = await setAppData(body);
      return res.status(200).json({ ok: true, keys: Object.keys(saved).length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
