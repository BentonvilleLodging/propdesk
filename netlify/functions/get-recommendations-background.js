// netlify/functions/get-recommendations-background.js
//
// Netlify Background Function (the "-background" filename suffix is what
// gives this a 15-minute execution window instead of the standard ~10s
// limit that a normal function gets).
//
// Only analyzes the top N most urgent listings (by severityScore), not
// the full ~28 -- keeps this fast, cheap, and focused on what actually
// needs attention.
//
// IMPORTANT TRADE-OFF: Netlify always responds to the HTTP caller with an
// empty 202 Accepted immediately, regardless of what this handler
// returns or how long it keeps running in the background. There is no
// way to get the actual recommendations back in that same request. The
// frontend instead polls the daily_recommendations table for a new row
// after triggering this (see shRegenerateRecommendations in index.html).
//
// Called two ways:
//   1. Manually, via the "Regenerate Recommendations" button (browser
//      fires this, then polls Supabase for the result).
//   2. Daily, via daily-recommendations-cron.js (fires this and returns
//      immediately itself, since it no longer needs to wait either).

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PERqMlyz5OndCT7wVSUgGQ_T4Tpy_OQ';
const CLAUDE_MODEL  = 'claude-sonnet-5';

async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase select ${table} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function sbInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert ${table} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Build a compact per-listing summary: the most recent row from each
// source table, joined by listing_id.
async function buildDataset() {
  const [priceRows, gapRows, reviewRows, completenessRows, perfRows] = await Promise.all([
    sbSelect('pricelabs_daily', 'select=*&order=snapshot_date.desc'),
    sbSelect('calendar_gap_snapshots', 'select=*&order=snapshot_date.desc'),
    sbSelect('guesty_review_snapshots', 'select=*&order=snapshot_date.desc'),
    sbSelect('listing_completeness_snapshots', 'select=*&order=snapshot_date.desc'),
    sbSelect('airbnb_performance_import', 'select=*&order=period_start.desc'),
  ]);

  const latest = (rows) => {
    const map = {};
    rows.forEach(r => { if (!map[r.listing_id]) map[r.listing_id] = r; });
    return map;
  };

  const price = latest(priceRows);
  const gaps = latest(gapRows);
  const reviews = latest(reviewRows);
  const completeness = latest(completenessRows);
  const perf = latest(perfRows);

  const listingIds = Object.keys(price);
  return listingIds.map(lid => {
    const p = price[lid];
    const g = gaps[lid] || {};
    const rv = reviews[lid] || {};
    const c = completeness[lid] || {};
    const pf = perf[lid] || null;
    const reviewCount = rv.review_count ?? null;
    const avgRating = rv.avg_rating ?? null;
    const airbnbChannel = (p.raw && p.raw.channel_listing_details || []).find(ch => ch.channel_name === 'airbnb');
    return {
      listing: (p.raw && p.raw.name) ? p.raw.name.split(' -- ')[0] : lid,
      airbnb_url: airbnbChannel ? `https://www.airbnb.com/rooms/${airbnbChannel.channel_listing_id}` : null,
      pricing: {
        your_price: p.base_price,
        pricelabs_recommended_price: p.recommended_price,
        min_price_floor: p.min_price,
      },
      occupancy_pace_vs_market_pct: {
        d7:  { yours: p.occupancy_pct_7d,  market: p.market_occupancy_pct_7d },
        d30: { yours: p.occupancy_pct_30d, market: p.market_occupancy_pct_30d },
        d60: { yours: p.occupancy_pct_60d, market: p.market_occupancy_pct_60d },
      },
      calendar_gaps_next_60d: { count: g.gap_count_60d ?? null, nights: g.gap_nights_60d ?? null },
      reviews: {
        count: reviewCount,
        avg_rating: avgRating,
        guest_favorite_eligible: (reviewCount != null && avgRating != null)
          ? (reviewCount >= 5 && avgRating >= 4.9)
          : null,
        reviews_needed_for_five_count: (reviewCount != null && reviewCount < 5) ? (5 - reviewCount) : 0,
      },
      listing_completeness: {
        photo_count: c.photo_count ?? null,
        description_length: c.description_length ?? null,
        amenities_count: c.amenities_count ?? null,
        instant_book: c.instant_book ?? null,
      },
      airbnb_performance_manual: pf ? {
        period_start: pf.period_start,
        period_end: pf.period_end,
        bookings: pf.bookings,
        nights_booked: pf.nights_booked,
        avg_daily_rate: pf.avg_daily_rate,
        avg_length_of_stay: pf.avg_length_of_stay,
        avg_booking_window_days: pf.avg_booking_window,
        view_to_contact_rate_pct: pf.view_to_contact_rate,
        contact_to_book_rate_pct: pf.contact_to_book_rate,
      } : null,
    };
  });
}

