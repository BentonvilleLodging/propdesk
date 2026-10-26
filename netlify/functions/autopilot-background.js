// netlify/functions/autopilot-background.js
//
// PRICING / MIN-STAY AUTOPILOT — daily (cron-autopilot, 12:05 UTC, after the 11:00 data sync)
// and on demand ("Run autopilot now" on the Approvals tab). No Claude calls.
//
//   1. Book-keeping: mark expired proposals, record whether autopilot-priced dates booked,
//      and write 14-day before/after verdicts on every applied listing edit.
//   2. For every tracked listing: compare the next 21 open nights with what comparable homes
//      are booking at (listing_rank_dates, refreshed daily by the sync) and propose
//      date-specific PRICE and MINIMUM-STAY overrides (lib/autopilot-rules.js).
//   3. Listings tagged "Black Cabins" in Guesty → applied to PriceLabs immediately.
//      Every other listing → 'pending' until a staff member approves on the Approvals tab.
//      Nothing other than price and min stay is ever changed automatically.
//   4. Push notification summary to the team.

const { requireTeam, isScheduledInvocation, internalHeaders } = require('../lib/auth');
const I = require('../lib/intel');
const R = require('../lib/autopilot-rules');
const A = require('../lib/autopilot-apply');

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const STATUS_KEY = 'autopilot_last_run';

async function bookkeeping(today, summary) {
  // Expire stale pending proposals
  await I.sbPatch('pricing_proposals', `status=eq.pending&stay_date=lt.${today}`, { status: 'expired' }).catch(() => {});

  // Did autopilot-priced dates book?
  const past = await I.sbSelect('autopilot_overrides', `select=listing_id,stay_date&outcome=is.null&stay_date=lt.${today}&stay_date=gte.${R.addDays(today, -60)}`).catch(() => []);
  if (past.length) {
    const res = await I.sbSelect('booking_reservations', `select=listing_id,check_in,check_out,status&status=eq.confirmed&check_out=gte.${R.addDays(today, -62)}`).catch(() => []);
    const rows = past.map((o) => ({
      listing_id: o.listing_id, stay_date: o.stay_date,
      outcome: res.some((b) => b.listing_id === o.listing_id && b.check_in <= o.stay_date && b.check_out > o.stay_date) ? 'booked' : 'unbooked',
      updated_at: new Date().toISOString(),
    }));
    for (const r of rows) await I.sbPatch('autopilot_overrides', `listing_id=eq.${encodeURIComponent(r.listing_id)}&stay_date=eq.${r.stay_date}`, { outcome: r.outcome, updated_at: r.updated_at }).catch(() => {});
    summary.outcomes_recorded = rows.length;
  }

  // 14-day verdicts on applied edits (content, amenities, base/min/max, approved pricing)
  const edits = await I.sbSelect('listing_edits', `select=id,listing_id,target,created_at&status=eq.applied&outcome=is.null&created_at=lte.${new Date(Date.now() - 14 * 86400000).toISOString()}&created_at=gte.${new Date(Date.now() - 45 * 86400000).toISOString()}`).catch(() => []);
  let verdicts = 0;
  for (const e of edits) {
    try {
      const d0 = e.created_at.slice(0, 10);
      const [b] = await I.sbSelect('pricelabs_daily', `select=snapshot_date,occupancy_pct_30d,market_occupancy_pct_30d&listing_id=eq.${encodeURIComponent(e.listing_id)}&snapshot_date=lte.${d0}&order=snapshot_date.desc&limit=1`);
      const [a] = await I.sbSelect('pricelabs_daily', `select=snapshot_date,occupancy_pct_30d,market_occupancy_pct_30d&listing_id=eq.${encodeURIComponent(e.listing_id)}&order=snapshot_date.desc&limit=1`);
      const [rb] = await I.sbSelect('pricelabs_intel', `select=ranking&listing_id=eq.${encodeURIComponent(e.listing_id)}&snapshot_date=lte.${d0}&order=snapshot_date.desc&limit=1`).catch(() => []);
      const [ra] = await I.sbSelect('pricelabs_intel', `select=ranking&listing_id=eq.${encodeURIComponent(e.listing_id)}&order=snapshot_date.desc&limit=1`).catch(() => []);
      if (!b || !a) continue;
      const gap = (x) => (num(x.occupancy_pct_30d) != null && num(x.market_occupancy_pct_30d) != null ? num(x.occupancy_pct_30d) - num(x.market_occupancy_pct_30d) : null);
      const p1 = (x) => (x && x.ranking && x.ranking.diagnosis ? num(x.ranking.diagnosis.pct_page1) : null);
      const g0 = gap(b), g1 = gap(a), q0 = p1(rb), q1 = p1(ra);
      const score = (g1 != null && g0 != null ? g1 - g0 : 0) + (q1 != null && q0 != null ? (q1 - q0) / 2 : 0);
      const verdict = score >= 5 ? 'improved' : score <= -5 ? 'worse' : 'no clear change';
      await I.sbPatch('listing_edits', `id=eq.${e.id}`, { outcome: { verdict, measured: a.snapshot_date, occ_vs_market_before: g0, occ_vs_market_after: g1, page1_pct_before: q0, page1_pct_after: q1 } });
      verdicts++;
    } catch (err) { /* keep going */ }
  }
  summary.verdicts = verdicts;
}

