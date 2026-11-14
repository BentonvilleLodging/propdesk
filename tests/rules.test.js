// node tests/rules.test.js — autopilot rules: standard (Black Cabins) unchanged + large_home profile (no network)
const assert = require('assert');
const R = require('../netlify/lib/autopilot-rules');

const today = '2026-11-14';
const day = (date, o) => ({ date, status: 'open', our_price: 200, min_stay: 2, demand: 'Normal Demand', mkt_p50: 190, mkt_booked: 170, best_page: 3, shown: true, ...o });
const byDate = (props) => Object.fromEntries(props.map((p) => [p.stay_date, p]));

// ── Standard profile: same behaviour as the Black Cabins pilot ──
{
  const dates = [day('2026-11-16', { min_stay: 3 }), day('2026-11-25'), day('2026-11-26', { our_price: 150 })];
  const p = byDate(R.proposeForListing({ dates, today, minPrice: 120 }));
  assert.strictEqual(p['2026-11-16'].proposed_price, 175);        // 170 × 1.03 = 175 (−12.5%)
  assert.strictEqual(p['2026-11-16'].proposed_min_stay, 1);       // 2 days out → 1-night stays
  assert.strictEqual(p['2026-11-25'].proposed_price, 175);
  assert.strictEqual(p['2026-11-26'], undefined);                 // underpriced: standard never raises
}

// ── Opt-in set: Guesty tag OR PropDesk opt-in ──
{
  const s = R.autoApplySet([{ _id: 'BC', tags: ['blackcabins'] }, { _id: 'LH', tags: [] }], [{ listing_id: 'LH', autopilot_opt_in: true }, { listing_id: 'X', autopilot_opt_in: false }]);
  assert.deepStrictEqual([...s].sort(), ['BC', 'LH']);
  assert.strictEqual(R.positioningPremium(260, 229, 1.25), 1.135);
  assert.strictEqual(R.positioningPremium(210, 229, 1.25), 1);    // never a discount
  assert.strictEqual(R.positioningPremium(400, 229, 1.25), 1.25); // capped
}

// ── large_home: mirrors Lakeside Hideaway on 2026-11-14 (141 on many nights, comps booking ~$208) ──
const market = { premium: 1, compsMatched: true, compCategory: '3', occ30: 47, mktOcc30: 29 };
{
  const dates = [
    day('2026-11-24', { our_price: 233, mkt_booked: 222, best_page: 1, demand: 'Good Demand' }),
    day('2026-11-25', { our_price: 285, mkt_booked: 239, demand: 'High Demand', best_page: null, shown: false }),
    day('2026-11-29', { our_price: 141, mkt_booked: 212.5, best_page: null, shown: false }),
    day('2026-12-01', { our_price: 141, mkt_booked: 208, min_stay: 1, best_page: 5 }),
    day('2026-12-04', { our_price: 152, mkt_booked: 184, best_page: 3 }),   // 17% under → raise
    day('2026-12-05', { our_price: 176, mkt_booked: 184, best_page: 4 }),   // only 4% under → leave
  ];
  const p = byDate(R.proposeForListing({ dates, today, minPrice: 189, minNights: 2, profile: 'large_home', market }));
  assert.strictEqual(p['2026-11-24'], undefined);
  assert.strictEqual(p['2026-11-25'], undefined);                 // already above comps
  assert.strictEqual(p['2026-11-29'].proposed_price, 176);        // min(212.5×0.97, 141×1.25) → capped at +25%
  assert(/capped/.test(p['2026-11-29'].reasons[0]));
  assert.strictEqual(p['2026-12-01'].proposed_price, 176);
  assert.strictEqual(p['2026-12-04'].proposed_price, 178);        // 184 × 0.97
  assert.strictEqual(p['2026-12-05'], undefined);
  assert.strictEqual(p['2026-11-29'].evidence.comp_category, '3');
}
{
  // Pacing BEHIND market: overpriced nights get cut, but only 10% and never under the owner floor
  const behind = { ...market, occ30: 20, mktOcc30: 29 };
  const dates = [day('2026-11-28', { our_price: 300, mkt_booked: 200 }), day('2026-11-30', { our_price: 205, mkt_booked: 160 })];
  const p = byDate(R.proposeForListing({ dates, today, minPrice: 189, minNights: 2, profile: 'large_home', market: behind }));
  assert.strictEqual(p['2026-11-28'].proposed_price, 270);        // max(200×1.05, 300×0.90)
  assert.strictEqual(p['2026-11-30'].proposed_price, 189);        // 185 → owner floor $189
  // Pacing AHEAD: no discounts outside last-minute
  const q = R.proposeForListing({ dates, today, minPrice: 189, profile: 'large_home', market });
  assert.strictEqual(q.length, 0);
}
{
  // Comps not bedroom-matched → no price moves at all; min-stay gap fill still works but never below owner min nights
  const loose = { ...market, compsMatched: false, compCategory: 'All' };
  const dates = [
    day('2026-11-20', { status: 'booked' }),
    day('2026-11-21', { our_price: 120, mkt_booked: 200, min_stay: 3 }), day('2026-11-22', { our_price: 120, mkt_booked: 200, min_stay: 3 }),
    day('2026-11-23', { status: 'booked' }),
    day('2026-11-24', { status: 'booked' }), day('2026-11-25', { our_price: 120, min_stay: 3 }), day('2026-11-26', { status: 'booked' }),
  ];
  const p = byDate(R.proposeForListing({ dates, today, minPrice: 100, minNights: 2, profile: 'large_home', market: loose }));
  assert.strictEqual(p['2026-11-21'].proposed_price, null);
  assert.strictEqual(p['2026-11-21'].proposed_min_stay, 2);       // 2-night gap → min stay 2
  assert.strictEqual(p['2026-11-25'], undefined);                 // 1-night gap is below the owner's 2-night minimum
}
{
  // Last minute on a large home: min stay drops to 2, not 1; event night under comps gets raised
  const dates = [day('2026-11-16', { min_stay: 4, our_price: 230, mkt_booked: 200 }), day('2026-11-21', { our_price: 180, mkt_booked: 220, demand: 'High Demand' })];
  const p = byDate(R.proposeForListing({ dates, today, minPrice: 150, profile: 'large_home', market }));
  assert.strictEqual(p['2026-11-16'].proposed_min_stay, 2);
  assert.strictEqual(p['2026-11-21'].proposed_price, 220);
}

console.log('rules tests passed');
