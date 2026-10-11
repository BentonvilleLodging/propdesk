// netlify/functions/daily-recap-snapshot-background.js
//
// Daily data pull for the 8 AM "chief of staff" recap.
// Runs at 11:25 UTC, after get-search-health-background (11:00) has refreshed
// the cached Guesty token, so this normally spends ZERO of the 5/day token quota.
//
// Writes (via the secret-gated ingest_recap_data RPC — these tables have no
// anon policies, so reservation money never becomes readable with the
// publishable key):
//   booking_reservations  — every confirmed/canceled reservation with a stay
//                           from 45 days ago to 365 days out, incl. money fields
//   web_traffic_daily     — GA4 metrics for the last 3 days (re-pulled so late
//                           GA processing gets corrected)
//   listing_fee_config    — auto-adds any new Guesty listing at default fee
//
// Env vars:
//   RECAP_INGEST_SECRET   (required)
//   GUESTY_CLIENT_ID / GUESTY_CLIENT_SECRET (already set — only used if cache is stale)
//   GA4_PROPERTY_ID       (numeric GA4 property id, e.g. 412345678)
//   GA4_CLIENT_EMAIL      (service account email)
//   GA4_PRIVATE_KEY       (service account private key, PEM; \n escapes OK)
//   If the GA4 vars don't fit under Netlify's 4KB function-env limit, store them
//   in Supabase private.config instead (keys: ga4_property_id, ga4_client_email,
//   ga4_private_key) — this function falls back to reading them via RPC.
//
// Status is written to app_cache key 'recap_snapshot_last_run'.

const crypto = require('crypto');

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const { serverKey } = require('../lib/auth');
const SUPABASE_KEY = serverKey();
const CACHE_KEY = 'guesty_token';
const RUN_STATUS_KEY = 'recap_snapshot_last_run';

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
};

// ── Supabase helpers ────────────────────────────────────────────────────
async function sbGet(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/app_cache?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`,
    { headers: sbHeaders }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function sbUpsertCache(key, value, expiresAt) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_cache`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value, expires_at: new Date(expiresAt).toISOString() }),
  });
}

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify(args),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${fn} failed (${res.status}): ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch (e) { return txt; }
}

async function ingest(kind, rows) {
  if (!rows.length) return 0;
  let total = 0;
  // chunk to keep payloads small
  for (let i = 0; i < rows.length; i += 200) {
    total += await rpc('ingest_recap_data', {
      p_secret: process.env.RECAP_INGEST_SECRET,
      p_kind: kind,
      p_rows: rows.slice(i, i + 200),
    });
  }
  return total;
}

// ── Guesty ──────────────────────────────────────────────────────────────
async function getToken() {
  const now = Date.now();
  const REFRESH_BEFORE_EXPIRY = 30 * 60 * 1000;
  const row = await sbGet(CACHE_KEY).catch(() => null);
  if (row && row.value && row.expires_at) {
    const exp = new Date(row.expires_at).getTime();
    if (now < exp - REFRESH_BEFORE_EXPIRY) return row.value;
  }
  const clientId = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GUESTY_CLIENT_ID or GUESTY_CLIENT_SECRET env vars not set');
  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: clientId, client_secret: clientSecret }),
  });
  const raw = await res.text();
  if (res.status === 429) throw new Error('Guesty token rate limit hit (5/day max).');
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const expiry = now + Math.min((data.expires_in || 86400) - 3600, 82800) * 1000;
  await sbUpsertCache(CACHE_KEY, data.access_token, expiry).catch(() => {});
  return data.access_token;
}