exports.handler = async function (event) {
  const auth = isScheduledInvocation(event) ? { role: 'internal' } : await requireTeam(event, ['staff']);
  if (!auth) { console.warn('autopilot: unauthorized'); return; }
  const today = I.today();
  const summary = { date: today, listings: 0, auto_applied: 0, pending: 0, failed: 0, skipped: [], errors: [] };
  const [run] = await I.sbInsert('autopilot_runs', [{ summary: { running: true } }]).catch(() => [null]);
  await I.cacheSet(STATUS_KEY, { running: true, startedAt: new Date().toISOString() }, 3 * 86400000).catch(() => {});

  try {
    await bookkeeping(today, summary).catch((e) => summary.errors.push('bookkeeping: ' + e.message));

    // Fresh Guesty tags — the auto-apply decision always comes from Guesty itself.
    const g = await I.guestyGet(`/v1/listings?limit=100&fields=${encodeURIComponent('_id nickname tags isListed')}`);
    const gl = g.results || g.data || (Array.isArray(g) ? g : []);
    const autoSet = new Set(gl.filter((l) => R.isAutoApplyListing(l)).map((l) => l._id));
    summary.black_cabins = autoSet.size;

    const reg = await I.sbSelect('listing_registry', 'select=listing_id,nickname,title&is_listed=eq.true&tracked=eq.true');
    const plMap = await A.plListingMap();
    const mi = await I.sbSelect('market_intel', 'select=events&order=created_at.desc&limit=1').catch(() => []);
    const eventDates = new Set();
    ((mi[0] && mi[0].events) || []).filter((e) => e.demand_impact === 'high' && e.start_date).forEach((e) => {
      const end = e.end_date || e.start_date;
      for (let d = R.addDays(e.start_date, -1); d <= end; d = R.addDays(d, 1)) eventDates.add(d); // include the night before
    });
    const activeOurs = await I.sbSelect('autopilot_overrides', `select=*&active=eq.true&stay_date=gte.${today}`).catch(() => []);
    const until = R.addDays(today, R.RULES.horizonDays + 10);
    const counts = { auto: {}, pending: {} };

    for (const l of reg) {
      const lid = l.listing_id, name = l.nickname || l.title || lid;
      try {
        const p = plMap[String(lid)];
        if (!p) { summary.skipped.push(`${name}: not in PriceLabs`); continue; }
        const pms = p.pms || 'guesty';
        const rows = await I.sbSelect('listing_rank_dates', `select=snapshot_date,stay_date,status,our_price,min_stay,rank,page,demand,mkt_p50,mkt_median_booked&listing_id=eq.${encodeURIComponent(lid)}&snapshot_date=gte.${R.addDays(today, -2)}&stay_date=gte.${today}&stay_date=lte.${until}&order=snapshot_date.desc&limit=1000`);
        if (!rows.length) { summary.skipped.push(`${name}: no fresh calendar/rank data`); continue; }
        const snap = rows[0].snapshot_date;
        const dates = R.aggregateDates(rows.filter((r) => r.snapshot_date === snap));

        const ours = {}; activeOurs.filter((o) => o.listing_id === lid).forEach((o) => { ours[o.stay_date] = { ...o, original_price: num(o.original_price), price: num(o.price) }; });
        let foreign = new Set(), foreignUnknown = false;
        try { (await A.getOverrides(lid, pms)).forEach((o) => { if (!ours[o.date]) foreign.add(o.date); }); }
        catch (e) { foreignUnknown = true; summary.errors.push(`${name}: couldn't read PriceLabs overrides (${e.message.slice(0, 120)})`); }

        const props = R.proposeForListing({ dates, today, minPrice: num(p.min), ours, foreign, eventDates });
        summary.listings++;
        // Today's run replaces any earlier pending proposals for this listing.
        await I.sbPatch('pricing_proposals', `listing_id=eq.${encodeURIComponent(lid)}&status=eq.pending`, { status: 'superseded' }).catch(() => {});
        if (!props.length) continue;

        const isAuto = autoSet.has(lid) && !foreignUnknown; // never auto-push blind
        const inserted = await I.sbInsert('pricing_proposals', props.map((x) => ({
          listing_id: lid, run_date: today, stay_date: x.stay_date, kind: x.kind,
          original_price: x.original_price, original_min_stay: x.original_min_stay, current_price: x.current_price, current_min_stay: x.current_min_stay,
          proposed_price: x.proposed_price, proposed_min_stay: x.proposed_min_stay, reasons: x.reasons, evidence: x.evidence,
          auto: isAuto, status: 'pending',
          error: autoSet.has(lid) && foreignUnknown ? 'Black Cabins listing held for approval: existing PriceLabs overrides could not be checked.' : null,
        })));
        if (isAuto) {
          const r = await A.applyProposals(lid, inserted, { who: 'autopilot', auto: true, pms, ours, nickname: name });
          summary.auto_applied += r.applied.length; summary.failed += r.failed.length;
          if (r.applied.length) counts.auto[name] = r.applied.length;
          if (r.failed.length) summary.errors.push(`${name}: PriceLabs rejected ${r.failed.length} change(s) — see Approvals tab`);
        } else {
          summary.pending += inserted.length; counts.pending[name] = inserted.length;
        }
      } catch (e) {
        summary.errors.push(`${name}: ${e.message.slice(0, 200)}`);
      }
    }
    summary.by_listing = counts;

    // Team push summary
    if (summary.auto_applied || summary.pending || summary.failed) {
      const msg = [summary.auto_applied ? `${summary.auto_applied} price/min-stay changes applied on Black Cabins` : null,
        summary.pending ? `${summary.pending} changes on ${Object.keys(counts.pending).length} other listings need approval` : null,
        summary.failed ? `${summary.failed} failed` : null].filter(Boolean).join(' · ');
      const base = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
      await fetch(`${base}/.netlify/functions/send-push`, { method: 'POST', headers: internalHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ title: '💲 Pricing autopilot', message: msg, tag: 'autopilot-' + today, url: '/' }) }).catch(() => {});
    }
    summary.success = true; // per-listing problems are listed in summary.errors as warnings
  } catch (e) {
    summary.success = false; summary.fatalError = e.message;
  }
  summary.completedAt = new Date().toISOString();
  if (run) await I.sbPatch('autopilot_runs', `id=eq.${run.id}`, { summary, completed_at: summary.completedAt, error: summary.fatalError || null }).catch(() => {});
  await I.cacheSet(STATUS_KEY, summary, 3 * 86400000).catch(() => {});
};
