// netlify/functions/geocode.js
// Proxies Nominatim geocoding requests to avoid CORS issues from the browser

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const q = (event.queryStringParameters || {}).q;
  if (!q) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing q param' }) };

  try {
    // Try full address first
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'PropDesk/1.0 (bentonvillelodgingco.com)' } });
    const data = await r.json();

    if (data && data[0]) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name }) };
    }

    // Retry with just street + city (first two comma segments)
    const short = q.split(',').slice(0,2).join(',');
    if (short !== q) {
      const r2 = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(short)}`,
        { headers: { 'Accept-Language': 'en', 'User-Agent': 'PropDesk/1.0' } });
      const d2 = await r2.json();
      if (d2 && d2[0]) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ lat: parseFloat(d2[0].lat), lng: parseFloat(d2[0].lon), display: d2[0].display_name }) };
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ lat: null, lng: null }) };
  } catch(e) {
    console.error('geocode error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
