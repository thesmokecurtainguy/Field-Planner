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
    if (!r.ok) throw new Error(`Upstream API returned ${r.status}`);
    const data = await r.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Flight API error' });
    }

    const flights = (data.data || []).map(f => ({
      flightNum:     f.flight?.iata    || num.toUpperCase(),
      airline:       f.airline?.name   || '',
      originCode:    f.departure?.iata    || '',
      originAirport: f.departure?.airport || '',
      destCode:      f.arrival?.iata    || '',
      destAirport:   f.arrival?.airport || '',
      departureTime: toHHMM(f.departure?.scheduled),
      arrivalTime:   toHHMM(f.arrival?.scheduled),
      status:        f.flight_status || 'scheduled',
    }));

    res.json({ flights });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function toHHMM(iso) {
  if (!iso) return '';
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}
