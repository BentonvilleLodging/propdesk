// netlify/lib/autopilot-rules.js
// Pricing / minimum-stay autopilot — the decision rules. Pure functions (no I/O) so they
// can be tested directly.
//
// SCOPE RULE (set by Luke, Oct 2026):
//   • The ONLY things the autopilot ever changes are date-specific PRICE and MINIMUM STAY
//     (PriceLabs date-specific overrides).
//   • They are applied AUTOMATICALLY only for listings tagged "Black Cabins" in Guesty.
//   • For every other listing they are created as proposals that a person must approve.
//
// OPT-IN (Luke, Nov 2026): an owner can opt a listing in to the same automatic treatment.
// That is recorded in PropDesk (listing_registry.autopilot_opt_in), never as a Guesty tag.
// First opt-in: Lakeside Hideaway (Beaver Lake, 3 BR / sleeps 8) on the 'large_home' profile.

const AUTO_TAG = /black\s*cabins?/i;

const RULES = {
  horizonDays: 21,        // only touch the next 3 weeks — where Airbnb rank and last-minute demand matter
  triggerOverRef: 1.10,   // act when our price is >10% above what comparable homes book at
  targetOverRef: 1.03,    // ...and bring it to ~3% above that reference
  maxDrop: 0.15,          // never more than 15% below the price before the autopilot touched it
  minChange: 0.05,        // ignore changes smaller than 5%
  updateTolerance: 0.03,  // don't re-push an existing autopilot price unless it moves >3%
  lastMinuteDays: 5,      // inside 5 days, allow 1-night stays
  lastMinuteMinStay: 1,
};

// Per-listing pricing profiles. 'standard' is the Black Cabins pilot, unchanged. 'large_home'
// is for bigger whole homes (Lakeside Hideaway): fewer comparable listings, higher turnover
// cost and a real location premium, so the autopilot protects rate harder and also RAISES
// nights that are clearly underpriced against same-bedroom comps while the home is pacing ahead.
const PROFILES = {
  standard: {},
  large_home: {
    triggerOverRef: 1.15,       // only cut when >15% above (premium-adjusted) comps
    targetOverRef: 1.05,        // ...and land ~5% above them, not at them
    maxDrop: 0.10,              // never more than 10% below the original price
    premiumCap: 1.25,           // a home priced above its bedroom-matched market keeps up to +25% of that premium
    requireMatchedComps: true,  // no price moves unless the comps are the same bedroom count
    paceGate: true,             // no discounts (outside last-minute) while booking pace is at/above market
    underpricedBelow: 0.85,     // raise when the price is >15% under what comps are booking at...
    underpricedTarget: 0.97,    // ...toward 3% under the comps' booked price
    maxRaise: 0.25,             // never more than +25% over the original price in one step
    raiseMinDaysOut: 3,         // don't raise nights that are about to perish
    lastMinuteMinStay: 2,       // 8-guest home: keep 2-night minimum even last minute (unless a 1-night gap)
  },
};
function rulesFor(profile) { return { ...RULES, ...(PROFILES[profile] || {}), profile: PROFILES[profile] ? profile : 'standard' }; }

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

function isAutoApplyListing(listingOrTags) {
  const tags = Array.isArray(listingOrTags) ? listingOrTags : (listingOrTags && listingOrTags.tags) || (listingOrTags && listingOrTags.guesty_tags) || [];
  return tags.some((t) => AUTO_TAG.test(String(t)));
}

// Who runs on autopilot: Black Cabins (live Guesty tag) + owner opt-ins recorded in PropDesk.
// guestyListings: live Guesty listings ({ _id, tags }); registry: listing_registry rows.
function autoApplySet(guestyListings, registry) {
  const set = new Set((guestyListings || []).filter((l) => isAutoApplyListing(l)).map((l) => l._id));
  (registry || []).filter((r) => r.autopilot_opt_in === true).forEach((r) => set.add(r.listing_id));
  return set;
}

