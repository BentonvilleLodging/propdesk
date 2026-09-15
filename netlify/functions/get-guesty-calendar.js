// netlify/functions/get-guesty-calendar.js
//
// TOKEN CACHING STRATEGY
// ──────────────────────
// Guesty limits to 5 token requests per API key per 24 hours.
// Netlify lambdas are stateless — module-level vars are lost on cold starts.
// Solution: cache the token in Supabase (table: app_cache, key: 'guesty_token').
// Every invocation reads from Supabase first; only fetches a new token when the
// cached one is missing or within 30 minutes of expiry.
// In-process cache (_mem) avoids a Supabase round-trip on warm lambdas.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PERqMlyz5OndCT7wVSUgGQ_T4Tpy_OQ';
const CACHE_KEY    = 'guesty_token';

// Warm-lambda in-process cache (survives reuse of the same instance)
let _mem = { token: null, expiresAt: 0 };

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbGet(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/app_cache?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function sbUpsert(key, value, expiresAt) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_cache`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, value, expires_at: new Date(expiresAt).toISOString() }),
  });
}

// ── Token management ──────────────────────────────────────────────────────────
async function getToken() {
  const now = Date.now();
  const REFRESH_BEFORE_EXPIRY = 30 * 60 * 1000; // refresh 30 min before expiry

  // 1. Check warm in-process cache first (free, instant)
  if (_mem.token && now < _mem.expiresAt - REFRESH_BEFORE_EXPIRY) {
    console.log('Token: using in-process cache');
    return _mem.token;
  }

  // 2. Check Supabase cache (survives cold starts, shared across instances)
  try {
    const row = await sbGet(CACHE_KEY);
    if (row && row.value && row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (now < exp - REFRESH_BEFORE_EXPIRY) {
        console.log('Token: using Supabase cache, expires', row.expires_at);
        _mem.token     = row.value;
        _mem.expiresAt = exp;
        return _mem.token;
      }
    }
  } catch(e) {
    console.warn('Supabase cache read failed (non-fatal):', e.message);
  }

  // 3. Fetch a fresh token from Guesty
  const clientId     = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GUESTY_CLIENT_ID or GUESTY_CLIENT_SECRET env vars not set');

  console.log('Token: fetching new token from Guesty...');
  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      scope:         'open-api',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  const raw = await res.text();

  // Guesty returns 429 when the daily token limit (5/day) is exceeded
  if (res.status === 429) {
    throw new Error('Guesty token rate limit hit (5/day max). Try again tomorrow or check Supabase app_cache table for a stale entry.');
  }
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${raw}`);

  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error('Token not JSON: ' + raw.slice(0, 200)); }
  if (!data.access_token) throw new Error('No access_token in response: ' + JSON.stringify(data).slice(0, 200));

  // expires_in is seconds; cache for 23 h (give 1 h buffer below 24 h)
  const ttlMs  = Math.min((data.expires_in || 86400) - 3600, 82800) * 1000;
  const expiry = now + ttlMs;

  // Store in both caches
  _mem.token     = data.access_token;
  _mem.expiresAt = expiry;

  try {
    await sbUpsert(CACHE_KEY, data.access_token, expiry);
    console.log('Token: cached in Supabase until', new Date(expiry).toISOString());
  } catch(e) {
    console.warn('Supabase cache write failed (non-fatal):', e.message);
  }

  return _mem.token;
}