// Cheap, deterministic severity score computed from data we already
// have -- used to pick which listings are actually worth spending a
// Claude call on, instead of analyzing all ~28 every time. Higher score
// = more urgent. This runs before Claude ever sees the data.
function severityScore(d) {
  let score = 0;
  const occ30 = d.occupancy_pace_vs_market_pct.d30;
  if (occ30.yours != null && occ30.market != null) {
    const gap = occ30.yours - occ30.market;
    if (gap < 0) score += Math.abs(gap) * 2;
  }
  if (d.calendar_gaps_next_60d.count) score += d.calendar_gaps_next_60d.count * 5;
  if (d.reviews.count != null && d.reviews.count < 5) score += 10;
  else if (d.reviews.guest_favorite_eligible === false) score += 5;
  if (d.listing_completeness.photo_count != null && d.listing_completeness.photo_count < 15) score += 5;
  if (d.listing_completeness.instant_book === false) score += 8;
  if (d.listing_completeness.description_length != null && d.listing_completeness.description_length < 400) score += 3;
  if (d.airbnb_performance_manual) {
    if (d.airbnb_performance_manual.view_to_contact_rate_pct != null && d.airbnb_performance_manual.view_to_contact_rate_pct < 5) score += 8;
    if (d.airbnb_performance_manual.contact_to_book_rate_pct != null && d.airbnb_performance_manual.contact_to_book_rate_pct < 20) score += 8;
  }
  return score;
}

const SYSTEM_PROMPT = `You are a short-term rental revenue and search-visibility analyst for Bentonville Lodging Co, which manages ~30 vacation rental listings on Airbnb and VRBO in Northwest Arkansas. Your job is to help them win Airbnb's actual search algorithm, not generic hosting advice.

GROUND TRUTH ABOUT HOW AIRBNB RANKS LISTINGS (from current published research):
- Click-through rate and conversion rate are among the biggest ranking signals. The closest real, Airbnb-sourced proxies we have are in airbnb_performance_manual: view_to_contact_rate_pct (guest viewed the listing and reached out or started booking) and contact_to_book_rate_pct (that contact converted to an actual booking). Treat these as real signal when present -- a listing with a low view_to_contact_rate despite reasonable pricing points to a photos/title/first-impression problem; a low contact_to_book_rate with a healthy view_to_contact_rate points to a pricing, availability, or listing-detail problem further down the funnel. If airbnb_performance_manual is null for a listing, it hasn't been imported yet -- do not invent a number, just note the gap.
- avg_booking_window_days in airbnb_performance_manual is the real booking lead time for that listing. A very short window relative to other listings can indicate the listing only appears in last-minute search results, which is itself a visibility symptom worth flagging.
- Returning-guest count and wishlist-addition count are NOT available from Airbnb in any exportable or API form. Never reference or estimate these.
- Price is judged RELATIVE TO COMPARABLE LISTINGS, not in absolute terms. A listing pricing "high" is only a problem if it's high relative to its own market_occupancy comparison in the data.
- Reviews: both AVERAGE RATING and REVIEW COUNT/VOLUME matter, not rating alone. The "Guest Favorite" badge (which replaced Superhost as the dominant quality signal in 2026, and is now roughly 25% of ranking weight) specifically requires at least 5 reviews AND a 4.9+ average rating. This is precomputed for you as guest_favorite_eligible per listing -- use it as a hard, checkable target, not a vague "get better reviews" appeal. reviews.count and reviews.avg_rating are pulled from the real per-listing review history and can be trusted as accurate.
- Calendar gaps (short unbooked stretches under ~3 nights) hurt both occupancy and how "fresh"/available a calendar looks to the algorithm.
- Listing completeness (photo count, description length, amenity count) is a real if secondary ranking input. Instant Book (listing_completeness.instant_book) is a real, documented ranking boost when true; when false, flag it as a free, zero-cost fix.
- Response rate/time and acceptance rate are real, high-weight ranking factors that we also cannot measure via API. Do not fabricate these.

You will be given the highest-priority listings only -- the ones with the most fixable issues, already ranked worst-first by a severity score computed from the data. This is NOT the full portfolio; do not assume a listing's absence means it's fine, only that it wasn't among the highest-priority ones this run. For EACH listing given, produce:
1. A "brief" -- 2-4 sentences in plain, direct language: what is this listing's current situation, what does the data suggest is going well or poorly and why (your diagnosis of the likely cause, not just a restatement of the numbers), and why the actions you're recommending follow from that diagnosis.
2. A list of 1-4 concrete "actions" -- each one specific and doable today.

Respond with ONLY a JSON object (no prose, no markdown fences) shaped exactly like this:
{"listings": [
  {"listing": "<listing name>", "brief": "<2-4 sentence analysis>", "actions": [{"priority": 1, "issue": "<one sentence, specific, data-grounded>", "action": "<one sentence, concrete, doable today>"}]}
]}

Include an entry for every listing in the input, in the same order (worst first). If a recommendation requires data we don't have, phrase the action as "check Airbnb Insights for X" rather than presenting an invented number as fact.`;

