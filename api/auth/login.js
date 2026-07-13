const { cors, setSessionCookie, login } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = null; }
    }
    const username = body && body.username;
    const password = body && body.password;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await login(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    setSessionCookie(res, user.username);
    return res.status(200).json({ ok: true, user: { username: user.username } });
  } catch (err) {
    console.error('[auth/login]', err);
    return res.status(500).json({ error: err.message });
  }
};