async function gGet(path, token) {
  const res = await fetch('https://open-api.guesty.com' + path, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Guesty API ${res.status} on ${path.slice(0, 80)}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const day = (v) => (v ? String(v).slice(0, 10) : null);

async function pullReservations(token) {
  const now = Date.now();
  const from = new Date(now - 45 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now + 365 * 86400000).toISOString().slice(0, 10);

  // listing nicknames
  const lData = await gGet(`/v1/listings?limit=100&fields=${encodeURIComponent('_id nickname title isListed status')}`, token);
  const listings = lData.results || lData.data || [];
  const nick = {};
  for (const l of listings) nick[l._id] = l.nickname || l.title || l._id;

  const filters = JSON.stringify([
    { field: 'checkOut', operator: '$gte', value: from + 'T00:00:00.000Z' },
    { field: 'checkIn', operator: '$lte', value: to + 'T23:59:59.000Z' },
    { field: 'status', operator: '$in', value: ['confirmed', 'canceled'] },
  ]);
  const fields = '_id listingId checkIn checkOut nightsCount guestsCount status source createdAt confirmedAt canceledAt money';

  let all = [];
  let skip = 0;
  while (true) {
    const r = await gGet(
      `/v1/reservations?limit=100&skip=${skip}&sort=checkIn&fields=${encodeURIComponent(fields)}&filters=${encodeURIComponent(filters)}`,
      token
    );
    const batch = r.results || r.data || [];
    all = all.concat(batch);
    if (batch.length < 100) break;
    skip += 100;
    if (skip >= 3000) break;
  }

  const rows = all.map((r) => {
    const m = r.money || {};
    const accom = num(m.fareAccommodationAdjusted) ?? num(m.fareAccommodation);
    const channelFee = num(m.hostServiceFee) || 0;
    const checkIn = day(r.checkIn);
    const checkOut = day(r.checkOut);
    const nights = r.nightsCount ?? (checkIn && checkOut ? Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000) : null);
    return {
      reservation_id: r._id,
      listing_id: r.listingId,
      listing_nickname: nick[r.listingId] || null,
      status: r.status,
      source: r.source || null,
      created_at_guesty: r.createdAt || null,
      confirmed_at: r.confirmedAt || null,
      canceled_at: r.canceledAt || null,
      check_in: checkIn,
      check_out: checkOut,
      nights,
      guests: r.guestsCount ?? null,
      fare_accommodation: accom,
      fare_cleaning: num(m.fareCleaning),
      host_service_fee: num(m.hostServiceFee),
      total_taxes: num(m.totalTaxes),
      host_payout: num(m.hostPayout),
      net_income: num(m.netIncome),
      // Management-fee base: accommodation revenue net of channel fees, excluding cleaning
      commissionable_rev: accom !== null ? Math.round((accom - channelFee) * 100) / 100 : null,
      currency: m.currency || 'USD',
      money: {
        fareAccommodation: m.fareAccommodation, fareAccommodationAdjusted: m.fareAccommodationAdjusted,
        fareCleaning: m.fareCleaning, hostServiceFee: m.hostServiceFee, totalTaxes: m.totalTaxes,
        hostPayout: m.hostPayout, netIncome: m.netIncome, totalPaid: m.totalPaid, balanceDue: m.balanceDue,
      },
    };
  });

  const listingRows = listings
    .filter((l) => l.isListed === true || l.status === 'active')
    .map((l) => ({ listing_id: l._id, listing_nickname: l.nickname || l.title }));

  return { rows, listingRows };
}

// ── GA4 Data API (service-account JWT, no deps) ─────────────────────────
async function getGaConfig() {
  let propertyId = process.env.GA4_PROPERTY_ID;
  let clientEmail = process.env.GA4_CLIENT_EMAIL;
  let privateKey = process.env.GA4_PRIVATE_KEY;
  if (!propertyId || !clientEmail || !privateKey) {
    try {
      const cfg = await rpc('get_recap_config', { p_secret: process.env.RECAP_INGEST_SECRET });
      propertyId = propertyId || cfg.ga4_property_id;
      clientEmail = clientEmail || cfg.ga4_client_email;
      privateKey = privateKey || cfg.ga4_private_key;
    } catch (e) { /* fall through */ }
  }
  if (!propertyId || !clientEmail || !privateKey) return null;
  return { propertyId: String(propertyId).replace(/\D/g, ''), clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
}

async function gaToken(cfg) {
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({
    iss: cfg.clientEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(cfg.privateKey).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('GA4 auth failed: ' + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

async function gaReport(cfg, token, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${cfg.propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('GA4 report failed: ' + JSON.stringify(data).slice(0, 300));
  return data.rows || [];
}

async function pullWebTraffic() {
  const cfg = await getGaConfig();
  if (!cfg) return { skipped: 'GA4 credentials not configured' };
  const token = await gaToken(cfg);
  const range = { startDate: '3daysAgo', endDate: 'yesterday' };
  const gaDate = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

  const [core, events, sources, pages, cities] = await Promise.all([
    gaReport(cfg, token, {
      dateRanges: [range], dimensions: [{ name: 'date' }],
      metrics: ['sessions', 'totalUsers', 'newUsers', 'screenPageViews', 'engagedSessions', 'averageSessionDuration', 'bounceRate', 'purchaseRevenue'].map((name) => ({ name })),
    }),
    gaReport(cfg, token, {
      dateRanges: [range], dimensions: [{ name: 'date' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['begin_checkout', 'purchase', 'add_payment_info', 'view_item'] } } },
    }),
    gaReport(cfg, token, {
      dateRanges: [range], dimensions: [{ name: 'date' }, { name: 'sessionSourceMedium' }], metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 60,
    }),
    gaReport(cfg, token, {
      dateRanges: [range], dimensions: [{ name: 'date' }, { name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 60,
    }),
    gaReport(cfg, token, {
      dateRanges: [range], dimensions: [{ name: 'date' }, { name: 'city' }], metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 60,
    }),
  ]);

  const byDate = {};
  const get = (d) => (byDate[d] = byDate[d] || {
    traffic_date: d, sessions: 0, total_users: 0, new_users: 0, pageviews: 0, engaged_sessions: 0,
    avg_session_duration: null, bounce_rate: null, begin_checkout: 0, purchases: 0, purchase_revenue: 0,
    top_sources: [], top_pages: [], top_cities: [], _views: 0,
  });
  for (const r of core) {
    const d = get(gaDate(r.dimensionValues[0].value));
    const v = r.metricValues.map((x) => num(x.value));
    Object.assign(d, {
      sessions: v[0], total_users: v[1], new_users: v[2], pageviews: v[3], engaged_sessions: v[4],
      avg_session_duration: v[5], bounce_rate: v[6], purchase_revenue: v[7],
    });
  }
  for (const r of events) {
    const d = get(gaDate(r.dimensionValues[0].value));
    const ev = r.dimensionValues[1].value;
    const c = num(r.metricValues[0].value) || 0;
    if (ev === 'begin_checkout') d.begin_checkout = c;
    if (ev === 'purchase') d.purchases = c;
  }
  const pushTop = (rows, key, label) => {
    for (const r of rows) {
      const d = get(gaDate(r.dimensionValues[0].value));
      if (d[key].length < 8) d[key].push({ [label]: r.dimensionValues[1].value, count: num(r.metricValues[0].value) });
    }
  };
  pushTop(sources, 'top_sources', 'source');
  pushTop(pages, 'top_pages', 'path');
  pushTop(cities, 'top_cities', 'city');

  const rows = Object.values(byDate).map(({ _views, ...rest }) => rest);
  const n = await ingest('web', rows);
  return { webRows: n };
}

// ── Handler ─────────────────────────────────────────────────────────────
exports.handler = async function () {
  const result = { date: new Date().toISOString().slice(0, 10), errors: [] };
  if (!process.env.RECAP_INGEST_SECRET) {
    result.errors.push('RECAP_INGEST_SECRET env var not set');
    await sbUpsertCache(RUN_STATUS_KEY, JSON.stringify({ ...result, success: false, completedAt: new Date().toISOString() }), Date.now() + 86400000).catch(() => {});
    return;
  }

  try {
    const token = await getToken();
    const { rows, listingRows } = await pullReservations(token);
    result.reservationRows = await ingest('reservations', rows);
    result.listingRows = await ingest('listings', listingRows);
  } catch (e) {
    result.errors.push('guesty: ' + e.message);
  }

  try {
    Object.assign(result, await pullWebTraffic());
  } catch (e) {
    result.errors.push('ga4: ' + e.message);
  }

  result.success = result.errors.length === 0;
  await sbUpsertCache(RUN_STATUS_KEY, JSON.stringify({ ...result, completedAt: new Date().toISOString() }), Date.now() + 86400000).catch(() => {});
};
