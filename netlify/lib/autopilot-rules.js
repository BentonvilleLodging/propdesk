// netlify/lib/autopilot-rules.js
// Pricing / minimum-stay autopilot — the decision rules. Pure functions (no I/O) so they
// can be tested directly.
//
// SCOPE RULE (set by Luke, Oct 2026):
//   • The ONLY things the autopilot ever changes are date-specific PRICE and MINIMUM STAY
//     (PriceLabs date-specific overrides).
//   • They are applied AUTOMATICALLY only for listings tagged "Black Cabins" in Guesty.
//   • For every other listing they are created as proposals that a person must approve.

const AUTO_TAG = /black\s*cabins?/i;

const RULES = {
  horizonDays: 21,        // only touch the next 3 weeks — where Airbnb rank and last-minute demand matter
  triggerOverRef: 1.10,   // act when our price is >10% above what comparable homes book at
  targetOverRef: 1.03,    // ...and bring it to ~3% above that reference
  maxDrop: 0.15,          // never more than 15% below the price before the autopilot touched it
  minChange: 0.05,        // ignore changes smaller than 5%
  updateTolerance: 0.03,  // don't re-push an existing autopilot price unless it moves >3%
  lastMinuteDays: 5,      // inside 5 days, allow 1-night stays
};

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

function isAutoApplyListing(listingOrTags) {
  const tags = Array.isArray(listingOrTags) ? listingOrTags : (listingOrTags && listingOrTags.tags) || (listingOrTags && listingOrTags.guesty_tags) || [];
  return tags.some((t) => AUTO_TAG.test(String(t)));
}

