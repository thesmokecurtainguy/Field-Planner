// Uses AeroDataBox via RapidAPI (free tier: 2,000 requests/month)
// Sign up at rapidapi.com → search "AeroDataBox" → subscribe to free plan
// Add your key to Vercel env vars as RAPIDAPI_KEY
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'Flight API not configured — add RAPIDAPI_KEY to your Vercel environment variables. Sign up free at rapidapi.com and subscribe to AeroDataBox.'
    });
  }

  const { num, date } = req.query;
  if (!num) return res.status(400).json({ error: 'Flight number required' });

  // AeroDataBox endpoint: /flights/number/{flightNumber}/{date}
  const flightNum = num.replace(/\s+/g, '').toUpperCase();
  const flightDate = date || new Date().toISOString().slice(0, 10);
  const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(flightNum)}/${flightDate}`;

  try {
    const r = await fetch(url, {
      headers: {
        'X-RapidAPI-Key':  key,
        'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
      },
    });

    if (r.status === 401 || r.status === 403) {
      return res.status(r.status).json({ error: 'Invalid or unauthorized RapidAPI key. Check RAPIDAPI_KEY in Vercel.' });
    }
    if (r.status === 404) {
      return res.status(404).json({ error: `No flight found for ${flightNum} on ${flightDate}.` });
    }
    if (r.status === 429) {
      return res.status(429).json({ error: 'RapidAPI monthly limit reached. Upgrade your AeroDataBox plan.' });
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(r.status).json({ error: `API returned ${r.status}: ${body.slice(0, 200)}` });
    }

    const data = await r.json();
    const list = Array.isArray(data) ? data : [data];

    const flights = list.map(f => ({
      flightNum:     f.number         || flightNum,
      airline:       f.airline?.name  || '',
      originCode:    f.departure?.airport?.iata || '',
      originAirport: f.departure?.airport?.municipalityName || f.departure?.airport?.name || '',
      destCode:      f.arrival?.airport?.iata || '',
      destAirport:   f.arrival?.airport?.municipalityName || f.arrival?.airport?.name || '',
      departureTime: toHHMM(f.departure?.scheduledTimeLocal || f.departure?.scheduledTimeUtc),
      arrivalTime:   toHHMM(f.arrival?.scheduledTimeLocal   || f.arrival?.scheduledTimeUtc),
      status:        f.status || 'scheduled',
    }));

    res.json({ flights });
  } catch (e) {
    console.error('[flight] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

function toHHMM(str) {
  if (!str) return '';
  // Handles "2026-03-13 10:00-08:00", "2026-03-13T10:00:00Z", etc.
  const m = str.match(/[T\s](\d{2}:\d{2})/);
  return m ? m[1] : '';
}
