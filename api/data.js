// Vercel Serverless — household JSON blob in Railway Postgres.
// Env: DATABASE_URL, SESSION_SECRET
// Optional one-time import: KV_REST_API_URL, KV_REST_API_TOKEN
// Seed users: AUTH_JOHN_PASSWORD, AUTH_MELISSA_PASSWORD
// Concurrency: clients send X-FP-Base-Revision from the last GET; stale writes get 409.
const { cors, requireUser } = require('../lib/auth');
const { getAppDataWithMeta, setAppData } = require('../lib/db');

module.exports = async function handler(req, res) {
  cors(res);
  res.setHeader('Access-Control-Expose-Headers', 'X-FP-Revision');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = requireUser(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const { payload, revision } = await getAppDataWithMeta();
      res.setHeader('X-FP-Revision', String(revision));
      return res.status(200).json(payload);
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = null; }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }

      const baseRevision = req.headers['x-fp-base-revision'];
      try {
        const saved = await setAppData(body, baseRevision);
        res.setHeader('X-FP-Revision', String(saved.revision));
        return res.status(200).json({ ok: true, revision: saved.revision, keys: Object.keys(saved.payload).length });
      } catch (err) {
        if (err && err.code === 'CONFLICT' && err.conflict) {
          res.setHeader('X-FP-Revision', String(err.conflict.revision));
          return res.status(409).json({
            error: 'Stale data — refreshed from server',
            revision: err.conflict.revision,
            data: err.conflict.payload,
          });
        }
        throw err;
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
