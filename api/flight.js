export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.AVIATIONSTACK_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'Flight API not configured — add AVIATIONSTACK_KEY to your Vercel environment variables (free at aviationstack.com).'
    });
  }

  const { num, date } = req.query;
  if (!num) return res.status(400).json({ error: 'Flight number required' });

  try {
    const params = new URLSearchParams({ access_key: key, flight_iata: num.toUpperCase() });
    if (date) params.set('flight_date', date);

    const r = await fetch(`http://api.aviationstack.com/v1/flights?${params}`);
    const data = await r.json();

    // AviationStack returns errors as { success: false, error: { code, type, info } }
    if (data.error || data.success === false) {
      const info = data.error?.info || data.error?.message || JSON.stringify(data.error);
      const code = data.error?.code || r.status;
      console.error('[flight] AviationStack error:', code, info);

      // Give a plain-English message for the most common error codes
      if (code === 101) return res.status(401).json({ error: 'Invalid API key — double-check AVIATIONSTACK_KEY in Vercel.' });
      if (code === 102) return res.status(402).json({ error: 'API key inactive — activate it at aviationstack.com.' });
      if (code === 103 || code === 403) return res.status(403).json({ error: 'Your AviationStack plan does not support this request. The free plan requires HTTP-only access — this may be a plan restriction.' });
      if (code === 104) return res.status(429).json({ error: 'Monthly API request limit reached on your AviationStack plan.' });
      return res.status(400).json({ error: info || 'AviationStack returned an error.' });
    }

    if (!r.ok) throw new Error(`Upstream API returned HTTP ${r.status}`);

    const flights = (data.data || []).map(f => ({
      flightNum:     f.flight?.iata       || num.toUpperCase(),
      airline:       f.airline?.name      || '',
      originCode:    f.departure?.iata    || '',
      originAirport: f.departure?.airport || '',
      destCode:      f.arrival?.iata      || '',
      destAirport:   f.arrival?.airport   || '',
      departureTime: toHHMM(f.departure?.scheduled),
      arrivalTime:   toHHMM(f.arrival?.scheduled),
      status:        f.flight_status      || 'scheduled',
    }));

    res.json({ flights });
  } catch (e) {
    console.error('[flight] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

function toHHMM(iso) {
  if (!iso) return '';
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}
