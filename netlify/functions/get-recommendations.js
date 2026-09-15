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
  const [priceRows, gapRows, reviewRows, completenessRows] = await Promise.all([
    sbSelect('pricelabs_daily', 'select=*&order=snapshot_date.desc'),
    sbSelect('calendar_gap_snapshots', 'select=*&order=snapshot_date.desc'),
    sbSelect('guesty_review_snapshots', 'select=*&order=snapshot_date.desc'),
    sbSelect('listing_completeness_snapshots', 'select=*&order=snapshot_date.desc'),
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

  const listingIds = Object.keys(price);
  return listingIds.map(lid => {
    const p = price[lid];
    const g = gaps[lid] || {};
    const rv = reviews[lid] || {};
    const c = completeness[lid] || {};
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
      },
    };
  });
}

const SYSTEM_PROMPT = `You are a short-term rental revenue and search-visibility analyst for Bentonville Lodging Co, which manages ~30 vacation rental listings on Airbnb and VRBO in Northwest Arkansas. Your job is to help them win Airbnb's actual search algorithm, not generic hosting advice.

GROUND TRUTH ABOUT HOW AIRBNB RANKS LISTINGS (from current published research):
- The two single biggest ranking signals -- click-through rate on the search card and conversion rate (view to book) -- are NOT in the data you're given. Airbnb does not expose them via any API; they only appear in the host's own Airbnb Insights dashboard. Do not estimate or fabricate these. If a listing's data suggests a likely CTR/conversion problem (e.g. priced far above comps but no other red flags), say so explicitly and recommend checking Airbnb Insights manually -- do not invent a number.
- Price is judged RELATIVE TO COMPARABLE LISTINGS, not in absolute terms. A listing pricing "high" is only a problem if it's high relative to its own market_occupancy comparison in the data.
- Reviews: both AVERAGE RATING and REVIEW COUNT/VOLUME matter, not rating alone. The "Guest Favorite" badge (which replaced Superhost as the dominant quality signal in 2026, and is now roughly 25% of ranking weight) specifically requires at least 5 reviews AND a 4.9+ average rating. This is precomputed for you as guest_favorite_eligible per listing -- use it as a hard, checkable target, not a vague "get better reviews" appeal.
- Calendar gaps (short unbooked stretches under ~3 nights) hurt both occupancy and how "fresh"/available a calendar looks to the algorithm.
- Listing completeness (photo count, description length, amenity count) is a real if secondary ranking input. Very thin listings (very few photos, short description, few listed amenities) are a fixable red flag.
- Response rate/time and acceptance rate are real, high-weight ranking factors that we also cannot measure via API. Do not fabricate these either.

Your job: identify the 5-8 highest-priority, most concrete actions the team should take TODAY. Prioritize listings with the clearest, most fixable gaps: pacing behind market occupancy with a plausible calendar-fragmentation or pricing cause, listings close to (but not yet at) Guest Favorite eligibility, listings with real gaps in completeness, and cases worth flagging for manual Airbnb Insights review (CTR/conversion suspected issue). Do not just say "lower the price" -- diagnose the likely cause and recommend the specific fix.

Respond with ONLY a JSON array (no prose, no markdown fences) of objects shaped exactly like this:
[{"priority": 1, "listing": "<listing name>", "issue": "<one sentence, specific, data-grounded>", "action": "<one sentence, concrete, doable today>"}]

If a recommendation requires data we don't have (CTR, conversion, response rate), phrase the action as "check Airbnb Insights for X" rather than presenting an invented number as fact.

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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(dataset) }],
      }),
    });

    const raw = await claudeRes.text();
    if (!claudeRes.ok) throw new Error(`Claude API ${claudeRes.status}: ${raw.slice(0, 500)}`);

    const claudeData = JSON.parse(raw);
    const textBlock = (claudeData.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text content in Claude response');

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
