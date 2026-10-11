// netlify/functions/listing-intel-analyze-background.js
//
// LISTING INTELLIGENCE — analysis (Background Function, 15-min window).
// Scheduled daily at 11:40 UTC (after data collection at 11:00) and triggered from the
// Search Health page ("Re-run Analysis", optionally for one listing via ?listing_id=).
//
//   1. Weekly market intel: Claude + web search finds upcoming NWA demand drivers
//      (events, races, Walmart/Crystal Bridges/university dates) → market_intel.
//   2. Per-listing analysis: builds a full evidence pack for every tracked listing
//      (PriceLabs pricing/market/settings/optimizer/ranking/calendar, bookings & pace,
//      every review incl. category ratings, listing content, gaps, Airbnb CSV insights,
//      upcoming events) and asks Claude for:
//        • a short situation summary
//        • physical/operational actions to improve search placement + conversion
//        • specific PriceLabs setting changes (current → recommended, with reasons)
//        • guest-review themes
//        • property improvements to propose to the owner
//      → listing_analyses (history kept). Status → app_cache 'listing_intel_last_run'.

const { requireTeam, isScheduledInvocation } = require('../lib/auth');
const I = require('../lib/intel');

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
- Never invent data. If something important is missing, list it in "data_gaps".
- Keep "summary" to 3–5 sentences: the situation, the likely cause, and the single most important move.

Respond with ONLY a JSON object, no markdown, exactly:
{"health_score": 0, "summary": "", "search_actions": [{"priority": 1, "category": "Listing content|Photos|Amenities|Pricing|Availability|Guest experience|Reviews|Operations", "action": "", "why": "", "effort": "low|medium|high", "impact": "low|medium|high", "owner": "BLC team|Owner|Cleaning team"}], "pricelabs_settings": [{"setting": "", "current": "", "recommended": "", "why": ""}], "review_themes": [{"theme": "", "sentiment": "positive|negative|mixed", "mentions": 0, "evidence": ""}], "owner_items": [{"item": "", "evidence": "", "priority": "high|medium|low", "est_cost": "", "expected_benefit": ""}], "data_gaps": [""]}`;

const MARKET_PROMPT = `You research upcoming demand drivers for short-term rentals in Bentonville, Rogers, Bella Vista, Springdale and Fayetteville, Arkansas (Northwest Arkansas). Use web search to find events in the next 120 days that drive lodging demand: cycling/mountain-bike races and festivals, Walmart corporate events (e.g. associates/shareholders weeks, vendor summits), University of Arkansas football home games and graduation, Crystal Bridges/Momentary major exhibitions or festivals, concerts at Walmart AMP, large conferences, holidays. Return ONLY JSON:
{"events": [{"name": "", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "location": "", "demand_impact": "high|medium|low", "notes": "why it matters for lodging", "source_url": ""}], "notes": "1-2 sentences on the demand outlook"}
Only include events with dates you found in sources. Sort by start_date.`;

async function refreshMarketIntel(force) {
  const rows = await I.sbSelect('market_intel', 'select=id,created_at,events&order=created_at.desc&limit=1');
  if (!force && rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < 6.5 * 86400000) return rows[0].events || [];
  try {
    const out = await I.claude({
      system: MARKET_PROMPT,
      user: `Today is ${I.today()}. Find NWA lodging-demand events for the next 120 days.`,
      maxTokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    });
    const sources = [];
    (out.content || []).forEach((b) => { if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((c) => c.url && sources.push({ url: c.url, title: c.title })); });
    const events = (out.json.events || []).filter((e) => e.start_date);
    await I.sbInsert('market_intel', [{ model: I.CLAUDE_MODEL, events, notes: out.json.notes || null, sources: sources.slice(0, 30) }]);
    return events;
  } catch (e) {
    console.warn('market intel failed:', e.message);
    return rows[0] ? rows[0].events || [] : [];
  }
}

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
        data_errors: it.errors || null,
      },
    });
  }
  return packs;
}

exports.handler = async function (event) {
  if (!isScheduledInvocation(event) && !(await requireTeam(event, ['staff']))) { console.warn('listing-intel-analyze: unauthorized'); return; }
  const qs = event.queryStringParameters || {};
  const onlyId = qs.listing_id || null;
  const status = { startedAt: new Date().toISOString(), listing_id: onlyId, done: 0, failed: [], model: I.CLAUDE_MODEL };
  await I.cacheSet(STATUS_KEY, { ...status, running: true }, 2 * 86400000).catch(() => {});
  if (qs.market_only === '1') {
    try { const ev = await refreshMarketIntel(true); status.success = true; status.events = ev.length; }
    catch (e) { status.success = false; status.fatalError = e.message; }
    status.market_only = true; status.completedAt = new Date().toISOString();
    await I.cacheSet(STATUS_KEY, status, 2 * 86400000).catch(() => {});
    return;
  }
  try {
    const events = await refreshMarketIntel(qs.refresh_market === '1');
    const upcoming = (events || []).filter((e) => e.end_date >= I.today() || e.start_date >= I.today()).slice(0, 25);
    const packs = await buildPacks(onlyId);
    status.total = packs.length;
    const day = I.today();
    await I.pool(packs, 4, async (p) => {
      try {
        const out = await I.claude({
          system: SYSTEM_PROMPT,
          user: { today: day, listing: p.name, upcoming_nwa_events: upcoming, data: p.pack },
          maxTokens: 3500,
        });
        const j = out.json || {};
        await I.sbInsert('listing_analyses', [{
          listing_id: p.listing_id, snapshot_date: day, model: I.CLAUDE_MODEL,
          health_score: num(j.health_score) != null ? Math.max(0, Math.min(100, Math.round(num(j.health_score)))) : null,
          summary: j.summary || null,
          search_actions: Array.isArray(j.search_actions) ? j.search_actions : [],
          pricelabs_settings: Array.isArray(j.pricelabs_settings) ? j.pricelabs_settings : [],
          review_themes: Array.isArray(j.review_themes) ? j.review_themes : [],
          owner_items: Array.isArray(j.owner_items) ? j.owner_items : [],
          data_gaps: Array.isArray(j.data_gaps) ? j.data_gaps : [],
          input_digest: { usage: out.usage, stop_reason: out.stop_reason },
        }]);
        status.done++;
      } catch (e) {
        console.warn('analysis failed', p.name, e.message);
        status.failed.push({ listing: p.name, error: e.message.slice(0, 200) });
        if (/credit balance/i.test(e.message)) throw e;
      }
    });
    status.success = status.failed.length === 0;
  } catch (e) {
    status.success = false;
    status.fatalError = e.message;
  }
  status.completedAt = new Date().toISOString();
  await I.cacheSet(STATUS_KEY, status, 2 * 86400000).catch(() => {});
};

exports.buildPacks = buildPacks;