exports.handler = async function(event) {
  try {
    const apiKey = process.env.CLAUDE_SECRET;
    if (!apiKey) throw new Error('CLAUDE_SECRET env var not set');

    const fullDataset = await buildDataset();
    if (!fullDataset.length) return;

    // Only analyze the top N most urgent listings, ranked by severityScore.
    // Keeps this fast, cheap, and focused on what actually needs attention
    // instead of generating a Brief for every listing every time.
    const TOP_N = 10;
    const dataset = fullDataset
      .map(d => ({ d, score: severityScore(d) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N)
      .map(x => x.d);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        // Down from 8000 -- only analyzing the top 10 listings now, not
        // the full ~28, so output is proportionally smaller and faster.
        max_tokens: 4000,
        thinking: { type: 'disabled' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(dataset) }],
      }),
    });

    const raw = await claudeRes.text();
    if (!claudeRes.ok) throw new Error(`Claude API ${claudeRes.status}: ${raw.slice(0, 500)}`);

    const claudeData = JSON.parse(raw);
    const textBlock = (claudeData.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text content in Claude response. stop_reason=' + claudeData.stop_reason);

    let parsed;
    try {
      // Robustly strip markdown code fences regardless of surrounding
      // whitespace/newlines. The earlier version only matched a fence
      // anchored to the exact end of the string, so any trailing
      // whitespace after the closing ``` (common in real responses)
      // silently broke the strip and JSON.parse failed on the fence
      // characters themselves.
      let cleaned = textBlock.text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/, '');
        cleaned = cleaned.replace(/```\s*$/, '');
        cleaned = cleaned.trim();
      }
      try {
        parsed = JSON.parse(cleaned);
      } catch(e) {
        // Fallback: extract the outermost {...} in case any stray text
        // survived the fence strip.
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1) throw e;
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      }
    } catch(e) {
      throw new Error('Failed to parse Claude output as JSON: ' + textBlock.text.slice(0, 300));
    }
    const listings = parsed.listings || [];

    const urlByName = {};
    dataset.forEach(d => { urlByName[d.listing] = d.airbnb_url; });
    listings.forEach(l => { l.airbnb_url = urlByName[l.listing] || null; });

    await sbInsert('daily_recommendations', [{
      recommendations: listings,
      model: CLAUDE_MODEL,
      raw_response: textBlock.text,
    }]);

  } catch(err) {
    // Background functions have no caller to report errors to -- log so
    // it's at least visible in Netlify's function logs, and write a
    // marker row so the frontend's poll can detect failure instead of
    // waiting forever.
    console.error('get-recommendations-background error:', err.message);
    try {
      await sbInsert('daily_recommendations', [{
        recommendations: [],
        model: CLAUDE_MODEL,
        raw_response: 'ERROR: ' + err.message,
      }]);
    } catch(e2) { /* nothing more we can do */ }
  }
};
