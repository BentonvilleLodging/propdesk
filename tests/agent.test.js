// node tests/agent.test.js — guardrail + triage checks for netlify/lib/agent.js (no network)
const assert = require('assert');
const AG = require('../netlify/lib/agent');

const today = '2026-10-29';
const d = (date, o) => ({ date, status: 'open', our_price: 200, min_stay: 3, demand: null, mkt_p50: 180, mkt_booked: 170, best_page: 3, shown: true, ...o });
const ctx = {
  listing_id: 'L1', name: 'Cabin 1', inPriceLabs: true, minPrice: 150, auto: true, foreignUnknown: false,
  dates: {
    '2026-10-30': d('2026-10-30'),
    '2026-10-31': d('2026-10-31', { status: 'booked' }),
    '2026-11-01': d('2026-11-01'),
    '2026-11-02': d('2026-11-02', { demand: 'High Demand' }),
    '2026-11-03': d('2026-11-03'),
    '2026-11-04': d('2026-11-04', { our_price: 180 }),
    '2026-12-15': d('2026-12-15'),
  },
  ours: { '2026-11-04': { original_price: 200, original_min_stay: 3, price: 180, min_stay: null, source: 'autopilot' } },
  foreign: new Set(['2026-11-03']),
};

const r = AG.validate([
  { date: '2026-10-30', price: 175, why: 'off page 1' },          // ok: -12.5%
  { date: '2026-10-31', price: 175 },                             // booked
  { date: '2026-11-01', price: 160 },                             // -20% → too deep
  { date: '2026-11-02', price: 185 },                             // high demand discount
  { date: '2026-11-02', min_stay: 2 },                            // duplicate date? first was rejected, so this one is fine
  { date: '2026-11-03', price: 190 },                             // manual override
  { date: '2026-11-04', price: 172 },                             // base is ORIGINAL 200 → -14% ok
  { date: '2026-12-15', price: 190 },                             // outside 30 nights
  { date: '2026-11-01', min_stay: 9 },                            // min stay too high
  { date: 'bad', price: 1 },
], ctx, today, new Set());

const okDates = r.ok.map((x) => x.stay_date);
assert.deepStrictEqual(okDates, ['2026-10-30', '2026-11-02', '2026-11-04']);
assert.strictEqual(r.ok[0].proposed_price, 175);
assert.strictEqual(r.ok[1].proposed_price, null);
assert.strictEqual(r.ok[1].proposed_min_stay, 2);
assert.strictEqual(r.ok[2].original_price, 200);
const reasons = r.rejected.map((x) => x.date + ': ' + x.reason).join('\n');
['booked or blocked', 'more than 15% below', 'no discounts', 'manual PriceLabs override', 'Outside the next 30', 'Min stay 9', 'Bad date']
  .forEach((s) => assert(reasons.includes(s), 'missing rejection: ' + s + '\n' + reasons));

// below PriceLabs minimum, raise cap, event-night discount
const r2 = AG.validate([{ date: '2026-10-30', price: 145 }, { date: '2026-11-01', price: 270 }, { date: '2026-11-04', price: 260 }], { ...ctx, minPrice: 180 }, today, new Set(['2026-11-01']));
assert.deepStrictEqual(r2.ok.map((x) => x.stay_date), ['2026-11-04']); // 260 = +30% of 200 original → allowed
assert(r2.rejected.some((x) => /below the PriceLabs minimum|more than 15% below/.test(x.reason)));
assert(r2.rejected.some((x) => /more than 30% above/.test(x.reason)));

// not in PriceLabs → nothing passes
assert.strictEqual(AG.validate([{ date: '2026-10-30', price: 180 }], { ...ctx, inPriceLabs: false }, today).ok.length, 0);

// tiny change is dropped silently
assert.strictEqual(AG.validate([{ date: '2026-10-30', price: 197 }], ctx, today).ok.length, 0);

// triage
const packs = [
  { listing_id: 'A', name: 'Behind', pack: { occupancy_vs_market_pct: { next30: [40, 60], next7: [20, 50] }, next_90_days_calendar: { windows: { next14: { open_nights: 10 } } } } },
  { listing_id: 'B', name: 'Healthy', pack: { occupancy_vs_market_pct: { next30: [70, 60] }, bookings: { last_booking_created: '2026-10-27' } } },
  { listing_id: 'C', name: 'Off page 1', pack: { airbnb_search_ranking: { diagnosis: { pct_page1: 10 } }, calendar_gaps_next60: { gaps: 3 } } },
];
const t = AG.triage(packs, new Set(['C']), today);
assert.deepStrictEqual(t.map((x) => x.listing_id), ['A', 'C']);
assert.strictEqual(t[1].auto, true);
assert(t[0].flags.length === 3);

console.log('agent tests passed');
