// netlify/lib/agent.js
// SEARCH HEALTH AGENT — runs inside listing-intel-analyze-background on Mondays and Thursdays.
//
//   1. triage()        Deterministic, no Claude: flag listings that are losing search visibility
//                      or bookings (behind market, off page 1, open nights, gaps, booking drought).
//   2. datePacks()     For flagged listings only: the next 30 nights (price, min stay, rank, what
//                      comparable homes book at, demand) + which dates carry overrides.
//   3. Claude          The ONE weekly-budget request also returns an "actions" line per flagged
//                      listing: date-specific price / min-stay changes with a reason.
//   4. validate()      Hard guardrails — anything outside them is rejected and logged, never sent.
//   5. execute()       Listings tagged "Black Cabins" in Guesty → pushed to PriceLabs now (undoable).
//                      Every other listing → 'pending' on the Approvals list for a person.
//
// SCOPE RULE (Luke, Oct 2026): only date PRICE and MINIMUM STAY are ever changed automatically,
// and only for "Black Cabins" listings.

const I = require('./intel');
const R = require('./autopilot-rules');
const A = require('./autopilot-apply');

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

const GUARD = {
  horizonDays: 30,     // only the next 30 nights
  maxDrop: 0.15,       // never more than 15% below the price before PropDesk touched the date
  maxRaise: 0.30,      // never more than 30% above it
  minChange: 0.03,     // ignore price moves under 3%
  maxMinStay: 7,
  maxPerListing: 30,
  maxFlagged: 12,      // keeps the one Claude request bounded
};

