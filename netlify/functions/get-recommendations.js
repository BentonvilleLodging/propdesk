// netlify/functions/get-recommendations.js
//
// Pulls the latest pricing/occupancy/gap/review data and asks Claude to
// generate prioritized, concrete daily actions for the team. Deliberately
// NOT scheduled in netlify.toml -- it's called two ways:
//   1. Manually, via a "Regenerate" button on the Search Health page
//      (direct browser fetch -- this is why it's unscheduled; Netlify
//      blocks direct HTTP calls to scheduled functions).
//   2. Automatically once a day, triggered internally by
//      get-search-health.js right after it finishes its own sync
//      (server-to-server fetch, same pattern check-due-tasks.js uses
//      to call send-push.js).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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
// source table, joined by listing_id. Keeping this tight matters --
// every extra token here is cost on every run.
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
    return {
      listing: (p.raw && p.raw.name) ? p.raw.name.split(' -- ')[0] : lid,
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
        // Airbnb's "Guest Favorite" badge requires >=5 reviews AND a >=4.9
        // average rating. This is a real, checkable threshold -- not a
        // vague "get better reviews" target.
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
      // Manually imported from Airbnb's real CSV export (Insights ->
      // Performance -> Download CSV). This is the ONLY source for these
      // numbers -- Airbnb exposes no API for them. null means it hasn't
      // been imported yet, NOT that the listing has zero activity.
      // view_to_contact_rate and contact_to_book_rate together are the
      // real two-stage conversion funnel; avg_booking_window is the real
      // lead time metric. Returning-guest count and wishlist-addition
      // count are NOT available from Airbnb in any exportable form.
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

const SYSTEM_PROMPT = `You are a short-term rental revenue and search-visibility analyst for Bentonville Lodging Co, which manages ~30 vacation rental listings on Airbnb and VRBO in Northwest Arkansas. Your job is to help them win Airbnb's actual search algorithm, not generic hosting advice.

GROUND TRUTH ABOUT HOW AIRBNB RANKS LISTINGS (from current published research):
- Click-through rate and conversion rate are among the biggest ranking signals. The closest real, Airbnb-sourced proxies we have are in airbnb_performance_manual: view_to_contact_rate_pct (guest viewed the listing and reached out or started booking) and contact_to_book_rate_pct (that contact converted to an actual booking). Treat these as real signal when present -- a listing with a low view_to_contact_rate despite reasonable pricing points to a photos/title/first-impression problem; a low contact_to_book_rate with a healthy view_to_contact_rate points to a pricing, availability, or listing-detail problem further down the funnel. If airbnb_performance_manual is null for a listing, it hasn't been imported yet -- do not invent a number, just note the gap.
- avg_booking_window_days in airbnb_performance_manual is the real booking lead time for that listing. A very short window relative to other listings can indicate the listing only appears in last-minute search results, which is itself a visibility symptom worth flagging.
- Returning-guest count and wishlist-addition count are NOT available from Airbnb in any exportable or API form. Never reference or estimate these.
- Price is judged RELATIVE TO COMPARABLE LISTINGS, not in absolute terms. A listing pricing "high" is only a problem if it's high relative to its own market_occupancy comparison in the data.
- Reviews: both AVERAGE RATING and REVIEW COUNT/VOLUME matter, not rating alone. The "Guest Favorite" badge (which replaced Superhost as the dominant quality signal in 2026, and is now roughly 25% of ranking weight) specifically requires at least 5 reviews AND a 4.9+ average rating. This is precomputed for you as guest_favorite_eligible per listing -- use it as a hard, checkable target, not a vague "get better reviews" appeal.
- Calendar gaps (short unbooked stretches under ~3 nights) hurt both occupancy and how "fresh"/available a calendar looks to the algorithm.
- Listing completeness (photo count, description length, amenity count) is a real if secondary ranking input. Instant Book (listing_completeness.instant_book) is a real, documented ranking boost when true; when false, flag it as a free, zero-cost fix.
- Response rate/time and acceptance rate are real, high-weight ranking factors that we also cannot measure via API. Do not fabricate these.

Your job: identify the 5-8 highest-priority, most concrete actions the team should take TODAY. Prioritize listings with the clearest, most fixable gaps: pacing behind market occupancy with a plausible calendar-fragmentation or pricing cause, low view_to_contact_rate or contact_to_book_rate where airbnb_performance_manual data exists, listings close to (but not yet at) Guest Favorite eligibility, Instant Book disabled, and listings with real gaps in completeness. Do not just say "lower the price" -- diagnose the likely cause and recommend the specific fix.

Respond with ONLY a JSON array (no prose, no markdown fences) of objects shaped exactly like this:
[{"priority": 1, "listing": "<listing name>", "issue": "<one sentence, specific, data-grounded>", "action": "<one sentence, concrete, doable today>"}]

If a recommendation requires data we don't have, phrase the action as "check Airbnb Insights for X" rather than presenting an invented number as fact.

If the data doesn't clearly support a strong recommendation for a listing, leave it out rather than inventing generic advice.`;

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const apiKey = process.env.CLAUDE_SECRET;
    if (!apiKey) throw new Error('CLAUDE_SECRET env var not set');

    const dataset = await buildDataset();
    if (!dataset.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ recommendations: [], note: 'No data available yet.' }) };
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        // Only needed if CLAUDE_SECRET is an org-level key not scoped to a
        // workspace. Preferred fix is to use a workspace-scoped key instead
        // (Anthropic Console -> API Keys -> create under a specific
        // workspace), but this covers it either way if ANTHROPIC_WORKSPACE_ID
        // is set.
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4000,
        // Explicitly disabled: this is a structured data->JSON task, not
        // something that benefits from extended reasoning, and leaving
        // thinking on by default was silently consuming the entire
        // token budget before any actual output was written (and costing
        // more per call than necessary in the process).
        thinking: { type: 'disabled' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(dataset) }],
      }),
    });

    const raw = await claudeRes.text();
    if (!claudeRes.ok) throw new Error(`Claude API ${claudeRes.status}: ${raw.slice(0, 500)}`);

    const claudeData = JSON.parse(raw);
    const textBlock = (claudeData.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      // Surface the actual raw response instead of a bare error -- this is
      // what should have happened the first time instead of guessing.
      throw new Error('No text content in Claude response. stop_reason=' + claudeData.stop_reason + ' content=' + JSON.stringify(claudeData.content).slice(0, 500));
    }

    let recommendations;
    try {
      // Strip accidental markdown fences just in case
      const cleaned = textBlock.text.replace(/^```json\s*|```$/g, '').trim();
      recommendations = JSON.parse(cleaned);
    } catch(e) {
      throw new Error('Failed to parse Claude output as JSON: ' + textBlock.text.slice(0, 300));
    }

    await sbInsert('daily_recommendations', [{
      recommendations,
      model: CLAUDE_MODEL,
      raw_response: textBlock.text,
    }]);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ recommendations }) };

  } catch(err) {
    console.error('get-recommendations error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