// Positioning premium: how far above its bedroom-matched market this home is set up to price
// (PriceLabs base vs the market's median base). Only ever a premium (>= 1), capped.
function positioningPremium(basePrice, marketBaseP50, cap) {
  const b = num(basePrice), m = num(marketBaseP50);
  if (b == null || m == null || m <= 0) return 1;
  return Math.round(Math.min(Math.max(b / m, 1), cap || 1) * 1000) / 1000;
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
//   minPrice     price floor: max(PriceLabs minimum, owner minimum on the Properties page)
//   minNights    owner's minimum nights from the Properties page (min stay never goes below it)
//   ours         { [date]: { original_price, price, min_stay } } active autopilot overrides
//   foreign      Set of dates that carry an override someone ELSE set (never touched)
//   eventDates   Set of dates covered by high-impact NWA events (never discounted)
//   profile      'standard' | 'large_home'
//   market       { premium, compsMatched, compCategory, occ30, mktOcc30 } (large_home uses these)
// Returns proposals: { stay_date, kind, original_price, current_price, proposed_price,
//                      current_min_stay, proposed_min_stay, reasons[], evidence }
function proposeForListing({ dates, today, minPrice, minNights, ours, foreign, eventDates, profile, market }) {
  ours = ours || {}; foreign = foreign || new Set(); eventDates = eventDates || new Set(); market = market || {};
  const RL = rulesFor(profile);
  const large = RL.profile === 'large_home';
  const premium = large ? (market.premium || 1) : 1;
  const occ = num(market.occ30), mkt = num(market.mktOcc30);
  const paceKnown = occ != null && mkt != null;
  const behindPace = paceKnown && occ < mkt;
  const compsOk = !RL.requireMatchedComps || market.compsMatched === true;
  const floorNights = num(minNights);
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
    if (days < 0 || days > RL.horizonDays) return;
    if (d.status !== 'open') return;
    if (foreign.has(d.date)) return;
    const mine = ours[d.date] || null;
    const base = mine && mine.original_price != null ? mine.original_price : d.our_price;
    const reasons = [];
    const ref = d.mkt_booked || d.mkt_p50;
    const refAdj = ref ? ref * premium : null;
    const protectedDate = d.demand === 'High Demand' || eventDates.has(d.date);
    const lastMinute = days <= RL.lastMinuteDays;
    const refLabel = `${d.mkt_booked ? 'comparable homes are booking at' : 'comparable homes list at (median)'}${large && market.compCategory ? ' (' + market.compCategory + '-BR comps)' : ''}`;

    // ── Price ──
    let price = null;
    // Down: priced well above comps and not winning page 1
    const paceAllowsDrop = !large || !RL.paceGate || lastMinute || (paceKnown ? behindPace : false);
    if (base != null && refAdj && compsOk && paceAllowsDrop && !protectedDate && d.best_page !== 1 && base > refAdj * RL.triggerOverRef) {
      let p = Math.round(Math.max(refAdj * RL.targetOverRef, base * (1 - RL.maxDrop)));
      if (minPrice != null) p = Math.max(p, Math.round(minPrice));
      if (p <= base * (1 - RL.minChange)) {
        price = p;
        reasons.push(`$${Math.round(base)} is ${Math.round((base / ref - 1) * 100)}% above the $${Math.round(ref)} ${refLabel}; ${d.shown ? 'best placement page ' + (d.best_page || '?') : 'not shown in search'}${premium > 1 ? `; keeps a ${Math.round((premium - 1) * 100)}% location/size premium` : ''}${large && lastMinute ? '; last-minute night' : large ? `; pacing behind market (${Math.round(occ)}% vs ${Math.round(mkt)}% next 30 days)` : ''}`);
      }
    }
    // Up (large_home): clearly underpriced vs same-bedroom comps while pacing at/above market,
    // or any open high-demand / event night priced under comps.
    if (price == null && large && compsOk && base != null && ref && days >= RL.raiseMinDaysOut) {
      const cap = base * (1 + RL.maxRaise);
      let target = null, why = null;
      if (protectedDate && base < ref) {
        target = ref * premium;
        why = `${eventDates.has(d.date) ? 'Event' : 'High-demand'} night priced $${Math.round(base)}, under the $${Math.round(ref)} ${refLabel}`;
      } else if (base < ref * RL.underpricedBelow && paceKnown && !behindPace) {
        target = ref * RL.underpricedTarget;
        why = `$${Math.round(base)} is ${Math.round((1 - base / ref) * 100)}% under the $${Math.round(ref)} ${refLabel} while the home is pacing ahead of market (${Math.round(occ)}% vs ${Math.round(mkt)}% next 30 days)`;
      }
      if (target != null) {
        const p = Math.round(Math.min(target, cap));
        if (p >= base * (1 + RL.minChange)) { price = p; reasons.push(why + (p < Math.round(target) ? ` — capped at +${Math.round(RL.maxRaise * 100)}% this step` : '')); }
      }
    }
    // ── Minimum stay ──
    let ms = null;
    const curMs = d.min_stay;
    const okMs = (n) => floorNights == null || n >= floorNights; // owner's minimum nights is a hard floor
    if (gaps[d.date] != null && curMs != null && gaps[d.date] < curMs && okMs(gaps[d.date])) { ms = gaps[d.date]; reasons.push(`${gaps[d.date]}-night gap between bookings can't be booked with a ${curMs}-night minimum`); }
    const lmMs = Math.max(RL.lastMinuteMinStay, floorNights || 1);
    if (lastMinute && curMs != null && curMs > lmMs && (ms == null || ms > lmMs)) { ms = lmMs; reasons.push(`${days === 0 ? 'Tonight' : days + ' day' + (days === 1 ? '' : 's') + ' out'} and still open — allow ${lmMs}-night stays`); }

    const ev = { days_out: days, ref: ref || null, mkt_p50: d.mkt_p50, mkt_booked: d.mkt_booked, best_page: d.best_page, shown: d.shown, demand: d.demand, min_price: minPrice,
      ...(large ? { profile: RL.profile, premium, comp_category: market.compCategory || null, comps_matched: !!market.compsMatched, occ30: occ, mkt_occ30: mkt, min_nights: floorNights } : {}) };
    const row = { stay_date: d.date, original_price: base, original_min_stay: curMs,
      current_price: d.live_price != null ? d.live_price : d.our_price, current_min_stay: d.live_min_stay != null ? d.live_min_stay : curMs, evidence: ev };

    if (mine) {
      // We already have an override on this date: keep, update, or take it off.
      const wantPrice = price;
      const wantMs = ms;
      if (wantPrice == null && wantMs == null) {
        out.push({ ...row, kind: 'remove', proposed_price: null, proposed_min_stay: null, reasons: [protectedDate && !(mine.price != null && mine.original_price != null && mine.price > mine.original_price) ? 'High-demand / event date — restore normal pricing' : 'No longer out of line with comparables — restore normal pricing'] });
        return;
      }
      const priceSame = (wantPrice == null && mine.price == null) || (wantPrice != null && mine.price != null && Math.abs(wantPrice - mine.price) / mine.price <= RL.updateTolerance);
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

module.exports = { RULES, PROFILES, rulesFor, AUTO_TAG, isAutoApplyListing, autoApplySet, positioningPremium, aggregateDates, orphanGaps, proposeForListing, addDays, daysBetween };