// ── 1. Triage ───────────────────────────────────────────────────────────
// packs: buildPacks() output [{ listing_id, name, pack }]
function triage(packs, autoSet, today) {
  const out = [];
  packs.forEach((p) => {
    const pk = p.pack || {};
    const o = pk.occupancy_vs_market_pct || {};
    const flags = [];
    let score = 0;
    const gap = (w) => (o[w] && o[w][0] != null && o[w][1] != null ? o[w][0] - o[w][1] : null);
    const g30 = gap('next30'), g7 = gap('next7');
    if (g30 != null && g30 <= -10) { flags.push(`Next 30 days ${Math.round(-g30)} pts behind market occupancy`); score += -g30; }
    if (g7 != null && g7 <= -15) { flags.push(`Next 7 days ${Math.round(-g7)} pts behind market`); score += -g7 / 2; }
    const dg = pk.airbnb_search_ranking && pk.airbnb_search_ranking.diagnosis;
    const p1 = dg ? num(dg.pct_page1) : null;
    if (p1 != null && p1 < 40) { flags.push(`On Airbnb page 1 for only ${Math.round(p1)}% of tracked dates`); score += (40 - p1) / 2; }
    const w14 = pk.next_90_days_calendar && pk.next_90_days_calendar.windows && pk.next_90_days_calendar.windows.next14;
    const open14 = w14 ? num(w14.open_nights) : null;
    if (open14 != null && open14 >= 8) { flags.push(`${open14} of the next 14 nights still open`); score += open14; }
    const gaps = pk.calendar_gaps_next60 ? num(pk.calendar_gaps_next60.gaps) : null;
    if (gaps != null && gaps >= 2) { flags.push(`${gaps} unbookable gaps in the next 60 days`); score += gaps * 2; }
    const last = pk.bookings && pk.bookings.last_booking_created;
    if (last && R.daysBetween(last, today) >= 14) { flags.push(`No new booking in ${R.daysBetween(last, today)} days`); score += 8; }
    if (flags.length) out.push({ listing_id: p.listing_id, name: p.name, auto: autoSet.has(p.listing_id), flags, score: Math.round(score) });
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, GUARD.maxFlagged);
}

// ── 2. Date packs for flagged listings ──────────────────────────────────
async function datePacks(flagged, today) {
  const plMap = await A.plListingMap();
  const until = R.addDays(today, GUARD.horizonDays);
  const activeOurs = await I.sbSelect('autopilot_overrides', `select=*&active=eq.true&stay_date=gte.${today}`).catch(() => []);
  const pendingRows = await I.sbSelect('pricing_proposals', `select=listing_id,stay_date,source&status=eq.pending&stay_date=gte.${today}`).catch(() => []);
  const ctx = {};
  for (const f of flagged) {
    const lid = f.listing_id;
    const p = plMap[String(lid)];
    const c = { listing_id: lid, name: f.name, auto: f.auto, pms: (p && p.pms) || 'guesty', minPrice: p ? num(p.min) : null, inPriceLabs: !!p,
      dates: {}, ours: {}, foreign: new Set(), foreignUnknown: false };
    activeOurs.filter((o) => o.listing_id === lid).forEach((o) => {
      c.ours[o.stay_date] = { ...o, price: num(o.price), original_price: num(o.original_price), min_stay: num(o.min_stay), original_min_stay: num(o.original_min_stay) };
    });
    if (p) {
      try { (await A.getOverrides(lid, c.pms)).forEach((o) => { if (!c.ours[o.date]) c.foreign.add(o.date); }); }
      catch (e) { c.foreignUnknown = true; }
    }
    const rows = await I.sbSelect('listing_rank_dates', `select=snapshot_date,stay_date,status,our_price,min_stay,rank,page,demand,mkt_p50,mkt_median_booked&listing_id=eq.${encodeURIComponent(lid)}&snapshot_date=gte.${R.addDays(today, -2)}&stay_date=gte.${today}&stay_date=lte.${until}&order=snapshot_date.desc&limit=1500`).catch(() => []);
    const snap = rows.length ? rows[0].snapshot_date : null;
    R.aggregateDates(rows.filter((r) => r.snapshot_date === snap)).forEach((d) => { c.dates[d.date] = d; });
    c.pendingDates = new Set(pendingRows.filter((r) => r.listing_id === lid).map((r) => r.stay_date));
    ctx[lid] = c;
  }
  return ctx;
}

// What Claude sees for one flagged listing (compact)
function nightsForPrompt(c) {
  return Object.values(c.dates).map((d) => ({
    d: d.date, s: d.status, price: d.our_price, ms: d.min_stay,
    page: d.shown ? d.best_page : 'not shown', comp_booked: d.mkt_booked, comp_p50: d.mkt_p50, demand: d.demand || undefined,
    lock: c.foreign.has(d.date) ? 'manual override — do not touch' : (c.ours[d.date] ? `PropDesk override (${c.ours[d.date].source || 'autopilot'})` : undefined),
  }));
}

// ── 4. Guardrails (pure — tested in tests/agent.test.js) ────────────────
// changes: [{date, price, min_stay, why}] from Claude for ONE listing
// c: datePacks() entry; eventDates: Set of high-impact event nights
// returns { ok: [proposal rows], rejected: [{date, reason}] }
function validate(changes, c, today, eventDates) {
  eventDates = eventDates || new Set();
  const ok = [], rejected = [], seen = new Set();
  const rej = (date, reason) => rejected.push({ date: date || '?', reason });
  if (!c || !c.inPriceLabs) { (changes || []).forEach((x) => rej(x && x.date, 'Listing not found in PriceLabs')); return { ok, rejected }; }
  (changes || []).slice(0, 60).forEach((x) => {
    const date = x && String(x.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return rej(date, 'Bad date');
    if (seen.has(date)) return rej(date, 'Duplicate date');
    const days = R.daysBetween(today, date);
    if (days < 0 || days > GUARD.horizonDays) return rej(date, `Outside the next ${GUARD.horizonDays} nights`);
    const d = c.dates[date];
    if (!d) return rej(date, 'No calendar data for this night');
    if (d.status !== 'open') return rej(date, 'Night is booked or blocked');
    if (c.foreign.has(date)) return rej(date, 'Night has a manual PriceLabs override');
    const mine = c.ours[date] || null;
    const live = d.our_price;
    const base = mine && mine.original_price != null ? mine.original_price : live;
    const curMs = d.min_stay;
    let price = num(x.price), ms = num(x.min_stay);
    if (price != null) {
      price = Math.round(price);
      if (base == null) { rej(date, 'No current price to compare'); price = null; }
      else if (price < base * (1 - GUARD.maxDrop)) { rej(date, `$${price} is more than ${GUARD.maxDrop * 100}% below $${Math.round(base)}`); price = null; }
      else if (price > base * (1 + GUARD.maxRaise)) { rej(date, `$${price} is more than ${GUARD.maxRaise * 100}% above $${Math.round(base)}`); price = null; }
      else if (c.minPrice != null && price < c.minPrice) { rej(date, `$${price} is below the PriceLabs minimum $${Math.round(c.minPrice)}`); price = null; }
      else if (price < base && (d.demand === 'High Demand' || eventDates.has(date))) { rej(date, 'High-demand / event night — no discounts'); price = null; }
      else if (live != null && Math.abs(price - live) / live < GUARD.minChange) price = null; // too small to bother
    }
    if (ms != null) {
      ms = Math.round(ms);
      if (ms < 1 || ms > GUARD.maxMinStay) { rej(date, `Min stay ${ms} outside 1–${GUARD.maxMinStay}`); ms = null; }
      else if (ms === curMs) ms = null;
    }
    if (price == null && ms == null) return;
    if (ok.length >= GUARD.maxPerListing) return rej(date, `More than ${GUARD.maxPerListing} changes for one listing`);
    seen.add(date);
    ok.push({
      stay_date: date, kind: 'set',
      original_price: base, original_min_stay: mine && mine.original_min_stay != null ? mine.original_min_stay : curMs,
      current_price: live, current_min_stay: curMs,
      proposed_price: price, proposed_min_stay: ms,
      reasons: [String(x.why || 'Agent recommendation').slice(0, 300)],
      evidence: { days_out: days, comp_booked: d.mkt_booked, comp_p50: d.mkt_p50, best_page: d.best_page, shown: d.shown, demand: d.demand, min_price: c.minPrice },
    });
  });
  return { ok, rejected };
}

const money = (v) => (v == null ? '—' : '$' + Math.round(v));
function describe(p) {
  const parts = [];
  if (p.proposed_price != null) parts.push(`${money(p.current_price)} → ${money(p.proposed_price)}`);
  if (p.proposed_min_stay != null) parts.push(`min stay ${p.current_min_stay != null ? p.current_min_stay : '?'} → ${p.proposed_min_stay}`);
  return { date: p.stay_date, change: parts.join(', '), why: (p.reasons || [])[0] || '' };
}

// ── 5. Execute ──────────────────────────────────────────────────────────
async function execute({ runId, actionLines, ctx, today, eventDates }) {
  const result = { applied: [], pending: [], rejected: [], errors: [] };
  for (const line of actionLines) {
    const c = ctx[line.listing_id];
    if (!c) { result.rejected.push({ listing_id: line.listing_id, name: line.listing_id, reason: 'Listing was not flagged in triage' }); continue; }
    const { ok, rejected } = validate(line.changes, c, today, eventDates);
    rejected.forEach((r) => result.rejected.push({ listing_id: c.listing_id, name: c.name, date: r.date, reason: r.reason }));
    if (!ok.length) continue;
    try {
      // Replace anything still pending for these nights (from the daily autopilot or an earlier run).
      await I.sbPatch('pricing_proposals', `listing_id=eq.${encodeURIComponent(c.listing_id)}&status=eq.pending&stay_date=in.(${ok.map((p) => p.stay_date).join(',')})`, { status: 'superseded' }).catch(() => {});
      const isAuto = c.auto && !c.foreignUnknown; // never auto-push blind
      const inserted = await I.sbInsert('pricing_proposals', ok.map((p) => ({
        listing_id: c.listing_id, run_date: today, source: 'agent', agent_run_id: runId,
        stay_date: p.stay_date, kind: p.kind, original_price: p.original_price, original_min_stay: p.original_min_stay,
        current_price: p.current_price, current_min_stay: p.current_min_stay, proposed_price: p.proposed_price, proposed_min_stay: p.proposed_min_stay,
        reasons: p.reasons, evidence: p.evidence, auto: isAuto, status: 'pending',
        error: c.auto && c.foreignUnknown ? 'Black Cabins listing held for approval: existing PriceLabs overrides could not be checked.' : null,
      })));
      if (isAuto) {
        const r = await A.applyProposals(c.listing_id, inserted, { who: 'agent', auto: true, pms: c.pms, ours: c.ours, nickname: c.name, label: 'Agent' });
        const done = inserted.filter((p) => r.applied.includes(p.id));
        const failed = inserted.filter((p) => r.failed.includes(p.id));
        if (done.length) result.applied.push({ listing_id: c.listing_id, name: c.name, edit_id: r.edit_id || null, diagnosis: line.diagnosis || null, changes: done.map(describe) });
        if (failed.length) result.errors.push(`${c.name}: PriceLabs rejected ${failed.length} change(s)`);
      } else {
        result.pending.push({ listing_id: c.listing_id, name: c.name, proposal_ids: inserted.map((p) => p.id), held: c.auto ? 'override check failed' : null, diagnosis: line.diagnosis || null, changes: inserted.map(describe) });
      }
    } catch (e) {
      result.errors.push(`${c.name}: ${e.message.slice(0, 200)}`);
    }
  }
  return result;
}

module.exports = { GUARD, triage, datePacks, nightsForPrompt, validate, execute, describe };
