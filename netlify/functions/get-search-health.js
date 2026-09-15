// netlify/functions/get-search-health.js
//
// Daily fusion of Guesty (reviews + calendar gaps) and PriceLabs (pricing +
// market position) data into a per-listing "Search Health" snapshot.
//
// TOKEN REUSE: this function reuses the exact same Guesty token cache
// (Supabase app_cache, key: 'guesty_token') that get-guesty-calendar.js
// uses. It does NOT request its own token — Guesty limits token issuance
// to 5/day account-wide, so every function must share one cached token.
// General Open API data calls are rate-limited separately (5,000/hour),
// so looping calendar calls per listing here is fine.
//
// Call this on a schedule (recommend once daily, e.g. 6 AM) via
// netlify.toml, same pattern as check-due-tasks.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PERqMlyz5OndCT7wVSUgGQ_T4Tpy_OQ';
const CACHE_KEY    = 'guesty_token';

let _mem = { token: null, expiresAt: 0 };

// ── Supabase helpers ────────────────────────────────────────────────────
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

// Generic upsert into any table, matched on a conflict target.
// Used for writing the daily snapshot rows.
async function sbUpsertRows(table, rows, onConflict) {
  if (!rows.length) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    console.error(`Upsert into ${table} failed:`, res.status, txt.slice(0, 300));
  }
}

// ── Guesty token management (identical pattern to get-guesty-calendar.js) ─
async function getToken() {
  const now = Date.now();
  const REFRESH_BEFORE_EXPIRY = 30 * 60 * 1000;

  if (_mem.token && now < _mem.expiresAt - REFRESH_BEFORE_EXPIRY) return _mem.token;

  try {
    const row = await sbGet(CACHE_KEY);
    if (row && row.value && row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (now < exp - REFRESH_BEFORE_EXPIRY) {
        _mem.token = row.value;
        _mem.expiresAt = exp;
        return _mem.token;
      }
    }
  } catch(e) {
    console.warn('Supabase cache read failed (non-fatal):', e.message);
  }

  const clientId     = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GUESTY_CLIENT_ID or GUESTY_CLIENT_SECRET env vars not set');

  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'open-api',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const raw = await res.text();
  if (res.status === 429) throw new Error('Guesty token rate limit hit (5/day max).');
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${raw}`);

  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error('Token not JSON: ' + raw.slice(0, 200)); }
  if (!data.access_token) throw new Error('No access_token in response');

  const ttlMs  = Math.min((data.expires_in || 86400) - 3600, 82800) * 1000;
  const expiry = now + ttlMs;
  _mem.token = data.access_token;
  _mem.expiresAt = expiry;

  try { await sbUpsert(CACHE_KEY, data.access_token, expiry); }
  catch(e) { console.warn('Supabase cache write failed (non-fatal):', e.message); }

  return _mem.token;
}

async function gGet(path, token) {
  const url = 'https://open-api.guesty.com' + path;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Guesty API ${res.status} on ${path.slice(0, 80)}: ${raw.slice(0, 300)}`);
  try { return JSON.parse(raw); }
  catch(e) { throw new Error('Non-JSON from ' + path.slice(0, 60)); }
}

// ── PriceLabs helper ────────────────────────────────────────────────────
async function plGet(path) {
  const apiKey = process.env.PRICE_LABS_SECRET;
  if (!apiKey) throw new Error('PRICE_LABS_SECRET env var not set');
  const url = 'https://api.pricelabs.co' + path;
  const res = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`PriceLabs API ${res.status} on ${path.slice(0, 80)}: ${raw.slice(0, 300)}`);
  try { return JSON.parse(raw); }
  catch(e) { throw new Error('Non-JSON from PriceLabs ' + path.slice(0, 60)); }
}

// ── Calendar gap analysis ───────────────────────────────────────────────
// Counts "orphan" gaps: runs of 1-3 unbooked nights between two booked/
// blocked stretches within the next 60 days. These are the nights most
// likely to sit empty because they're too short to attract a booking,
// and they're a direct drag on occupancy pace that PriceLabs then reads
// as "lower your price" without diagnosing the actual cause.
function analyzeGaps(days) {
  let gapCount = 0;
  let gapNights = 0;
  let runLength = 0;
  let sawBookedBefore = false;

  for (const day of days) {
    const blk = day.blocks || {};
    const isBooked = blk.b === true || blk.m === true || blk.o === true; // booked, manual, or owner block

    if (!isBooked) {
      runLength++;
    } else {
      if (sawBookedBefore && runLength > 0 && runLength <= 3) {
        gapCount++;
        gapNights += runLength;
      }
      runLength = 0;
      sawBookedBefore = true;
    }
  }
  return { gapCount, gapNights };
}

// ── Handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const today = new Date().toISOString().slice(0, 10);
  const gapFrom = today;
  const gapTo   = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

  const debugMode = (event.queryStringParameters || {}).debug === '1';
  const result = { date: today, listings: 0, errors: [] };

  try {
    const token = await getToken();

    // 1. Active listings
    const lData = await gGet(
      `/v1/listings?limit=100&fields=${encodeURIComponent('_id title nickname isListed status')}`,
      token
    );
    const allListings = lData.results || lData.data || (Array.isArray(lData) ? lData : []);
    const listings = allListings.filter(l => l.isListed === true || l.status === 'active');
    const listingIds = listings.map(l => l._id || l.id);
    result.listings = listings.length;

    // 2. Review averages (single batched call for all listings)
    let reviewRows = [];
    try {
      const qs = listingIds.map(id => `listingIds=${encodeURIComponent(id)}`).join('&');
      const revData = await gGet(`/v1/reviews/listings-average?${qs}`, token);
      const revList = revData.results || revData.data || (Array.isArray(revData) ? revData : []);
      reviewRows = revList.map(r => ({
        listing_id:    r.listingId || r._id,
        snapshot_date: today,
        review_count:  r.reviewsCount ?? r.count ?? null,
        avg_rating:    r.avgRating ?? r.averageRating ?? r.rating ?? null,
        raw:           r,
      }));
    } catch(e) {
      result.errors.push('reviews: ' + e.message);
    }
    await sbUpsertRows('guesty_review_snapshots', reviewRows, 'listing_id,snapshot_date');

    // 3. Calendar gap analysis (sequential per listing — data calls, not
    //    token calls, so the 5/day limit doesn't apply here)
    const gapRows = [];
    for (const listing of listings) {
      const lid = listing._id || listing.id;
      try {
        const calData = await gGet(
          `/v1/availability-pricing/api/calendar/listings/${lid}?startDate=${gapFrom}&endDate=${gapTo}`,
          token
        );
        const days = (calData.data && calData.data.days) || calData.days || [];
        const { gapCount, gapNights } = analyzeGaps(days);
        gapRows.push({
          listing_id: lid,
          snapshot_date: today,
          gap_count_60d: gapCount,
          gap_nights_60d: gapNights,
        });
      } catch(e) {
        result.errors.push(`calendar ${lid}: ${e.message}`);
      }
    }
    await sbUpsertRows('calendar_gap_snapshots', gapRows, 'listing_id,snapshot_date');

    // 4. PriceLabs pricing + market data
    const priceRows = [];
    try {
      const plData = await plGet('/v1/listings');
      const plListings = plData.listings || plData.data || (Array.isArray(plData) ? plData : []);
      if (debugMode) {
        result.pricelabsSample = plListings.slice(0, 2); // inspect real field names before trusting the mapping below
      }
      const pct = v => (v === null || v === undefined) ? null : parseFloat(String(v).replace('%', '').trim());
      for (const pl of plListings) {
        priceRows.push({
          listing_id:                pl.id,
          snapshot_date:             today,
          min_price:                 pl.min ?? null,
          max_price:                 pl.max ?? null,
          base_price:                pl.base ?? null,
          recommended_price:         pl.recommended_base_price ?? null,
          min_stay:                  pl.min_stay ?? null,
          occupancy_pct_7d:          pct(pl.occupancy_next_7),
          occupancy_pct_30d:         pct(pl.occupancy_next_30),
          occupancy_pct_60d:         pct(pl.occupancy_next_60),
          market_occupancy_pct_7d:   pct(pl.market_occupancy_next_7),
          market_occupancy_pct_30d:  pct(pl.market_occupancy_next_30),
          market_occupancy_pct_60d:  pct(pl.market_occupancy_next_60),
          cleaning_fee:              pl.cleaning_fees ?? null,
          last_refreshed_at:         pl.last_refreshed_at ?? null,
          raw:                       pl,
        });
      }
    } catch(e) {
      result.errors.push('pricelabs: ' + e.message);
    }
    await sbUpsertRows('pricelabs_daily', priceRows, 'listing_id,snapshot_date');

    result.reviewRows = reviewRows.length;
    result.gapRows = gapRows.length;
    result.priceRows = priceRows.length;

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch(err) {
    console.error('get-search-health error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, ...result }) };
  }
};
