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

// ── Guesty Booking Engine API (separate credentials + token cache from
//    the Open API above -- this is what actually carries review data) ──
const BE_CACHE_KEY = 'guesty_be_token';
let _memBe = { token: null, expiresAt: 0 };

async function getBeToken() {
  const now = Date.now();
  const REFRESH_BEFORE_EXPIRY = 30 * 60 * 1000;

  if (_memBe.token && now < _memBe.expiresAt - REFRESH_BEFORE_EXPIRY) return _memBe.token;

  try {
    const row = await sbGet(BE_CACHE_KEY);
    if (row && row.value && row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (now < exp - REFRESH_BEFORE_EXPIRY) {
        _memBe.token = row.value;
        _memBe.expiresAt = exp;
        return _memBe.token;
      }
    }
  } catch(e) {
    console.warn('BE Supabase cache read failed (non-fatal):', e.message);
  }

  const clientId     = process.env.GUESTY_BE_CLIENT;
  const clientSecret = process.env.GUESTY_BE_SECRET;
  if (!clientId || !clientSecret) throw new Error('GUESTY_BE_CLIENT or GUESTY_BE_SECRET env vars not set');

  const res = await fetch('https://booking.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'booking_engine:api',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`BE token request failed (${res.status}): ${raw}`);

  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error('BE token not JSON: ' + raw.slice(0, 200)); }
  if (!data.access_token) throw new Error('No access_token in BE token response');

  // Booking Engine tokens last 24h and can only be renewed 3x/day --
  // cache conservatively, same pattern as the Open API token.
  const ttlMs  = Math.min((data.expires_in || 86400) - 3600, 82800) * 1000;
  const expiry = now + ttlMs;
  _memBe.token = data.access_token;
  _memBe.expiresAt = expiry;

  try { await sbUpsert(BE_CACHE_KEY, data.access_token, expiry); }
  catch(e) { console.warn('BE Supabase cache write failed (non-fatal):', e.message); }

  return _memBe.token;
}

async function gBeGet(path, token) {
  const url = 'https://booking.guesty.com' + path;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json; charset=utf-8' } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Guesty BE API ${res.status} on ${path.slice(0, 80)}: ${raw.slice(0, 300)}`);
  try { return JSON.parse(raw); }
  catch(e) { throw new Error('Non-JSON from BE ' + path.slice(0, 60)); }
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

    // 1. Active listings — includes reviews field directly, avoiding the
    // separate /v1/reviews/listings-average endpoint (which persistently
    // rejects its own documented array query param — a Guesty-side bug/
    // inconsistency, not a query formatting issue on our end).
    const lData = await gGet(
      `/v1/listings?limit=100&fields=${encodeURIComponent('_id title nickname isListed status reviews pictures publicDescription amenities')}`,
      token
    );
    const allListings = lData.results || lData.data || (Array.isArray(lData) ? lData : []);
    const listings = allListings.filter(l => l.isListed === true || l.status === 'active');
    const listingIds = listings.map(l => l._id || l.id);
    result.listings = listings.length;

    if (debugMode) {
      result.listingsReviewsSample = listings.slice(0, 2).map(l => ({ id: l._id, reviews: l.reviews }));
    }

    // 1b. Listing completeness — photo count, description length, amenity
    // count. A real (if moderate-weight) Airbnb ranking factor that was
    // sitting unused in data we already pull.
    const completenessRows = listings.map(l => {
      const lid = l._id || l.id;
      const photoCount = Array.isArray(l.pictures) ? l.pictures.length : 0;
      const desc = (l.publicDescription && (l.publicDescription.summary || l.publicDescription.description)) || '';
      const amenityCount = Array.isArray(l.amenities) ? l.amenities.length : 0;
      return {
        listing_id: lid,
        snapshot_date: today,
        photo_count: photoCount,
        description_length: desc.length,
        amenities_count: amenityCount,
        raw: { pictures: photoCount, description: desc.slice(0, 200), amenities: l.amenities || [] },
      };
    });
    await sbUpsertRows('listing_completeness_snapshots', completenessRows, 'listing_id,snapshot_date');
    result.completenessRows = completenessRows.length;

    // 2. Reviews — fetched via the Booking Engine API (separate credentials,
    // separate token). Open API's `reviews` field on /v1/listings is
    // always empty in this account, confirmed via debug run.
    let reviewRows = [];
    try {
      const beToken = await getBeToken();
      const beData = await gBeGet(
        `/api/listings?fields=${encodeURIComponent('_id title reviews')}&limit=100`,
        beToken
      );
      const beListings = beData.results || beData.data || (Array.isArray(beData) ? beData : []);
      if (debugMode) {
        result.beReviewsSample = beListings.slice(0, 3).map(l => ({ id: l._id, reviews: l.reviews }));
      }
      reviewRows = beListings
        .filter(l => l.reviews)
        .map(l => ({
          listing_id:    l._id || l.id,
          snapshot_date: today,
          review_count:  l.reviews.numberOfReviews ?? l.reviews.count ?? l.reviews.reviewsCount ?? l.reviews.total ?? null,
          avg_rating:    l.reviews.averageScore ?? l.reviews.avgRating ?? l.reviews.rating ?? l.reviews.score ?? null,
          raw:           l.reviews,
        }));
    } catch(e) {
      result.errors.push('reviews (booking engine): ' + e.message);
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

    // 5. Chain-call the recommendations engine so the daily scheduled run
    // also refreshes the AI recommendations, without making
    // get-recommendations.js itself a scheduled (and thus browser-blocked)
    // function. Non-fatal if this fails -- the sync itself already succeeded.
    try {
      const siteUrl = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
      const recRes = await fetch(`${siteUrl}/.netlify/functions/get-recommendations`);
      result.recommendationsTriggered = recRes.ok;
      if (!recRes.ok) result.errors.push('recommendations trigger: HTTP ' + recRes.status);
    } catch(e) {
      result.errors.push('recommendations trigger: ' + e.message);
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch(err) {
    console.error('get-search-health error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, ...result }) };
  }
};
