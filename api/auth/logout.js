const { cors, clearSessionCookie } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
};
