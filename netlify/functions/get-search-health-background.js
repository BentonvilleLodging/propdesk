// netlify/functions/get-search-health-background.js
//
// LISTING INTELLIGENCE — data collection (Background Function, 15-min window).
// Scheduled daily at 11:00 UTC (6 AM Central) and triggered by "Sync Now".
//
// Pipeline (each step is independent; a failure is logged and the run continues):
//   1. Guesty listings  → listing_registry (source of truth for which listings are live)
//   2. Completeness     → listing_completeness_snapshots (photos, description, amenities)
//   3. Calendar gaps    → calendar_gap_snapshots (orphan gaps ≤3 nights, next 60 days)
//   4. Reviews (ALL channels, Guesty Open API /v1/reviews) → guesty_reviews (full text +
//      category ratings) and guesty_review_snapshots (count / avg rating / recency)
//   5. PriceLabs listings → pricelabs_daily (base/min/max/recommended, occupancy vs market)
//   6. PriceLabs enrichment → pricelabs_intel: listing_metrics, neighborhood_data,
//      customizations (current settings), Listing Optimizer report + Airbnb search ranking,
//      and a 90-day calendar summary from listing_prices (demand, open nights, min stays)
//
// Only listings that are LISTED in Guesty and not hidden by staff (listing_registry.tracked)
// are collected. Run status is written to app_cache 'search_health_last_run'.

const { requireTeam, isScheduledInvocation } = require('../lib/auth');
const I = require('../lib/intel');

