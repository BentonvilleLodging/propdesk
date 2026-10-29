// netlify/functions/listing-intel-analyze-background.js
//
// LISTING INTELLIGENCE — analysis (Background Function, 15-min window).
//
// CLAUDE BUDGET: PropDesk is capped at 2 Claude API requests per week (see
// supabase_claude_budget.sql + lib/intel.js). So this job makes exactly ONE request that
// covers the whole portfolio AND the market research:
//   • Scheduled weekly (Monday 11:40 UTC, after the daily data sync) → kind 'weekly'.
//   • "Re-run Analysis" from the Search Health page → kind 'manual' (uses the one spare
//     weekly slot). ?listing_id= limits the run to one listing, but still costs a full slot.
//
// Daily data collection (Guesty / PriceLabs, no Claude) is unchanged and runs every day;
// the deterministic rank diagnosis (lib/rankdiag.js) is refreshed daily without Claude.
//
// One request = compact evidence pack for every tracked listing + web search for upcoming
// NWA demand drivers. Claude answers in NDJSON (one JSON object per line) so that if the
// run is ever cut off, every listing finished before that point is still saved:
//   {"type":"market", ...}      → market_intel
//   {"type":"portfolio", ...}   → app_cache 'portfolio_brief'
//   {"type":"listing", ...}     → listing_analyses (one row per listing, history kept)
// Status → app_cache 'listing_intel_last_run'.
//
// SEARCH HEALTH AGENT (Mon + Thu, both weekly Claude slots — see supabase_agent.sql):
// before the request, lib/agent.js triages every listing (no Claude) and attaches the next 30
// nights for the flagged ones. Claude adds one {"type":"actions"} line per flagged listing with
// date price / min-stay changes. Guardrails validate them; "Black Cabins" listings are pushed to
// PriceLabs immediately, all others wait for approval. Result → agent_runs + team push; the
// Listing Intelligence page shows it in a summary modal.

const { requireTeam, isScheduledInvocation } = require('../lib/auth');
const I = require('../lib/intel');
const AG = require('../lib/agent');
const R = require('../lib/autopilot-rules');
const { internalHeaders } = require('../lib/auth');

const STATUS_KEY = 'listing_intel_last_run';

