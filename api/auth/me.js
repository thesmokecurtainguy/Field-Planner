const { cors, getSessionUser } = require('../../lib/auth');
const { ensureSchema } = require('../../lib/db');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(200).json({ user: { username: user.username } });
  } catch (err) {
    console.error('[auth/me]', err);
    return res.status(500).json({ error: err.message });
  }
};