// listing_rank_dates rows (one per stay date × search segment) → one record per stay date
function aggregateDates(rows) {
  const by = {};
  (rows || []).forEach((r) => {
    const d = by[r.stay_date] || (by[r.stay_date] = {
      date: r.stay_date, status: r.status, our_price: num(r.our_price), min_stay: num(r.min_stay), demand: r.demand || null,
      mkt_p50: num(r.mkt_p50), mkt_booked: num(r.mkt_median_booked), best_page: null, shown: false,
    });
    if (r.status === 'open') d.status = 'open';
    if (d.our_price == null) d.our_price = num(r.our_price);
    if (d.min_stay == null) d.min_stay = num(r.min_stay);
    const rk = num(r.rank), pg = num(r.page);
    if (rk != null && rk !== 999) { d.shown = true; if (pg != null && (d.best_page == null || pg < d.best_page)) d.best_page = pg; }
  });
  return Object.values(by).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Open stretches boxed in by booked/blocked nights that are shorter than the minimum stay
// can never be booked — propose min stay = the length of the gap.
function orphanGaps(dates, today) {
  const out = {};
  const unavailable = (d) => d && d.status !== 'open';
  for (let i = 0; i < dates.length; i++) {
    if (dates[i].status !== 'open') continue;
    let j = i;
    while (j + 1 < dates.length && dates[j + 1].status === 'open' && daysBetween(dates[j].date, dates[j + 1].date) === 1) j++;
    const prev = dates[i - 1], next = dates[j + 1];
    const leftBound = dates[i].date === today || (prev && daysBetween(prev.date, dates[i].date) === 1 && unavailable(prev));
    const rightBound = next && daysBetween(dates[j].date, next.date) === 1 && unavailable(next);
    const len = j - i + 1;
    const ms = dates[i].min_stay;
    if (leftBound && rightBound && ms != null && len < ms) for (let k = i; k <= j; k++) out[dates[k].date] = len;
    i = j;
  }
  return out;
}

// Main rule set. Inputs for ONE listing:
//   dates        aggregateDates(...) output
//   today        'YYYY-MM-DD'
//   minPrice     PriceLabs minimum price (never go below it)
//   ours         { [date]: { original_price, price, min_stay } } active autopilot overrides
//   foreign      Set of dates that carry an override someone ELSE set (never touched)
//   eventDates   Set of dates covered by high-impact NWA events (never discounted)
// Returns proposals: { stay_date, kind, original_price, current_price, proposed_price,
//                      current_min_stay, proposed_min_stay, reasons[], evidence }
function proposeForListing({ dates, today, minPrice, ours, foreign, eventDates }) {
  ours = ours || {}; foreign = foreign || new Set(); eventDates = eventDates || new Set();
  // Evaluate every date against its ORIGINAL settings (before our own override), so the
  // autopilot never ratchets a price down day after day or flip-flops a min stay.
  dates = dates.map((d) => {
    const m = ours[d.date];
    if (!m) return d;
    return { ...d, live_price: d.our_price, live_min_stay: d.min_stay,
      our_price: m.original_price != null ? m.original_price : d.our_price,
      min_stay: m.original_min_stay != null ? m.original_min_stay : d.min_stay };
  });
  const gaps = orphanGaps(dates, today);
  const out = [];
  dates.forEach((d) => {
    const days = daysBetween(today, d.date);
    if (days < 0 || days > RULES.horizonDays) return;
    if (d.status !== 'open') return;
    if (foreign.has(d.date)) return;
    const mine = ours[d.date] || null;
    const base = mine && mine.original_price != null ? mine.original_price : d.our_price;
    const reasons = [];
    const ref = d.mkt_booked || d.mkt_p50;
    const protectedDate = d.demand === 'High Demand' || eventDates.has(d.date);

    // ── Price ──
    let price = null;
    if (base != null && ref && !protectedDate && d.best_page !== 1 && base > ref * RULES.triggerOverRef) {
      let p = Math.round(Math.max(ref * RULES.targetOverRef, base * (1 - RULES.maxDrop)));
      if (minPrice != null) p = Math.max(p, Math.round(minPrice));
      if (p <= base * (1 - RULES.minChange)) {
        price = p;
        reasons.push(`$${Math.round(base)} is ${Math.round((base / ref - 1) * 100)}% above the $${Math.round(ref)} comparable homes ${d.mkt_booked ? 'are booking at' : 'list at (median)'}; ${d.shown ? 'best placement page ' + (d.best_page || '?') : 'not shown in search'}`);
      }
    }
    // ── Minimum stay ──
    let ms = null;
    const curMs = d.min_stay;
    if (gaps[d.date] != null && curMs != null && gaps[d.date] < curMs) { ms = gaps[d.date]; reasons.push(`${gaps[d.date]}-night gap between bookings can't be booked with a ${curMs}-night minimum`); }
    if (days <= RULES.lastMinuteDays && curMs != null && curMs > 1 && (ms == null || ms > 1)) { ms = 1; reasons.push(`${days === 0 ? 'Tonight' : days + ' day' + (days === 1 ? '' : 's') + ' out'} and still open — allow 1-night stays`); }

    const ev = { days_out: days, ref: ref || null, mkt_p50: d.mkt_p50, mkt_booked: d.mkt_booked, best_page: d.best_page, shown: d.shown, demand: d.demand, min_price: minPrice };
    const row = { stay_date: d.date, original_price: base, original_min_stay: curMs,
      current_price: d.live_price != null ? d.live_price : d.our_price, current_min_stay: d.live_min_stay != null ? d.live_min_stay : curMs, evidence: ev };

    if (mine) {
      // We already have an override on this date: keep, update, or take it off.
      const wantPrice = price;
      const wantMs = ms;
      if (wantPrice == null && wantMs == null) {
        out.push({ ...row, kind: 'remove', proposed_price: null, proposed_min_stay: null, reasons: [protectedDate ? 'High-demand / event date — restore normal pricing' : 'No longer priced above comparables — restore normal pricing'] });
        return;
      }
      const priceSame = (wantPrice == null && mine.price == null) || (wantPrice != null && mine.price != null && Math.abs(wantPrice - mine.price) / mine.price <= RULES.updateTolerance);
      const msSame = (wantMs == null && mine.min_stay == null) || wantMs === mine.min_stay;
      if (priceSame && msSame) return;
      out.push({ ...row, kind: 'set', proposed_price: wantPrice, proposed_min_stay: wantMs, reasons: reasons.length ? reasons : ['Adjust existing autopilot override'] });
      return;
    }
    if (price == null && ms == null) return;
    out.push({ ...row, kind: 'set', proposed_price: price, proposed_min_stay: ms, reasons });
  });
  return out;
}

module.exports = { RULES, AUTO_TAG, isAutoApplyListing, aggregateDates, orphanGaps, proposeForListing, addDays, daysBetween };
