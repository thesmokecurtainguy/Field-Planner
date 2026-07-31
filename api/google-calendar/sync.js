// Push non-recurring Field Planner day events to the dedicated Google Calendar.
// Env: GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
// Client should call POST after a successful /api/data save.
const { cors, requireUser } = require('../../lib/auth');
const { getAppDataWithMeta, setAppData } = require('../../lib/db');
const { isGoogleConfigured, syncPayloadToGoogle } = require('../../lib/google-calendar');

async function runSyncOnce() {
  const { payload, revision } = await getAppDataWithMeta();
  const next = { ...payload };
  const stats = await syncPayloadToGoogle(next);
  const saved = await setAppData(next, revision);
  return { stats, saved };
}

module.exports = async function handler(req, res) {
  cors(res);
  res.setHeader('Access-Control-Expose-Headers', 'X-FP-Revision');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = requireUser(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isGoogleConfigured()) {
    return res.status(503).json({
      error: 'Google Calendar sync not configured — set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_ID',
    });
  }

  try {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stats, saved } = await runSyncOnce();
        res.setHeader('X-FP-Revision', String(saved.revision));
        return res.status(200).json({
          ok: true,
          revision: saved.revision,
          created: stats.created,
          updated: stats.updated,
          deleted: stats.deleted,
          recreated: stats.recreated,
          errors: stats.errors,
          data: saved.payload,
        });
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'CONFLICT' && attempt === 0) continue;
        if (err && err.code === 'CONFLICT' && err.conflict) {
          res.setHeader('X-FP-Revision', String(err.conflict.revision));
          return res.status(409).json({
            error: 'Stale data during Google sync',
            revision: err.conflict.revision,
            data: err.conflict.payload,
          });
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    console.error('[google-calendar/sync]', err);
    return res.status(500).json({ error: err.message || 'Google sync failed' });
  }
};
