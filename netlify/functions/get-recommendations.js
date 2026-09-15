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
  const [priceRows, gapRows, reviewRows] = await Promise.all([
    sbSelect('pricelabs_daily', 'select=*&order=snapshot_date.desc'),
    sbSelect('calendar_gap_snapshots', 'select=*&order=snapshot_date.desc'),
    sbSelect('guesty_review_snapshots', 'select=*&order=snapshot_date.desc'),
  ]);

  const latest = (rows) => {
    const map = {};
    rows.forEach(r => { if (!map[r.listing_id]) map[r.listing_id] = r; });
    return map;
  };

  const price = latest(priceRows);
  const gaps = latest(gapRows);
  const reviews = latest(reviewRows);

  const listingIds = Object.keys(price);
  return listingIds.map(lid => {
    const p = price[lid];
    const g = gaps[lid] || {};
    const rv = reviews[lid] || {};
    return {
      listing: (p.raw && p.raw.name) ? p.raw.name.split(' -- ')[0] : lid,
      your_occupancy_pct: { d7: p.occupancy_pct_7d, d30: p.occupancy_pct_30d, d60: p.occupancy_pct_60d },
      market_occupancy_pct: { d7: p.market_occupancy_pct_7d, d30: p.market_occupancy_pct_30d, d60: p.market_occupancy_pct_60d },
      your_price: p.base_price,
      pricelabs_recommended_price: p.recommended_price,
      min_price_floor: p.min_price,
      calendar_gaps_next_60d: { count: g.gap_count_60d, nights: g.gap_nights_60d },
      review_count: rv.review_count,
      avg_rating: rv.avg_rating,
    };
  });
}

const SYSTEM_PROMPT = `You are a short-term rental revenue and search-visibility analyst for Bentonville Lodging Co, which manages ~30 vacation rental listings on Airbnb and VRBO in Northwest Arkansas.

You will be given a JSON array of per-listing data: current pricing, occupancy pace vs. the local market, calendar gaps (short unbooked stretches that hurt search ranking), and review data where available.

Your job: identify the 5-8 highest-priority, most concrete actions the team should take TODAY to improve search visibility and revenue. Prioritize listings that are pacing meaningfully behind market occupancy, have several calendar gaps, or show other clear red flags in the data. Do not just say "lower the price" -- diagnose the likely cause (calendar fragmentation, stale content, min-stay mismatch, genuine overpricing) and recommend the specific fix.

Respond with ONLY a JSON array (no prose, no markdown fences) of objects shaped exactly like this:
[{"priority": 1, "listing": "<listing name>", "issue": "<one sentence, specific, data-grounded>", "action": "<one sentence, concrete, doable today>"}]

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