const RUN_STATUS_KEY = 'search_health_last_run';

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace('%', '')); return Number.isFinite(n) ? n : null; };
const round = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0));
const avg = (arr) => { const a = arr.filter((x) => x != null && Number.isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };

// ── Reviews normalization (Airbnb / Vrbo / Booking.com shapes differ) ───
function to5(v, scaleMax) {
  const n = num(v);
  if (n == null) return null;
  if (scaleMax === 10 || n > 5) return round(n / 2, 2);
  return n;
}

function normalizeReview(r) {
  const raw = r.rawReview || r.raw || {};
  const channel = r.channelId || r.channel || raw.channel || null;
  const isBooking = /booking/i.test(channel || '');
  let rating = null;
  if (raw.overall_rating != null) rating = to5(raw.overall_rating);
  else if (raw.scoring && raw.scoring.review_score != null) rating = to5(raw.scoring.review_score, 10);
  else if (raw.rating != null) rating = to5(raw.rating, isBooking ? 10 : 5);
  else if (raw.overallRating != null) rating = to5(raw.overallRating, isBooking ? 10 : 5);
  else if (r.rating != null) rating = to5(r.rating, isBooking ? 10 : 5);

  const cats = {};
  const catSrc = raw.category_ratings || raw.categoryRatings || raw.ratings || (raw.scoring && raw.scoring.categories) || null;
  if (Array.isArray(catSrc)) {
    catSrc.forEach((c) => { const k = (c.category || c.name || c.type || '').toString().toLowerCase(); const v = to5(c.rating != null ? c.rating : c.value, isBooking ? 10 : 5); if (k && v != null) cats[k] = v; });
  } else if (catSrc && typeof catSrc === 'object') {
    Object.keys(catSrc).forEach((k) => { const v = to5(catSrc[k], isBooking ? 10 : 5); if (v != null && k.toLowerCase() !== 'overall') cats[k.toLowerCase()] = v; });
  }

  let text = raw.public_review || raw.publicReview || raw.reviewText || raw.review_text || raw.text || raw.comments || null;
  if (!text && raw.content && typeof raw.content === 'object') {
    text = [raw.content.headline, raw.content.positive && ('Liked: ' + raw.content.positive), raw.content.negative && ('Disliked: ' + raw.content.negative)].filter(Boolean).join(' — ') || null;
  }
  if (!text && typeof raw.content === 'string') text = raw.content;
  const privateFb = raw.private_feedback || raw.privateFeedback || raw.private_review || null;
  let reply = null;
  if (Array.isArray(r.reviewReplies) && r.reviewReplies.length) reply = r.reviewReplies[0].body || r.reviewReplies[0].text || null;
  if (!reply) reply = raw.reviewee_response || raw.host_response || null;

  return {
    review_id: String(r._id || r.id || r.externalReviewId || `${r.listingId}-${r.createdAt}`),
    listing_id: r.listingId,
    channel,
    reservation_id: r.reservationId || r.externalReservationId || null,
    reviewed_at: r.createdAt || raw.submitted_at || raw.created_at || r.updatedAt || null,
    rating_5: rating,
    category_ratings: Object.keys(cats).length ? cats : null,
    public_review: text ? String(text).slice(0, 4000) : null,
    private_feedback: privateFb ? String(privateFb).slice(0, 2000) : null,
    host_reply: reply ? String(reply).slice(0, 2000) : null,
    raw: { channelId: channel, rawReview: raw },
  };
}

function analyzeGaps(days) {
  let gapCount = 0, gapNights = 0, run = 0, sawBooked = false;
  for (const day of days) {
    const blk = day.blocks || {};
    const booked = blk.b === true || blk.m === true || blk.o === true || (day.status && day.status !== 'available');
    if (!booked) run++;
    else { if (sawBooked && run > 0 && run <= 3) { gapCount++; gapNights += run; } run = 0; sawBooked = true; }
  }
  return { gapCount, gapNights };
}

// ── PriceLabs summarizers (shapes per developers.pricelabs.co; defensive) ─
function summarizeNeighborhood(nd, bedrooms) {
  const d = (nd && nd.data) || nd || {};
  const out = { source: d['Neighborhood Data Source'] || d.source || null, listings_used: d['Listings Used'] || null };
  const pickCat = (block) => {
    if (!block || !block.Category) return null;
    const cats = block.Category;
    const key = bedrooms != null && cats[String(bedrooms)] ? String(bedrooms) : (cats.All ? 'All' : Object.keys(cats)[0]);
    return { key, cat: cats[key], labels: block.Labels || cats[key] && cats[key].Labels || [] };
  };
  try {
    const sb = pickCat(d['Summary Table Base Price']);
    if (sb && sb.cat && Array.isArray(sb.cat.Y_values)) {
      const labels = sb.labels.length ? sb.labels : ['p25', 'p50', 'p75', 'p90'];
      out.base_price_percentiles = { category: sb.key };
      labels.forEach((l, i) => { const k = /25/.test(l) ? 'p25' : /50/.test(l) ? 'p50' : /75/.test(l) ? 'p75' : /90/.test(l) ? 'p90' : l; out.base_price_percentiles[k] = num(sb.cat.Y_values[i]); });
    }
  } catch (e) { out.base_price_err = e.message; }
  try {
    const fp = pickCat(d['Future Percentile Prices']);
    if (fp && fp.cat && Array.isArray(fp.cat.Y_values)) {
      const labels = fp.labels;
      const next = (series, n) => avg((series || []).slice(0, n).map(num));
      out.future_prices_next30 = { category: fp.key };
      labels.forEach((l, i) => { const k = /25/.test(l) ? 'p25' : /50/.test(l) ? 'p50' : /75/.test(l) ? 'p75' : /90/.test(l) ? 'p90' : /Booked/i.test(l) ? 'median_booked' : l; out.future_prices_next30[k] = round(next(fp.cat.Y_values[i], 30), 0); });
    }
  } catch (e) { out.future_prices_err = e.message; }
  try {
    const fo = pickCat(d['Future Occ/New/Canc']);
    if (fo && fo.cat && Array.isArray(fo.cat.Y_values)) {
      const labels = fo.labels;
      const idx = (re) => labels.findIndex((l) => re.test(l));
      const occ = fo.cat.Y_values[idx(/^Occupancy$/)] || [];
      const stly = fo.cat.Y_values[idx(/STLY/)] || [];
      out.market_occupancy = {
        next14: round(avg(occ.slice(0, 14).map(num)), 1), next30: round(avg(occ.slice(0, 30).map(num)), 1), next60: round(avg(occ.slice(0, 60).map(num)), 1),
        stly_next30: round(avg(stly.slice(0, 30).map(num)), 1),
      };
    }
  } catch (e) { out.market_occ_err = e.message; }
  return out;
}

function summarizeCalendar(entry) {
  const days = (entry && entry.data) || [];
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const s = { horizon_days: days.length, windows: {}, demand_open_next60: {}, min_stay_counts: {}, open_weekend_nights_next30: 0, high_demand_open_next60: [], last_refreshed_at: entry && entry.last_refreshed_at };
  const isBooked = (d) => /booked/i.test(d.booking_status || '') || d.unbookable === 1 || d.unbookable === true;
  [14, 30, 60, 90].forEach((n) => {
    const w = days.slice(0, n);
    const open = w.filter((d) => !isBooked(d));
    const booked = w.filter((d) => isBooked(d));
    s.windows['next' + n] = {
      open_nights: open.length, booked_nights: booked.length,
      occupancy_pct: w.length ? round((booked.length / w.length) * 100, 0) : null,
      avg_open_price: round(avg(open.map((d) => num(d.price))), 0),
      avg_booked_adr: round(avg(booked.map((d) => num(d.ADR))), 0),
      stly_booked_nights: w.filter((d) => /booked/i.test(d.booking_status_STLY || '')).length,
    };
  });
  days.slice(0, 60).forEach((d) => {
    if (isBooked(d)) return;
    const k = d.demand_desc || 'Unknown';
    s.demand_open_next60[k] = (s.demand_open_next60[k] || 0) + 1;
    if (/high|very/i.test(k) && s.high_demand_open_next60.length < 12) s.high_demand_open_next60.push({ date: d.date, price: num(d.price), demand: k });
    const ms = d.min_stay != null ? String(d.min_stay) : '?';
    s.min_stay_counts[ms] = (s.min_stay_counts[ms] || 0) + 1;
  });
  days.slice(0, 30).forEach((d) => { const dow = new Date(d.date + 'T12:00:00').getDay(); if ((dow === 5 || dow === 6) && !isBooked(d)) s.open_weekend_nights_next30++; });
  return s;
}

function summarizeRanking(rk) {
  const d = (rk && rk.data) || rk || {};
  const cur = d.current_rankings || {};
  const ranks = [], pages = [];
  (cur.segments || []).forEach((seg) => { Object.values(seg.dates || {}).forEach((x) => { if (x && x.rank != null) ranks.push(num(x.rank)); if (x && x.page != null) pages.push(num(x.page)); }); });
  return {
    updated_at: cur.updated_at || null, neighborhood_count: d.neighborhood_count || null,
    best_rank: cur.current_rank_min != null ? num(cur.current_rank_min) : (ranks.length ? Math.min(...ranks) : null),
    avg_rank: round(avg(ranks), 1), avg_page: round(avg(pages), 1), pct_dates_page1: pages.length ? round((pages.filter((p) => p === 1).length / pages.length) * 100, 0) : null,
    segments: (cur.segments || []).map((s) => ({ guest_count: s.guest_count, los: s.los })).slice(0, 6),
  };
}

function trimOptimizer(op) {
  const d = (op && op.data) || op || {};
  if (d.payment_restricted) return { payment_restricted: true };
  const scores = d.scores || {};
  const out = { overall_score: scores.overall_score != null ? scores.overall_score : d.overall_score, categories: {} };
  Object.keys(scores).forEach((k) => { if (k === 'overall_score') return; const c = scores[k] || {}; out.categories[k] = { score: c.score, tip: c.improvements || c.description || null }; });
  if (d.previous_scores) out.previous_overall = d.previous_scores.overall_score;
  return out;
}

exports.handler = async function (event) {
  if (!isScheduledInvocation(event) && !(await requireTeam(event, ['staff']))) { console.warn('search-health: unauthorized call ignored'); return; }
  const day = I.today();
  const result = { date: day, listings: 0, errors: [], steps: {} };
  const rawSamples = {};
  const err = (m) => { console.warn(m); if (result.errors.length < 60) result.errors.push(String(m).slice(0, 300)); };

  try {
    // 1. Registry ────────────────────────────────────────────────────────
    const lData = await I.guestyGet(`/v1/listings?limit=100&fields=${encodeURIComponent('_id title nickname isListed active status listingType bedrooms accommodates pictures publicDescription amenities integrations')}`);
    const all = lData.results || lData.data || (Array.isArray(lData) ? lData : []);
    const existing = await I.sbSelect('listing_registry', 'select=listing_id,tracked').catch(() => []);
    const trackedMap = {}; existing.forEach((r) => { trackedMap[r.listing_id] = r.tracked; });
    const airbnbIdOf = (l) => {
      const ints = Array.isArray(l.integrations) ? l.integrations : [];
      const a = ints.find((x) => /airbnb/i.test(x.platform || ''));
      return a ? String((a.airbnb2 && (a.airbnb2.id || a.airbnb2.listingId)) || a.externalListingId || a.externalId || '') || null : null;
    };
    const vrboIdOf = (l) => {
      const ints = Array.isArray(l.integrations) ? l.integrations : [];
      const v = ints.find((x) => /homeaway|vrbo/i.test(x.platform || ''));
      return v ? String((v.homeaway2 && (v.homeaway2.id || v.homeaway2.listingId)) || v.externalListingId || '') || null : null;
    };
    await I.sbUpsert('listing_registry', all.map((l) => ({
      listing_id: l._id, nickname: l.nickname || null, title: l.title || null,
      is_listed: l.isListed === true, guesty_status: l.status || (l.active === false ? 'inactive' : null),
      bedrooms: num(l.bedrooms), accommodates: num(l.accommodates),
      airbnb_listing_id: airbnbIdOf(l), vrbo_listing_id: vrboIdOf(l),
      tracked: trackedMap[l._id] !== undefined ? trackedMap[l._id] : true,
      updated_at: new Date().toISOString(),
    })), 'listing_id');
    const listings = all.filter((l) => l.isListed === true && trackedMap[l._id] !== false);
    const live = new Set(listings.map((l) => l._id));
    result.listings = listings.length;
    result.steps.registry = { total: all.length, tracked: listings.length };

    // 2. Completeness ────────────────────────────────────────────────────
    try {
      const rows = listings.map((l) => {
        const desc = (l.publicDescription && [l.publicDescription.summary, l.publicDescription.space, l.publicDescription.neighborhood, l.publicDescription.access].filter(Boolean).join('\n')) || '';
        const pics = Array.isArray(l.pictures) ? l.pictures : [];
        return {
          listing_id: l._id, snapshot_date: day, photo_count: pics.length, description_length: desc.length,
          amenities_count: Array.isArray(l.amenities) ? l.amenities.length : 0, instant_book: null,
          cover_photo_url: pics[0] ? (pics[0].original || pics[0].thumbnail || null) : null,
          raw: { title: l.title, title_length: (l.title || '').length, summary: (l.publicDescription && l.publicDescription.summary || '').slice(0, 600), amenities: l.amenities || [], photo_captions_missing: pics.filter((p) => !p.caption).length },
        };
      });
      await I.sbUpsert('listing_completeness_snapshots', rows, 'listing_id,snapshot_date');
      result.steps.completeness = rows.length;
    } catch (e) { err('completeness: ' + e.message); }

    // 3. Calendar gaps ───────────────────────────────────────────────────
    try {
      const from = day, to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
      const rows = [];
      for (const l of listings) {
        try {
          const cal = await I.guestyGet(`/v1/availability-pricing/api/calendar/listings/${l._id}?startDate=${from}&endDate=${to}`);
          const days = (cal.data && cal.data.days) || cal.days || [];
          const g = analyzeGaps(days);
          rows.push({ listing_id: l._id, snapshot_date: day, gap_count_60d: g.gapCount, gap_nights_60d: g.gapNights });
        } catch (e) { err(`calendar ${l.nickname || l._id}: ${e.message}`); }
      }
      await I.sbUpsert('calendar_gap_snapshots', rows, 'listing_id,snapshot_date');
      result.steps.calendar = rows.length;
    } catch (e) { err('calendar: ' + e.message); }

    // 4. Reviews — all channels via Guesty Open API ─────────────────────
    try {
      const reviewRows = [], snapRows = [];
      for (const l of listings) {
        try {
          let all = [], skip = 0;
          while (skip < 1000) {
            const r = await I.guestyGet(`/v1/reviews?listingId=${l._id}&limit=100&skip=${skip}`);
            const d = r.data;
            const batch = Array.isArray(d) ? d : (d && (d.data || d.reviews || d.results)) || (Array.isArray(r.results) ? r.results : []);
            if (!rawSamples.review && batch.length) rawSamples.review = batch[0];
            all = all.concat(batch);
            if (batch.length < 100) break;
            skip += 100;
          }
          const norm = all.map((x) => normalizeReview({ ...x, listingId: x.listingId || l._id })).filter((x) => x.listing_id === l._id);
          reviewRows.push(...norm);
          const rated = norm.filter((x) => x.rating_5 != null);
          const airbnb = rated.filter((x) => /airbnb/i.test(x.channel || ''));
          const last = norm.map((x) => x.reviewed_at).filter(Boolean).sort().pop() || null;
          snapRows.push({
            listing_id: l._id, snapshot_date: day, review_count: norm.length,
            avg_rating: rated.length ? round(avg(rated.map((x) => x.rating_5)), 3) : null,
            last_review_date: last ? last.slice(0, 10) : null,
            days_since_review: last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null,
            raw: { by_channel: norm.reduce((m, x) => { m[x.channel || 'unknown'] = (m[x.channel || 'unknown'] || 0) + 1; return m; }, {}), airbnb_count: airbnb.length, airbnb_avg: airbnb.length ? round(avg(airbnb.map((x) => x.rating_5)), 3) : null },
          });
        } catch (e) { err(`reviews ${l.nickname || l._id}: ${e.message}`); }
      }
      await I.sbUpsert('guesty_reviews', reviewRows, 'review_id');
      await I.sbUpsert('guesty_review_snapshots', snapRows, 'listing_id,snapshot_date');
      result.steps.reviews = { listings: snapRows.length, reviews: reviewRows.length };
    } catch (e) { err('reviews: ' + e.message); }

    // 5. PriceLabs listings ──────────────────────────────────────────────
    let plListings = [];
    try {
      const pl = await I.plGet('/v1/listings');
      plListings = (pl.listings || pl.data || (Array.isArray(pl) ? pl : [])).filter((p) => live.has(String(p.id)));
      const rows = plListings.map((p) => ({
        listing_id: String(p.id), snapshot_date: day,
        min_price: num(p.min), max_price: num(p.max), base_price: num(p.base), recommended_price: num(p.recommended_base_price), min_stay: num(p.min_stay),
        occupancy_pct_7d: num(p.occupancy_next_7), occupancy_pct_30d: num(p.occupancy_next_30), occupancy_pct_60d: num(p.occupancy_next_60),
        market_occupancy_pct_7d: num(p.market_occupancy_next_7), market_occupancy_pct_30d: num(p.market_occupancy_next_30), market_occupancy_pct_60d: num(p.market_occupancy_next_60),
        cleaning_fee: num(p.cleaning_fees), last_refreshed_at: p.last_refreshed_at || null, raw: p,
      }));
      await I.sbUpsert('pricelabs_daily', rows, 'listing_id,snapshot_date');
      result.steps.pricelabs = rows.length;
    } catch (e) { err('pricelabs listings: ' + e.message); }

    // 6. PriceLabs enrichment ────────────────────────────────────────────
    try {
      const pms = (p) => p.pms || 'guesty';
      // 90-day price calendar for all listings in one request
      let calMap = {};
      try {
        const dateTo = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
        const lp = await I.plPost('/v1/listing_prices', { listings: plListings.map((p) => ({ id: String(p.id), pms: pms(p), dateFrom: day, dateTo })) });
        const arr = Array.isArray(lp) ? lp : (lp.data || []);
        if (arr[0]) rawSamples.listing_prices = { ...arr[0], data: (arr[0].data || []).slice(0, 2) };
        arr.forEach((e) => { calMap[String(e.id)] = e; });
      } catch (e) { err('listing_prices: ' + e.message); }

      const regRows = await I.sbSelect('listing_registry', 'select=listing_id,bedrooms,airbnb_listing_id');
      const reg = {}; regRows.forEach((r) => { reg[r.listing_id] = r; });

      const intelRows = [];
      for (const p of plListings) {
        const lid = String(p.id);
        const errors = [];
        const q = `listing_id=${encodeURIComponent(lid)}&pms=${encodeURIComponent(pms(p))}`;
        const q2 = `listing_id=${encodeURIComponent(lid)}&pms_name=${encodeURIComponent(pms(p))}`;
        const airbnbId = (reg[lid] && reg[lid].airbnb_listing_id) || ((p.channel_listing_details || []).find((c) => c.channel_name === 'airbnb') || {}).channel_listing_id || null;
        const row = { listing_id: lid, snapshot_date: day };
        try { const m = await I.plGet(`/v1/listing_metrics?${q2}`); row.metrics = m.data || m; if (!rawSamples.metrics) rawSamples.metrics = row.metrics; } catch (e) { errors.push('metrics: ' + e.message); }
        try { const nd = await I.plGet(`/v1/neighborhood_data?${q}`); if (!rawSamples.neighborhood) rawSamples.neighborhood = JSON.stringify(nd).slice(0, 6000); row.neighborhood = summarizeNeighborhood(nd, reg[lid] ? reg[lid].bedrooms : num(p.no_of_bedrooms)); } catch (e) { errors.push('neighborhood: ' + e.message); }
        try { const c = await I.plGet(`/v1/customizations/listing?${q2}&toggled_on=false`); row.customizations = c.customizations || (c.data && c.data.customizations) || c.data || c; if (!rawSamples.customizations) rawSamples.customizations = JSON.stringify(row.customizations).slice(0, 6000); } catch (e) { errors.push('customizations: ' + e.message); }
        if (airbnbId) {
          try { const o = await I.plGet(`/v1/listing_optimizer/report?listing_id=${encodeURIComponent(airbnbId)}`); row.optimizer = trimOptimizer(o); if (!rawSamples.optimizer) rawSamples.optimizer = o; } catch (e) { errors.push('optimizer: ' + e.message); }
          try { const r = await I.plGet(`/v1/listing_optimizer/ranking?listing_id=${encodeURIComponent(airbnbId)}`); row.ranking = summarizeRanking(r); if (!rawSamples.ranking) rawSamples.ranking = JSON.stringify(r).slice(0, 4000); } catch (e) { errors.push('ranking: ' + e.message); }
        } else errors.push('no Airbnb listing id for optimizer/ranking');
        if (calMap[lid]) row.calendar = summarizeCalendar(calMap[lid]);
        row.errors = errors.length ? errors : null;
        intelRows.push(row);
      }
      await I.sbUpsert('pricelabs_intel', intelRows, 'listing_id,snapshot_date');
      const errCounts = {};
      intelRows.forEach((r) => (r.errors || []).forEach((e) => { const k = e.split(':')[0]; errCounts[k] = (errCounts[k] || 0) + 1; }));
      result.steps.pricelabs_intel = { rows: intelRows.length, endpoint_errors: errCounts };
      if (Object.keys(errCounts).length) err('pricelabs enrichment partial: ' + JSON.stringify(errCounts));
    } catch (e) { err('pricelabs enrichment: ' + e.message); }

    // keep legacy counters the UI shows
    result.priceRows = result.steps.pricelabs || 0;
    result.gapRows = result.steps.calendar || 0;
    result.reviewRows = (result.steps.reviews && result.steps.reviews.listings) || 0;
    result.completenessRows = result.steps.completeness || 0;
    result.success = true;
  } catch (e) {
    result.success = false;
    result.fatalError = e.message;
    console.error('search-health fatal:', e.message);
  }

  await I.cacheSet('intel_raw_samples', rawSamples, 14 * 86400000).catch(() => {});
  await I.cacheSet(RUN_STATUS_KEY, { ...result, completedAt: new Date().toISOString() }, 2 * 86400000).catch(() => {});
};

exports._test = { normalizeReview, summarizeNeighborhood, summarizeCalendar, summarizeRanking, trimOptimizer };