// ── Guesty API helper ─────────────────────────────────────────────────────────
async function gGet(path, token) {
  const url = 'https://open-api.guesty.com' + path;
  console.log('GET', url.slice(0, 120));
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Guesty API ${res.status} on ${path.slice(0, 80)}: ${raw.slice(0, 300)}`);
  try { return JSON.parse(raw); }
  catch(e) { throw new Error('Non-JSON from ' + path.slice(0, 60) + ': ' + raw.slice(0, 200)); }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const params    = event.queryStringParameters || {};
  const todayMs   = Date.now();
  const fromDate  = params.from    || new Date(todayMs - 14 * 86400000).toISOString().slice(0, 10);
  const toDate    = params.to      || new Date(todayMs + 90 * 86400000).toISOString().slice(0, 10);
  const debugMode = params.debug === '1';
  // Pass ?clear_cache=1 to force a fresh token even if cache looks valid
  if (params.clear_cache === '1') { _mem.token = null; _mem.expiresAt = 0; }

  try {
    const token = await getToken();

    // ── 1. Active listings ─────────────────────────────────────────────
    const lData = await gGet(
      `/v1/listings?limit=100&fields=${encodeURIComponent('_id title nickname isListed status address')}`,
      token
    );
    // Guesty's isListed query param is unreliable — fetch all and filter ourselves.
    // isListed:true  = listed/active on booking channels
    // status:'active' = also used in some account configs
    // We keep a listing if EITHER isListed===true OR status==='active'
    const allListings = lData.results || lData.data || (Array.isArray(lData) ? lData : []);
    const listings = allListings.filter(l => l.isListed === true || l.status === 'active');
    console.log('all listings from API:', allListings.length);
    console.log('active listings after filter:', listings.length, listings.map(l => l.nickname || l.title).join(', '));
    if (listings.length > 0) {
      console.log('First listing full object:', JSON.stringify(listings[0]));
      console.log('First listing address:', JSON.stringify(listings[0].address));
    }
    if (debugMode) {
      console.log('ALL listing statuses:', JSON.stringify(allListings.map(l => ({
        name: l.nickname || l.title,
        isListed: l.isListed,
        status: l.status,
      }))));
    }

    // ── 2. Confirmed reservations ──────────────────────────────────────
    const resFilters = JSON.stringify([
      { field: 'checkIn',  operator: '$lte', value: toDate   + 'T23:59:59.000Z' },
      { field: 'checkOut', operator: '$gte', value: fromDate + 'T00:00:00.000Z' },
      { field: 'status',   operator: '$in',  value: ['confirmed'] },
    ]);
    const resFields = '_id listingId checkIn checkOut status source type notes numberOfGuests guest confirmationCode';

    let reservations = [];
    let skip = 0;
    while (true) {
      const rData = await gGet(
        `/v1/reservations?limit=100&skip=${skip}&sort=checkIn`
        + `&fields=${encodeURIComponent(resFields)}`
        + `&filters=${encodeURIComponent(resFilters)}`,
        token
      );
      const batch = rData.results || rData.data || (Array.isArray(rData) ? rData : []);
      console.log(`reservations skip=${skip}:`, batch.length);
      reservations = reservations.concat(batch);
      if (batch.length < 100) break;
      skip += 100;
      if (skip >= 500) break;
    }

    const normRes = reservations.map(r => ({
      _id:              r._id,
      listingId:        r.listingId,
      guestName:        (r.guest && r.guest.fullName) || r.guestName || '',
      checkIn:          (r.checkIn  || '').slice(0, 10),
      checkOut:         (r.checkOut || '').slice(0, 10),
      status:           r.status,
      source:           r.source,
      type:             r.type,
      notes:            r.notes || '',
      numberOfGuests:   r.numberOfGuests,
      confirmationCode: r.confirmationCode,
      isBlock:          false,
    }));

    // ── 3. Calendar blocks per listing (sequential to respect rate limits) ─
    // blocks.m = manual block, blocks.o = owner block
    const allBlocks = [];

    for (const listing of listings) {
      const lid = listing._id || listing.id;
      try {
        const calData = await gGet(
          `/v1/availability-pricing/api/calendar/listings/${lid}?startDate=${fromDate}&endDate=${toDate}`,
          token
        );
        const days = (calData.data && calData.data.days) || calData.days || [];

        let blockRun = null;
        const flushRun = () => {
          if (blockRun) { allBlocks.push(blockRun); blockRun = null; }
        };

        for (const day of days) {
          const blk      = day.blocks || {};
          const isManual = blk.m === true;
          const isOwnerB = blk.o === true;

          let note = '';
          if (day.blockRefs && day.blockRefs.length) {
            const ref = day.blockRefs[0];
            note = ref.reason || ref.blockReason || ref.note || ref.notes || '';
          }

          if (isManual || isOwnerB) {
            const bType = isOwnerB ? 'owner_block' : 'manual_block';
            if (blockRun && blockRun.blockType === bType) {
              blockRun.checkOut = day.date;
              if (note && !blockRun.notes) blockRun.notes = note;
            } else {
              flushRun();
              blockRun = {
                _id:       `block_${lid}_${day.date}`,
                listingId: lid,
                checkIn:   day.date,
                checkOut:  day.date,
                status:    'confirmed',
                source:    isOwnerB ? 'owner' : 'manual',
                blockType: bType,
                isBlock:   true,
                notes:     note,
                guestName: '',
              };
            }
          } else {
            flushRun();
          }
        }
        flushRun();

      } catch(e) {
        console.error(`Blocks error listing ${lid}:`, e.message);
      }
    }

    console.log('blocks found:', allBlocks.length);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        listings,
        reservations: normRes.concat(allBlocks),
        from: fromDate,
        to:   toDate,
        meta: {
          listingCount:     listings.length,
          reservationCount: normRes.length,
          blockCount:       allBlocks.length,
        },
        debug: debugMode ? {
          listingsSample:     listings.slice(0, 3),
          reservationsSample: normRes.slice(0, 2),
          blocksSample:       allBlocks.slice(0, 3),
        } : undefined,
      }),
    };

  } catch(err) {
    console.error('get-guesty-calendar error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
