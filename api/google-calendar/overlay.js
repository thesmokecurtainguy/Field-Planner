// Read-only Google Calendar overlay.
// GET ?start=YYYY-MM-DD&end=YYYY-MM-DD
// Fetches events from the dedicated Field Planner calendar and returns only those
// that are NOT already represented in app_data (by googleEventId / __google_synced_ids__).
// Never writes to the payload — avoids sync loops entirely.
const { cors, requireUser } = require('../../lib/auth');
const { getAppDataWithMeta } = require('../../lib/db');
const { isGoogleConfigured, fetchOverlayEvents } = require('../../lib/google-calendar');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = requireUser(req, res);
  if (!user) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isGoogleConfigured()) {
    return res.status(503).json({
      error: 'Google Calendar sync not configured — set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_ID',
    });
  }

  const start = typeof req.query?.start === 'string' ? req.query.start : '';
  const end = typeof req.query?.end === 'string' ? req.query.end : '';

  try {
    // Read payload only to collect known googleEventIds — never mutate / never setAppData.
    const { payload } = await getAppDataWithMeta();
    const result = await fetchOverlayEvents(payload, { start, end });
    return res.status(200).json({
      ok: true,
      events: result.events,
      meta: result.meta,
    });
  } catch (err) {
    if (err && err.code === 'BAD_RANGE') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[google-calendar/overlay]', err);
    return res.status(500).json({ error: err.message || 'Google overlay failed' });
  }
};