const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const r0 = (v) => (v == null ? null : Math.round(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const avg = (a) => { const x = a.filter((v) => v != null && Number.isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : s);

// What Airbnb itself says drives ranking (help article 39) + PriceLabs levers we control.
const SYSTEM_PROMPT = `You are the revenue-management and search-visibility strategist for Bentonville Lodging Co. (BLC), a professional short-term-rental manager in Bentonville / Northwest Arkansas (mountain-biking trails, Crystal Bridges, Walmart HQ business travel, Beaver Lake). BLC earns a percentage of each listing's net accommodation revenue, so the goal is more booked nights at strong rates on every listing.

How Airbnb says it ranks homes (Airbnb Help Center, "How search results work"):
- PRICE: total price is compared with similar nearby listings for the same dates; listings priced below comparable options tend to rank higher. Price has a large effect.
- QUALITY: listing content (photos, video, description, amenities), guest ratings and reviews, host communication, cancellations.
- POPULARITY: wishlist saves, bookings, messages — i.e. click-through and conversion. Listings that convert get shown more, which compounds.
- AVAILABILITY & FLEXIBILITY: more open dates and flexible stay lengths (lower minimum nights) improve visibility. Instant Book helps (BLC already has Instant Book ON for every listing — never recommend enabling it).
- Recency of reviews matters; the Guest Favorite badge requires a strong review count and rating. Responsiveness and low cancellations matter.

Levers BLC controls in PriceLabs (recommend concrete values where the data supports it): base price, minimum price, maximum price; minimum-stay rules (default min stay, last-minute min stay, gap/orphan-night fill so 1–2 night gaps between bookings are bookable); last-minute pricing (discount within N days, gradual vs flat); far-out premium; day-of-week / weekend adjustments; occupancy-based adjustments; seasonal profiles; date-specific overrides for known events.

Rules:
- Every recommendation must be specific and doable this week, and tied to evidence in the data you are given (cite the number or review). No generic advice ("improve photos", "respond quickly") unless you say exactly what and why (e.g. "Reshoot the cover photo at golden hour showing the hot tub — Optimizer image score is C and 3 reviews praise the hot tub, which is not in the first 5 photos").
- "search_actions" are things the BLC team or owner can physically do: listing title/description/photo/amenity changes, adding guest-requested items, fixing recurring complaints, calendar opening, cleaning/maintenance fixes, review-generation tactics, etc. Order by expected impact on bookings.
- "pricelabs_settings": only settings that should CHANGE. Show the current value if known (from customizations / pricelabs data) and the recommended value. If a current value isn't in the data, write "check in PriceLabs". Use market percentiles, occupancy vs market, open-night demand, booking lead time and min-stay distribution to justify. When occupancy is well behind market for the next 7–30 days with many open nights, favor price/min-stay moves; when ahead of market, favor raising base/min or weekend premiums. Include date-specific overrides for upcoming events when relevant.
- "review_themes": recurring topics across reviews (positive and negative). Private feedback is internal only.
- "owner_items": physical improvements or purchases the OWNER should consider, only when supported by reviews, category ratings, amenities vs market, or optimizer scores (e.g. repeated bed complaints → replace mattresses; no hot tub in a market segment that values it). Include a rough cost range and the expected benefit.
- "health_score" 0–100: overall booking health vs its market (pace, pricing position, reviews, content).
- AMENITY FILTERS: Airbnb guests filter heavily by amenities (hot tub, pool, EV charger, dedicated workspace, free parking, washer/dryer, self check-in, pets allowed, king bed, fire pit, BBQ grill, crib, gym, lake access/waterfront). If reviews or the description show an amenity that is missing from the amenities list, recommend ticking it (missed search filter). If the target guest would expect an amenity the home lacks, put it in owner_items.
- Write for the listing's target guest (target_guest; team-set values override Claude's suggestion).
- recent_changes_by_team lists what was already changed; don't re-recommend it — instead say whether it appears to be working (rank/occupancy since) when the data allows.
- Never invent data. If something important is missing, list it in "data_gaps".
- Keep "summary" to 3–5 sentences: the situation, the likely cause, and the single most important move.

Respond with ONLY a JSON object, no markdown, exactly:
{"health_score": 0, "summary": "", "search_actions": [{"priority": 1, "category": "Listing content|Photos|Amenities|Pricing|Availability|Guest experience|Reviews|Operations", "action": "", "why": "", "effort": "low|medium|high", "impact": "low|medium|high", "owner": "BLC team|Owner|Cleaning team"}], "pricelabs_settings": [{"setting": "", "current": "", "recommended": "", "why": ""}], "review_themes": [{"theme": "", "sentiment": "positive|negative|mixed", "mentions": 0, "evidence": ""}], "owner_items": [{"item": "", "evidence": "", "priority": "high|medium|low", "est_cost": "", "expected_benefit": ""}], "data_gaps": [""]}`;

function compactJson(o, max) {
  if (o == null) return null;
  const t = JSON.stringify(o);
  return t.length <= max ? o : { truncated_json: t.slice(0, max) };
}

function latestBy(rows, key) { const m = {}; rows.forEach((r) => { if (!m[r[key]]) m[r[key]] = r; }); return m; }

function pickMetrics(m) {
  if (!m) return null;
  const L = m.listing_level || {}, M = m.market_level || {};
  const keys = ['-30', '-7', '7', '15', '30', '60', '90'];
  const pick = (o) => { if (!o || typeof o !== 'object') return o; const r = {}; keys.forEach((k) => { if (o[k] != null) r[k] = typeof o[k] === 'number' ? Math.round(o[k] * 10) / 10 : o[k]; }); return Object.keys(r).length ? r : null; };
  return {
    note: 'keys are days-from-today; negative = past window, positive = future window',
    listing: { occupancy: pick(L.occupancy), adr: pick(L.adr), revenue: pick(L.revenue), stly_revenue: pick(L.stly_revenue), stly_occupancy: pick(L.stly_occupancy), bp_ratio: L.bp_ratio, last_booked_date: L.last_booked_date, min_price_days: L.min_prices },
    market: { occupancy: pick(M.occupancy), adr: pick(M.adr) },
  };
}

async function buildPacks(onlyId) {
  const since30 = daysAgo(30).slice(0, 10);
  const [reg, price, priceOld, intel, gaps, revSnap, comp, perf, fees] = await Promise.all([
    I.sbSelect('listing_registry', 'select=*&is_listed=eq.true&tracked=eq.true'),
    I.sbSelect('pricelabs_daily', `select=*&snapshot_date=gte.${daysAgo(3).slice(0, 10)}&order=snapshot_date.desc`),
    I.sbSelect('pricelabs_daily', `select=listing_id,snapshot_date,base_price,occupancy_pct_30d,market_occupancy_pct_30d&snapshot_date=gte.${since30}&snapshot_date=lte.${daysAgo(13).slice(0, 10)}&order=snapshot_date.asc`),
    I.sbSelect('pricelabs_intel', `select=*&snapshot_date=gte.${daysAgo(3).slice(0, 10)}&order=snapshot_date.desc`),
    I.sbSelect('calendar_gap_snapshots', `select=*&snapshot_date=gte.${daysAgo(3).slice(0, 10)}&order=snapshot_date.desc`),
    I.sbSelect('guesty_review_snapshots', `select=*&snapshot_date=gte.${daysAgo(3).slice(0, 10)}&order=snapshot_date.desc`),
    I.sbSelect('listing_completeness_snapshots', `select=*&snapshot_date=gte.${daysAgo(3).slice(0, 10)}&order=snapshot_date.desc`),
    I.sbSelect('airbnb_performance_import', 'select=*&order=period_end.desc'),
    I.sbSelect('listing_fee_config', 'select=listing_id,mgmt_fee_pct'),
  ]);
  const profiles = await I.sbSelect('listing_profile', 'select=*').catch(() => []);
  const PROF = {}; profiles.forEach((r) => { PROF[r.listing_id] = r; });
  const edits = await I.sbSelect('listing_edits', `select=listing_id,target,summary,created_at,status&created_at=gte.${daysAgo(45)}&order=created_at.desc`).catch(() => []);
  const P = latestBy(price, 'listing_id'), PO = latestBy(priceOld, 'listing_id'), IN = latestBy(intel, 'listing_id'), G = latestBy(gaps, 'listing_id'), RS = latestBy(revSnap, 'listing_id'), C = latestBy(comp, 'listing_id'), PF = latestBy(perf, 'listing_id');

  const listings = reg.filter((l) => !onlyId || l.listing_id === onlyId);
  // Bookings (last 180 days created + all future stays)
  const res = await I.sbSelect('booking_reservations', `select=listing_id,status,source,created_at_guesty,check_in,check_out,nights,fare_accommodation,commissionable_rev&or=(created_at_guesty.gte.${daysAgo(180)},check_in.gte.${I.today()})`).catch(() => []);
  const portfolioOcc = avg(Object.values(P).map((p) => num(p.occupancy_pct_30d)));
  const portfolioMkt = avg(Object.values(P).map((p) => num(p.market_occupancy_pct_30d)));

  const packs = [];
  for (const l of listings) {
    const lid = l.listing_id;
    const p = P[lid] || {}, po = PO[lid] || null, it = IN[lid] || {}, g = G[lid] || {}, rs = RS[lid] || {}, c = C[lid] || {}, pf = PF[lid] || null;
    const reviews = await I.sbSelect('guesty_reviews', `select=channel,reviewed_at,rating_5,category_ratings,public_review,private_feedback&listing_id=eq.${lid}&order=reviewed_at.desc&limit=60`).catch(() => []);
    const cat = {};
    reviews.forEach((r) => { Object.entries(r.category_ratings || {}).forEach(([k, v]) => { (cat[k] = cat[k] || []).push(num(v)); }); });
    const catAvg = {}; Object.keys(cat).forEach((k) => { catAvg[k] = { avg: r1(avg(cat[k])), n: cat[k].length, below5: cat[k].filter((v) => v < 5).length }; });
    const lowRated = reviews.filter((r) => r.rating_5 != null && r.rating_5 < 5).slice(0, 8);

    const mine = res.filter((r) => r.listing_id === lid);
    const created90 = mine.filter((r) => r.status === 'confirmed' && r.created_at_guesty && r.created_at_guesty >= daysAgo(90));
    const lead = created90.map((r) => (new Date(r.check_in) - new Date(r.created_at_guesty)) / 86400000).filter((x) => x >= 0);
    const adrs = created90.map((r) => (num(r.fare_accommodation) && r.nights ? num(r.fare_accommodation) / r.nights : null));
    const futureConf = mine.filter((r) => r.status === 'confirmed' && r.check_in >= I.today());
    const channelMix = created90.reduce((m, r) => { const k = /airbnb/i.test(r.source || '') ? 'airbnb' : /homeaway|vrbo/i.test(r.source || '') ? 'vrbo' : /booking/i.test(r.source || '') ? 'booking.com' : 'direct/other'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const lastCreated = mine.map((r) => r.created_at_guesty).filter(Boolean).sort().pop();

    const raw = (c.raw || {});
    packs.push({
      listing_id: lid,
      name: l.nickname || l.title,
      pack: {
        listing: { nickname: l.nickname, airbnb_title: raw.title || l.title, title_length: raw.title_length || (l.title || '').length, bedrooms: l.bedrooms, sleeps: l.accommodates, airbnb_url: l.airbnb_listing_id ? `https://www.airbnb.com/rooms/${l.airbnb_listing_id}` : null },
        pricing_now: { base: num(p.base_price), pricelabs_recommended_base: num(p.recommended_price), min: num(p.min_price), max: num(p.max_price), default_min_stay: num(p.min_stay), cleaning_fee: num(p.cleaning_fee), last_price_sync: p.last_refreshed_at || null, push_enabled: p.raw ? p.raw.push_enabled : null },
        occupancy_vs_market_pct: { next7: [num(p.occupancy_pct_7d), num(p.market_occupancy_pct_7d)], next30: [num(p.occupancy_pct_30d), num(p.market_occupancy_pct_30d)], next60: [num(p.occupancy_pct_60d), num(p.market_occupancy_pct_60d)], format: '[listing, market]' },
        two_weeks_ago: po ? { date: po.snapshot_date, base: num(po.base_price), occ30: num(po.occupancy_pct_30d), market_occ30: num(po.market_occupancy_pct_30d) } : null,
        portfolio_avg_occ30: [r1(portfolioOcc), r1(portfolioMkt)],
        pricelabs_metrics: pickMetrics(it.metrics),
        market_neighborhood: it.neighborhood || null,
        pricelabs_current_settings: compactJson(it.customizations, 3500),
        listing_optimizer: it.optimizer || null,
        airbnb_search_ranking: it.ranking || null,
        next_90_days_calendar: it.calendar || null,
        calendar_gaps_next60: { gaps: g.gap_count_60d, nights: g.gap_nights_60d },
        bookings: {
          created_last_90d: created90.length, nights_last_90d: created90.reduce((s, r) => s + (r.nights || 0), 0),
          avg_los: r1(avg(created90.map((r) => r.nights))), avg_lead_days: r0(avg(lead)), median_lead_days: lead.length ? r0(lead.sort((a, b) => a - b)[Math.floor(lead.length / 2)]) : null,
          avg_adr: r0(avg(adrs)), channel_mix_90d: channelMix, last_booking_created: lastCreated ? lastCreated.slice(0, 10) : null,
          future_confirmed_stays: futureConf.length, future_booked_nights: futureConf.reduce((s, r) => s + (r.nights || 0), 0),
          canceled_last_90d: mine.filter((r) => r.status === 'canceled' && r.created_at_guesty >= daysAgo(90)).length,
        },
        reviews: {
          total: rs.review_count, avg_rating_5: rs.avg_rating, days_since_last: rs.days_since_review, by_channel: rs.raw && rs.raw.by_channel, airbnb_count: rs.raw && rs.raw.airbnb_count, airbnb_avg: rs.raw && rs.raw.airbnb_avg,
          category_averages: catAvg,
          recent_public: reviews.filter((r) => r.public_review).slice(0, 18).map((r) => ({ d: (r.reviewed_at || '').slice(0, 10), ch: r.channel, stars: r.rating_5, text: clip(r.public_review, 420) })),
          below_5_star: lowRated.map((r) => ({ d: (r.reviewed_at || '').slice(0, 10), stars: r.rating_5, cats: r.category_ratings, text: clip(r.public_review, 300) })),
          private_feedback_internal: reviews.filter((r) => r.private_feedback).slice(0, 10).map((r) => ({ d: (r.reviewed_at || '').slice(0, 10), text: clip(r.private_feedback, 300) })),
        },
        listing_content: { photos: c.photo_count, photos_missing_captions: raw.photo_captions_missing, description_chars: c.description_length, amenities_count: c.amenities_count, amenities: (raw.amenities || []).slice(0, 120), summary_excerpt: clip(raw.summary, 600) },
        airbnb_insights_csv: pf ? { period: `${pf.period_start} to ${pf.period_end}`, bookings: pf.bookings, nights: pf.nights_booked, adr: num(pf.avg_daily_rate), booking_window_days: num(pf.avg_booking_window), view_to_contact_pct: num(pf.view_to_contact_rate), contact_to_book_pct: num(pf.contact_to_book_rate) } : 'not imported',
        target_guest: PROF[lid] ? { team_set: { primary: PROF[lid].target_guest, secondary: PROF[lid].secondary_guests, selling_points: PROF[lid].selling_points }, claude_suggested: PROF[lid].suggested } : null,
        recent_changes_by_team: edits.filter((e) => e.listing_id === lid && e.status !== 'failed').slice(0, 12).map((e) => ({ date: (e.created_at || '').slice(0, 10), what: e.summary, status: e.status })),
        data_errors: it.errors || null,
      },
    });
  }
  return packs;
}

// ── Compact pack: everything the per-listing analysis used, at ~1/6 the tokens ─────
const FILTER_AMENITIES = [
  ['Hot tub', /hot tub|jacuzzi|spa\b/i], ['Pool', /pool(?! table)/i], ['EV charger', /ev charg|electric vehicle/i],
  ['Dedicated workspace', /workspace|desk/i], ['Free parking', /free parking|garage/i], ['Washer', /^washer/i], ['Dryer', /^dryer/i],
  ['Self check-in', /self check|keypad|smart lock|lockbox/i], ['Pets allowed', /pets allowed/i], ['Fire pit', /fire pit/i],
  ['BBQ grill', /bbq|barbe/i], ['Crib', /crib|pack .n play/i], ['Gym', /\bgym|exercise/i], ['Waterfront / lake access', /waterfront|lake access|lake front/i],
  ['Bike storage', /bike|bicycle/i], ['Game room', /game room|pool table|foosball|arcade/i], ['Air conditioning', /air condition/i], ['Kitchen', /^kitchen$/i],
];

function compactPack(pk) {
  const it = pk.airbnb_search_ranking || null;
  const dg = it && it.diagnosis;
  const opt = pk.listing_optimizer && pk.listing_optimizer.categories;
  const am = (pk.listing_content && pk.listing_content.amenities) || [];
  const R = pk.reviews || {};
  return {
    listing: pk.listing,
    target_guest: pk.target_guest,
    pricing_now: pk.pricing_now,
    occupancy_vs_market_pct: pk.occupancy_vs_market_pct,
    two_weeks_ago: pk.two_weeks_ago,
    pricelabs_metrics: pk.pricelabs_metrics,
    market_neighborhood: pk.market_neighborhood,
    pricelabs_current_settings: compactJson(pk.pricelabs_current_settings, 1200),
    calendar_windows: pk.next_90_days_calendar && pk.next_90_days_calendar.windows ? pk.next_90_days_calendar.windows : compactJson(pk.next_90_days_calendar, 700),
    calendar_gaps_next60: pk.calendar_gaps_next60,
    airbnb_rank: it ? {
      avg_page: it.avg_page, avg_rank: it.avg_rank, best_rank: it.best_rank,
      page1: dg ? `${dg.page1_dates} dates (${dg.pct_page1}%)` : null,
      off_page1_reasons: dg && dg.reasons ? dg.reasons.map((r) => `${r.label}: ${r.dates} dates`) : null,
      worst_dates: dg && dg.worst_dates ? dg.worst_dates.slice(0, 4).map((w) => ({ date: w.date, rank: w.rank, price: w.price, mkt_p50: w.mkt_p50 })) : null,
    } : null,
    optimizer_grades: opt ? Object.fromEntries(Object.entries(opt).map(([k, v]) => [k, { score: v && v.score, tip: clip(v && v.tip, 180) }])) : null,
    bookings: pk.bookings,
    reviews: {
      total: R.total, avg_rating_5: R.avg_rating_5, days_since_last: R.days_since_last, airbnb_count: R.airbnb_count, airbnb_avg: R.airbnb_avg,
      category_averages: R.category_averages,
      recent_public: (R.recent_public || []).slice(0, 5).map((r) => ({ ...r, text: clip(r.text, 220) })),
      below_5_star: (R.below_5_star || []).slice(0, 4).map((r) => ({ d: r.d, stars: r.stars, text: clip(r.text, 220) })),
      private_feedback_internal: (R.private_feedback_internal || []).slice(0, 3).map((r) => ({ d: r.d, text: clip(r.text, 180) })),
    },
    listing_content: {
      photos: pk.listing_content && pk.listing_content.photos,
      photos_missing_captions: pk.listing_content && pk.listing_content.photos_missing_captions,
      description_chars: pk.listing_content && pk.listing_content.description_chars,
      amenities_count: pk.listing_content && pk.listing_content.amenities_count,
      search_filter_amenities_missing: FILTER_AMENITIES.filter(([, re]) => !am.some((a) => re.test(a))).map(([n]) => n),
      summary_excerpt: clip(pk.listing_content && pk.listing_content.summary_excerpt, 260),
    },
    airbnb_insights_csv: pk.airbnb_insights_csv,
    recent_changes_by_team: (pk.recent_changes_by_team || []).slice(0, 6),
  };
}

const KNOWLEDGE = SYSTEM_PROMPT.split('Respond with ONLY')[0];

const PORTFOLIO_PROMPT = KNOWLEDGE + `
This is ONE weekly request that covers the whole portfolio, so be complete but tight.

STEP 1 — MARKET RESEARCH (only if web search is available in this request): search for events in the next 120 days that drive lodging demand in Bentonville, Rogers, Bella Vista, Springdale and Fayetteville: cycling/mountain-bike races and festivals, Walmart corporate weeks (associates/shareholders, vendor summits), University of Arkansas football home games and graduation, Crystal Bridges/Momentary major exhibitions, Walmart AMP concerts, large conferences, holidays. Only include events with dates you found in sources. If web search is not available, use the "known_upcoming_events" you are given and skip the market line.

STEP 2 — PORTFOLIO: compare listings to each other and to the market. Who is losing share and why, which pricing pattern repeats across many listings, and which events need date-specific pricing.

STEP 3 — EVERY LISTING in data.listings, using its exact listing_id.

OUTPUT FORMAT — NDJSON: one complete JSON object per line, no markdown, no prose, no blank lines. Lines, in this order:
{"type":"market","events":[{"name":"","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","location":"","demand_impact":"high|medium|low","notes":"why it matters for lodging","source_url":""}],"notes":"1-2 sentences on the demand outlook"}
{"type":"portfolio","summary":"3-4 sentences","top_moves":[{"move":"","listings":["nickname"],"why":""}],"event_pricing":[{"event":"","dates":"","listings":["nickname"],"suggested_override":""}]}
{"type":"listing","listing_id":"","health_score":0,"summary":"2-3 sentences: situation, likely cause, single most important move","search_actions":[{"priority":1,"category":"Listing content|Photos|Amenities|Pricing|Availability|Guest experience|Reviews|Operations","action":"","why":"","effort":"low|medium|high","impact":"low|medium|high","owner":"BLC team|Owner|Cleaning team"}],"pricelabs_settings":[{"setting":"","current":"","recommended":"","why":""}],"review_themes":[{"theme":"","sentiment":"positive|negative|mixed","mentions":0,"evidence":""}],"owner_items":[{"item":"","evidence":"","priority":"high|medium|low","est_cost":"","expected_benefit":""}],"data_gaps":[""]}
...one "listing" line per listing.

STEP 4 — PRICING ACTIONS for every listing in data.flagged (and ONLY those), after all "listing" lines. data.flagged gives why triage flagged it and its next 30 nights: d=date, s=status, price, ms=min stay, page=best Airbnb page (or "not shown"), comp_booked=what comparable homes are booking at that night, comp_p50=comparable median list price, lock=existing override. Propose date-specific changes that win back search placement and bookings:
- Price open nights that are off page 1 / not shown and priced well above comp_booked toward ~0–5% above comp_booked. Raise nights clearly underpriced vs comps or inside a high-demand event.
- Lower min stay to fill gaps between bookings and for nights inside 7 days; raise it only for event nights.
- Never touch nights with s other than "open" or a lock of "manual override". Never discount High Demand or event nights. Stay within -15% / +30% of the current price and at or above min_price.
- Prefer fewer, higher-impact changes; no change is a valid answer. "why" cites the numbers.
{"type":"actions","listing_id":"","diagnosis":"1-2 sentences: why this listing is losing visibility","changes":[{"date":"YYYY-MM-DD","price":0,"min_stay":null,"why":""}]}
Use null for price or min_stay to leave it unchanged. One "actions" line per flagged listing (empty changes allowed).

Limits per listing: max 4 search_actions, max 4 pricelabs_settings, max 3 review_themes, max 2 owner_items, max 2 data_gaps. Keep each "why"/"evidence" to one sentence that cites the number.
"search_filter_amenities_missing" lists high-value Airbnb filters NOT on the amenity list — only recommend ticking one if reviews/description show the home has it; otherwise consider it for owner_items.`;

function parseNdjson(text) {
  const out = [];
  String(text || '').replace(/```(?:json|ndjson)?/g, '').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    try { out.push(JSON.parse(t)); } catch (e) { /* incomplete last line when cut off */ }
  });
  return out;
}

const clampScore = (v) => (num(v) != null ? Math.max(0, Math.min(100, Math.round(num(v)))) : null);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

const QUEUE_MAX = 15;
async function queueActions(rows, byId) {
  const open = await I.sbSelect('todos', 'select=title,property&completed=eq.false').catch(() => []);
  const seen = new Set(open.map((t) => (t.property || '') + '|' + (t.title || '').toLowerCase()));
  const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const rank = { high: 0, medium: 1, low: 2 };
  const picks = [];
  rows.forEach((r) => {
    const acts = (r.search_actions || []).filter((a) => a && a.action && !/pricing|availability/i.test(a.category || ''))
      .sort((a, b) => (rank[a.impact] ?? 3) - (rank[b.impact] ?? 3) || (a.priority || 9) - (b.priority || 9));
    const a = acts[0];
    if (!a || a.impact === 'low') return;
    const property = byId[r.listing_id] ? byId[r.listing_id].name : '';
    const title = String(a.action).slice(0, 140);
    if (seen.has(property + '|' + title.toLowerCase())) return;
    picks.push({ impact: a.impact, todo: {
      title, property, category: 'listing', priority: a.impact === 'high' ? 'high' : 'medium', due_date: due,
      assigned_to: a.owner || 'BLC team', completed: false,
      description: [a.why, a.effort ? 'Effort: ' + a.effort : null, 'From the Monday listing analysis'].filter(Boolean).join(' · '),
    } });
  });
  picks.sort((x, y) => (rank[x.impact] ?? 3) - (rank[y.impact] ?? 3));
  const todos = picks.slice(0, QUEUE_MAX).map((p) => p.todo);
  if (todos.length) await I.sbInsert('todos', todos);
  return todos.length;
}

exports.handler = async function (event) {
  const auth = isScheduledInvocation(event) ? { role: 'internal' } : await requireTeam(event, ['staff']);
  if (!auth) { console.warn('listing-intel-analyze: unauthorized'); return; }
  const qs = event.queryStringParameters || {};
  const onlyId = qs.listing_id || null;
  let body = {}; try { body = JSON.parse(event.body || '{}') || {}; } catch (e) {}
  // Only the Monday cron (lib/dispatch.js sends {source:'cron'} with the internal key) is 'weekly'.
  const kind = auth.role === 'internal' && (body.source === 'cron' || body.next_run) && !onlyId ? 'weekly' : 'manual';
  const status = { startedAt: new Date().toISOString(), listing_id: onlyId, kind, done: 0, failed: [], model: I.CLAUDE_MODEL };
  await I.cacheSet(STATUS_KEY, { ...status, running: true }, 8 * 86400000).catch(() => {});
  let agentRun = null;
  try {
    const packs = await buildPacks(onlyId);
    if (!packs.length) throw new Error('No tracked listings to analyze.');
    // Most-behind-market first: if a long run is ever cut off, the listings that need help most are done.
    const gap = (p) => { const o = p.pack.occupancy_vs_market_pct && p.pack.occupancy_vs_market_pct.next30; return o && o[0] != null && o[1] != null ? o[0] - o[1] : 0; };
    packs.sort((a, b) => gap(a) - gap(b));
    status.total = packs.length;
    const day = I.today();
    const prev = await I.sbSelect('market_intel', 'select=events,created_at&order=created_at.desc&limit=1').catch(() => []);
    const known = ((prev[0] && prev[0].events) || []).filter((e) => (e.end_date || e.start_date) >= day).slice(0, 25);
    const portfolioRun = !onlyId;

    // ── Agent step 1–2: triage every listing + 30-night packs for flagged ones (no Claude) ──
    let flagged = [], ctx = {};
    if (portfolioRun) {
      [agentRun] = await I.sbInsert('agent_runs', [{ kind: kind === 'weekly' ? 'scheduled' : 'manual' }]).catch(() => [null]);
      let autoSet;
      try {
        // The auto-apply decision always comes from Guesty's live tags.
        const g = await I.guestyGet(`/v1/listings?limit=100&fields=${encodeURIComponent('_id tags')}`);
        const gl = g.results || g.data || (Array.isArray(g) ? g : []);
        autoSet = new Set(gl.filter((l) => R.isAutoApplyListing(l)).map((l) => l._id));
      } catch (e) {
        autoSet = new Set(); // can't confirm tags → nothing is auto-applied this run
        status.agent_warn = 'Guesty tags unavailable — every change this run waits for approval.';
      }
      flagged = AG.triage(packs, autoSet, day);
      ctx = await AG.datePacks(flagged, day);
      status.flagged = flagged.length;
    }
    const flaggedForPrompt = flagged.map((f) => ({
      listing_id: f.listing_id, nickname: f.name, black_cabins_auto: f.auto, flags: f.flags,
      min_price: ctx[f.listing_id] ? ctx[f.listing_id].minPrice : null,
      next_30_nights: ctx[f.listing_id] ? AG.nightsForPrompt(ctx[f.listing_id]) : [],
    }));

    const out = await I.claude({
      kind, purpose: portfolioRun ? `portfolio analysis (${packs.length} listings + market)` : `single-listing analysis: ${packs[0].name}`,
      system: PORTFOLIO_PROMPT,
      user: { today: day, known_upcoming_events: known, data: { listings: packs.map((p) => ({ listing_id: p.listing_id, nickname: p.name, ...compactPack(p.pack) })), flagged: flaggedForPrompt } },
      maxTokens: Math.min(64000, 2500 + packs.length * 1300 + flagged.length * 1500),
      tools: portfolioRun ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : undefined,
      parse: 'none',
      timeoutMs: 13.5 * 60000, // stay inside Netlify's 15-min background window; keep what streamed
    });

    const lines = parseNdjson(out.text);
    const byId = Object.fromEntries(packs.map((p) => [p.listing_id, p]));
    const byName = Object.fromEntries(packs.map((p) => [String(p.name || '').toLowerCase(), p]));

    // Market
    const mk = lines.find((l) => l.type === 'market');
    if (mk && Array.isArray(mk.events)) {
      const sources = [];
      (out.content || []).forEach((b) => { if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((c) => c.url && sources.push({ url: c.url, title: c.title })); });
      const events = mk.events.filter((e) => e && e.start_date);
      if (events.length) await I.sbInsert('market_intel', [{ model: I.CLAUDE_MODEL, events, notes: mk.notes || null, sources: sources.slice(0, 30) }]).catch((e) => status.failed.push({ listing: 'market', error: e.message.slice(0, 200) }));
      status.events = events.length;
    }
    // High-impact event nights (incl. the night before) are never discounted by the agent.
    const eventDates = new Set();
    known.concat((mk && mk.events) || []).filter((e) => e && e.demand_impact === 'high' && e.start_date).forEach((e) => {
      for (let d = R.addDays(e.start_date, -1); d <= (e.end_date || e.start_date); d = R.addDays(d, 1)) eventDates.add(d);
    });
    // Portfolio brief
    const pf = lines.find((l) => l.type === 'portfolio');
    if (pf) await I.cacheSet('portfolio_brief', { ...pf, generated: new Date().toISOString(), model: I.CLAUDE_MODEL }, 21 * 86400000).catch(() => {});

    // Listings
    const usagePer = { ...(out.usage || {}), stop_reason: out.stop_reason, listings_in_request: packs.length };
    const rows = [];
    lines.filter((l) => l.type === 'listing').forEach((j) => {
      const p = byId[j.listing_id] || byName[String(j.nickname || j.listing_id || '').toLowerCase()];
      if (!p || rows.some((r) => r.listing_id === p.listing_id)) return;
      rows.push({
        listing_id: p.listing_id, snapshot_date: day, model: I.CLAUDE_MODEL,
        health_score: clampScore(j.health_score), summary: j.summary || null,
        search_actions: arr(j.search_actions, 6), pricelabs_settings: arr(j.pricelabs_settings, 6),
        review_themes: arr(j.review_themes, 5), owner_items: arr(j.owner_items, 4), data_gaps: arr(j.data_gaps, 4),
        input_digest: usagePer,
      });
    });
    if (rows.length) await I.sbInsert('listing_analyses', rows);
    status.done = rows.length;
    // Action queue: the top non-pricing action per listing becomes a team to-do (due in 7 days).
    // Pricing / min-stay is handled by the autopilot + Approvals tab, so it is never queued here.
    try { status.todos_created = await queueActions(rows, byId); } catch (e) { status.todo_error = e.message.slice(0, 200); }
    // ── Agent steps 4–5: validate + apply (Black Cabins) / queue for approval (everyone else) ──
    if (agentRun) {
      try {
        const actionLines = lines.filter((l) => l.type === 'actions' && l.listing_id);
        const ex = await AG.execute({ runId: agentRun.id, actionLines, ctx, today: day, eventDates });
        const fl = new Set(flagged.map((f) => f.listing_id));
        const recs = rows.filter((r) => fl.has(r.listing_id)).map((r) => ({
          listing_id: r.listing_id, name: byId[r.listing_id] ? byId[r.listing_id].name : r.listing_id, summary: r.summary,
          top_actions: (r.search_actions || []).slice(0, 2).map((a) => ({ action: a.action, why: a.why, impact: a.impact })),
          settings: (r.pricelabs_settings || []).slice(0, 2),
        }));
        const noActions = flagged.filter((f) => !actionLines.some((l) => l.listing_id === f.listing_id)).map((f) => f.name);
        if (noActions.length) ex.errors.push(`No pricing actions returned for: ${noActions.join(', ')}`);
        await I.sbPatch('agent_runs', `id=eq.${agentRun.id}`, {
          status: 'done', completed_at: new Date().toISOString(), flagged: flagged.map(({ score, ...f }) => f), summary: pf ? pf.summary : null,
          applied: ex.applied, pending: ex.pending, rejected: ex.rejected, recommendations: recs, usage: out.usage,
          error: [status.agent_warn].concat(ex.errors).filter(Boolean).join(' | ') || null,
        });
        const nA = ex.applied.reduce((s, x) => s + x.changes.length, 0), nP = ex.pending.reduce((s, x) => s + x.changes.length, 0);
        status.agent = { run_id: agentRun.id, applied: nA, pending: nP, rejected: ex.rejected.length };
        const msg = [nA ? `${nA} changes applied on ${ex.applied.length} Black Cabins listing${ex.applied.length > 1 ? 's' : ''}` : null,
          nP ? `${nP} changes on ${ex.pending.length} listing${ex.pending.length > 1 ? 's' : ''} need approval` : null].filter(Boolean).join(' · ')
          || `${flagged.length} listings reviewed — no pricing changes needed`;
        const base = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
        await fetch(`${base}/.netlify/functions/send-push`, { method: 'POST', headers: internalHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ title: '🤖 Search agent', message: msg, tag: 'agent-' + agentRun.id, url: '/?agent_run=' + agentRun.id }) }).catch(() => {});
      } catch (e) {
        status.agent_error = e.message.slice(0, 300);
        await I.sbPatch('agent_runs', `id=eq.${agentRun.id}`, { status: 'failed', completed_at: new Date().toISOString(), error: e.message.slice(0, 500) }).catch(() => {});
      }
    }
    const missing = packs.filter((p) => !rows.some((r) => r.listing_id === p.listing_id));
    missing.forEach((p) => status.failed.push({ listing: p.name, error: out.stop_reason === 'aborted' || out.stop_reason === 'max_tokens' ? `not reached (run stopped: ${out.stop_reason})` : 'no analysis returned' }));
    status.usage = out.usage;
    status.stop_reason = out.stop_reason;
    status.success = rows.length > 0 && missing.length === 0;
    if (!rows.length) status.fatalError = `Claude returned no usable listing analyses (stop_reason=${out.stop_reason}).`;
  } catch (e) {
    status.success = false;
    status.fatalError = e.message;
    status.budgetBlocked = e instanceof I.BudgetError;
    if (agentRun) await I.sbPatch('agent_runs', `id=eq.${agentRun.id}`, { status: 'failed', completed_at: new Date().toISOString(), error: e.message.slice(0, 500) }).catch(() => {});
  }
  status.completedAt = new Date().toISOString();
  await I.cacheSet(STATUS_KEY, status, 8 * 86400000).catch(() => {});
};

exports.buildPacks = buildPacks;
