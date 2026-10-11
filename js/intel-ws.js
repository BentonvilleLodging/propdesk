/* PropDesk — Property Workspace extensions (loaded after index.html's main script).
 * - Overview: "Do these now" — the top actions to lift Airbnb search placement immediately
 * - Pricing: performance windows vs market (7/14/30/60/90) + PriceLabs changes (Claude + rule engine)
 * - Recommendations: one-tap push (PriceLabs base/min/max, Guesty amenities) or mark done;
 *   every completion is saved to the listing with a baseline snapshot (History & Rank)
 * - History & Rank: clear explanation when PriceLabs isn't tracking rank yet
 * Safe to load on any page: does nothing unless the workspace functions exist.
 */
(function () {
  if (typeof window.wsOverviewHtml !== 'function' || typeof window.wsOpen !== 'function') return;
  if (window.__intelWsExt) return; window.__intelWsExt = true;

  var origOpen = window.wsOpen, origOverview = window.wsOverviewHtml;

  // ── data: latest PriceLabs metrics + customizations for the open listing ──
  window.wsOpen = async function (lid, tab) {
    window._wsMetrics = null; window._wsCust = null; window._wsDone = [];
    await origOpen(lid, tab);
    try {
      var q = await db.from('pricelabs_intel').select('snapshot_date,metrics,customizations,calendar,optimizer,errors').eq('listing_id', lid).order('snapshot_date', { ascending: false }).limit(1);
      var r = (q.data || [])[0] || {};
      if (window._wsLid !== lid) return;
      window._wsMetrics = r.metrics || null;
      window._wsCust = r.customizations || null;
      window._wsIntelRow = r;
      var dq = await db.from('recommendation_completions').select('*').eq('listing_id', lid).order('completed_at', { ascending: false }).limit(200);
      window._wsDone = dq.data || [];
      if (window._wsTab === 'overview' || window._wsTab === 'pricing' || window._wsTab === 'history') wsTab(window._wsTab);
    } catch (e) { /* non-fatal */ }
  };

  function M() { var m = window._wsMetrics || {}; return { L: m.listing_level || null, K: m.market_level || null }; }
  function mv(obj, key) { if (!obj) return null; var v = liNum(obj[key]); return v == null || v < 0 ? null : v; }
  function cust() { var c = window._wsCust; if (c && c.customizations) c = c.customizations; return c && typeof c === 'object' ? c : null; }

  // ── rule engine: concrete PriceLabs changes from our data ────────────────
  function plRules(l) {
    var out = [], c = cust(), m = M();
    var add = function (prio, setting, current, recommended, why) { out.push({ prio: prio, setting: setting, current: current, recommended: recommended, why: why, src: 'rules' }); };
    var behind30 = l.occ30 != null && l.mkt30 != null ? l.mkt30 - l.occ30 : null;
    var behind7 = l.occ7 != null && l.mkt7 != null ? l.mkt7 - l.occ7 : null;
    // Base price
    if (l.base != null && behind30 != null && behind30 >= 8) {
      var target = null, reason = '';
      if (l.rec && l.base > l.rec * 1.05) { target = Math.round(l.rec); reason = 'PriceLabs recommends ' + liMoney(l.rec); }
      if (l.mktP50 && l.base > l.mktP50 * 1.15) { var t2 = Math.round(l.mktP50 * 1.05); if (!target || t2 < target) { target = t2; reason = 'market median for this size is ' + liMoney(l.mktP50); } }
      if (target && target < l.base) add(1, 'Base price', liMoney(l.base), liMoney(target), 'Next-30-day occupancy is ' + Math.round(l.occ30) + '% vs market ' + Math.round(l.mkt30) + '% and ' + reason + '. Airbnb ranks total price against comparable homes.');
    } else if (l.base != null && behind30 != null && behind30 <= -10 && (l.open14 == null || l.open14 <= 4)) {
      add(2, 'Base price', liMoney(l.base), liMoney(Math.round(l.base * 1.07)), 'Running ' + Math.round(-behind30) + ' pts ahead of market with few open nights — capture more rate.');
    }
    // Minimum price
    if (l.min != null && l.mktP25 && behind30 != null && behind30 >= 8 && l.min > l.mktP25 * 1.05) add(2, 'Minimum price', liMoney(l.min), liMoney(Math.round(l.mktP25)), 'Min is above the market 25th percentile, so PriceLabs cannot discount far enough to win low-demand nights.');
    // Last-minute
    var lm = c && c.last_minute_prices;
    if (l.open14 != null && l.open14 >= 6) {
      if (!lm || lm.last_min_factor_on === false) add(1, 'Last-minute discount', lm ? 'Off' : 'check in PriceLabs', 'On — 15% off within 7 days (gradual)', l.open14 + ' of the next 14 nights are open. Near-term discounts fill gaps and booking velocity is a ranking signal.');
    }
    // Min stay
    if (l.minStay != null && l.minStay > 2) add(1, 'Default minimum stay', l.minStay + ' nights', '2 nights (1 night within 7 days)', 'Airbnb favors flexible stay lengths; long minimums hide the listing from short searches.');
    else if (l.minStay === 2 && l.open14 != null && l.open14 >= 8) add(3, 'Last-minute minimum stay', '2 nights', '1 night within 3–5 days', 'Lots of near-term open nights — allow 1-night stays close in.');
    // Orphan gaps
    if (l.gaps != null && l.gaps >= 1) add(2, 'Orphan-day / gap rules', l.gaps + ' gaps (' + (l.gapNights || 0) + ' nights) in 60d', 'Min stay = gap length, with a 10–15% gap discount', 'Short gaps between bookings rarely fill unless the minimum stay drops to fit them.');
    // Day-of-week
    var dow = c && c.day_of_week_adjustment;
    var we = m.L && m.L.weekend_total_occupancy, wd = m.L && m.L.weekday_total_occupancy;
    var we30 = mv(we, '-30') != null ? mv(we, '-30') : mv(we, '-90'), wd30 = mv(wd, '-30') != null ? mv(wd, '-30') : mv(wd, '-90');
    if (dow && dow.dow_factor_on === false && we30 != null && wd30 != null && we30 - wd30 >= 30) add(3, 'Day-of-week adjustment', 'Off', 'On — Fri/Sat +8%, Sun–Thu −5%', 'Past weekends booked ' + Math.round(we30) + '% vs weekdays ' + Math.round(wd30) + '%; shift rate from weekdays to weekends.');
    // Occupancy-based
    var ob = c && c.occupancy_based_adjustment;
    if (ob && ob.occupancy_based_discounts_on === false && behind30 != null && behind30 >= 10) add(2, 'Occupancy-based adjustment', 'Off', 'On', 'Lets PriceLabs automatically lower prices when this listing falls behind its booking-pace target.');
    // Event / high-demand dates open
    if (l.highDemandOpen && l.highDemandOpen >= 3) add(3, 'Date-specific overrides', l.highDemandOpen + ' high-demand nights still open', 'Review event dates; set min-stay 2–3 and confirm premiums', 'High-demand dates should carry a premium and a sensible min-stay so they don’t sell as 1-night stays.');
    if (behind7 != null && behind7 >= 20 && l.open14 != null && l.open14 >= 6 && !(lm && lm.last_min_factor_on === false)) add(2, 'Next-7-day prices', 'check in PriceLabs', 'Drop 10–15% for open nights this week', 'This week is ' + Math.round(l.occ7) + '% booked vs market ' + Math.round(l.mkt7) + '%.');
    return out.sort(function (a, b) { return a.prio - b.prio; });
  }
  window.wsPlRules = plRules;

  // ── rule engine: immediate search actions ────────────────────────────────
  function searchRules(l) {
    var out = [], op = l.optimizer || (window._wsIntelRow && window._wsIntelRow.optimizer), live = window._wsLive;
    var add = function (prio, title, why, tab, tag) { out.push({ prio: prio, title: title, why: why, tab: tab, tag: tag }); };
    if (op && op.categories) {
      var names = { image_score: 'Photos', listing_title: 'Title', listing_description: 'Description', review_summary: 'Guest experience (from reviews)', amenities: 'Amenities', consistency_score: 'Listing consistency', guest_favorite: 'Guest Favorite', star_rating: 'Rating', review_count: 'Review volume' };
      var tabs = { image_score: 'content', listing_title: 'content', listing_description: 'content', review_summary: 'reviews', amenities: 'amenities', consistency_score: 'content', guest_favorite: 'reviews', star_rating: 'reviews', review_count: 'reviews' };
      Object.keys(op.categories).forEach(function (k) {
        var cat = op.categories[k] || {}, g = String(cat.score || '').toUpperCase();
        if (!/^[A-F]/.test(g)) return;
        var tip = cat.tip ? String(cat.tip) : '';
        if (k === 'amenities') { var mm = tip.match(/consider adding them:\s*(.+?)\.?$/i); if (mm) { var names2 = mm[1].replace(/'/g, '').split(/,\s*|\s+and\s+/).map(function (x) { return x.trim().replace(/\.$/, ''); }).filter(Boolean); add(1, 'Add amenities Airbnb sees in your photos/text but not your list: ' + names2.join(', '), 'Unticked amenities hide the listing from guests who filter for them. Only add what the home really has.', 'amenities', 'Amenities'); out[out.length - 1].push = { kind: 'amen', add: names2.map(function (n) { return n.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }), label: 'Add to Guesty' }; return; } }
        if (/^[CDF]/.test(g)) add(/^[DF]/.test(g) ? 1 : 2, 'Fix ' + (names[k] || k.replace(/_/g, ' ')) + ' (PriceLabs grade ' + g + ')', tip.slice(0, 320), tabs[k] || 'content', names[k] || 'Listing');
      });
    }
    if (live) {
      var t = live.content.title || '';
      if (t.length < 30) add(2, 'Rewrite the title (' + t.length + '/50 chars)', 'Lead with the differentiator and a place cue for your target guest. Use Claude suggestions in Listing Content.', 'content', 'Title');
      var aud = (window.wsAmenityAudit && wsAmenityAudit()) || [];
      var miss = aud.filter(function (x) { return !x.has; }).map(function (x) { return x.name; });
      if (miss.length >= 6) add(2, 'Verify & tick missing search-filter amenities (' + miss.length + ')', 'e.g. ' + miss.slice(0, 5).join(', ') + ' — only tick what the home really has.', 'amenities', 'Amenities');
    }
    if (l.photos != null && l.photos < 20) add(2, 'Add photos (' + l.photos + ' now — aim for 25+)', 'Show every bedroom, the standout amenity in the first 5, and a strong cover shot.', 'content', 'Photos');
    if (l.reviews != null && l.reviews < 10) add(2, 'Build review volume (' + l.reviews + ' reviews)', 'Send a review request on checkout day and a reminder 3 days later; Guest Favorite needs volume.', 'reviews', 'Reviews');
    if (l.daysSinceReview != null && l.daysSinceReview > 45) add(3, 'Get a fresh review (last one ' + l.daysSinceReview + ' days ago)', 'Recent reviews carry more weight in ranking and conversion.', 'reviews', 'Reviews');
    if (l.rating != null && l.rating < 4.8) add(1, 'Protect the rating (' + l.rating.toFixed(2) + '★)', 'Fix the recurring complaints in Reviews before pushing for more volume.', 'reviews', 'Reviews');
    if (l.pushEnabled === false) add(1, 'Turn PriceLabs sync back ON', 'PriceLabs is not pushing prices for this listing, so none of its pricing reaches Airbnb.', 'pricing', 'PriceLabs');
    return out.sort(function (a, b) { return a.prio - b.prio; });
  }

  // ── Overview: "Do these now" ─────────────────────────────────────────────
  function nowActions(l) {
    var items = [], a = l.analysis || {};
    (a.search_actions || []).slice().sort(function (x, y) { return (x.priority || 9) - (y.priority || 9); }).slice(0, 3).forEach(function (x) {
      var tab = /pric|availab/i.test(x.category || '') ? 'pricing' : /amenit/i.test(x.category || '') ? 'amenities' : /review|guest/i.test(x.category || '') ? 'reviews' : 'content';
      items.push({ title: x.action, why: x.why || '', tab: tab, tag: x.category || 'Claude', src: 'Claude' });
    });
    var pr = plRules(l).filter(function (r) { return r.prio === 1; }).map(function (r) { return { title: 'PriceLabs: ' + r.setting + ' → ' + r.recommended, why: r.why, tab: 'pricing', tag: 'PriceLabs', src: 'data', push: plPushFor(r) }; });
    var sr = searchRules(l).map(function (r) { r.src = 'data'; return r; });
    // interleave: highest-priority data rules first after Claude
    var rules = pr.concat(sr.filter(function (r) { return r.prio === 1; })).concat(sr.filter(function (r) { return r.prio !== 1; }));
    rules.forEach(function (r) { if (items.length < 6 && !items.some(function (i) { return liSlug(i.title).slice(0, 30) === liSlug(r.title).slice(0, 30); })) items.push(r); });
    return items.slice(0, 6);
  }

  function nowPanel(l) {
    var items = nowActions(l);
    var html = '<div class="li-panel ws-now"><div class="li-panel-head"><div><div class="li-panel-title">&#9889; Do these now to lift search</div><div class="li-muted">The highest-impact moves from this listing’s data' + (l.analysis ? ' and the latest Claude analysis' : ' (Claude analysis adds more once it runs)') + '. Push it live where there’s a button, or tick it when done — it’s saved to this listing’s history.</div></div></div>';
    if (!items.length) return html + '<div class="li-muted">Nothing urgent — this listing’s core signals look healthy. Run Sync Data to refresh.</div></div>';
    html += '<ol class="ws-now-list">' + items.map(function (x) {
      var key = 'now-' + liSlug(x.title);
      var done = !!(window._shCompletions && window._shCompletions[l.lid + '::' + key]);
      if (x.push) regPush(key, x.push);
      return '<li class="li-action' + (done ? ' li-done' : '') + '"><input type="checkbox" ' + (done ? 'checked' : '') + ' onchange="liToggleDone(\'' + l.lid + '\',\'' + key + '\',this)" data-text="' + esc(x.title) + '" data-src="' + (x.src === 'Claude' ? 'claude' : 'data') + '" data-cat="' + esc(x.tag || '') + '">' +
        '<div style="flex:1;min-width:0;"><div class="li-action-text">' + esc(x.title) + '</div>' + (x.why ? '<div class="li-action-why">' + esc(x.why) + '</div>' : '') +
        '<div class="li-action-tags"><span>' + esc(x.tag || '') + '</span><span>' + (x.src === 'Claude' ? 'Claude' : 'From data') + '</span></div>' + doneLine(key) + '</div>' +
        '<div class="ws-now-btns">' + actionBtns(l, key, x.push, done, x.tab) + '<button class="expand-btn ws-now-go" onclick="wsTab(\'' + x.tab + '\')">Go &#8594;</button></div></li>';
    }).join('') + '</ol></div>';
    return html;
  }

  window.wsOverviewHtml = function (l) { return nowPanel(l) + origOverview(l); };

  // ── Pricing tab ──────────────────────────────────────────────────────────
  function perfTable(l) {
    var m = M(), L = m.L, K = m.K;
    var rows = [['Next 7 days', '7'], ['Next 14 days', '15'], ['Next 30 days', '30'], ['Next 60 days', '60'], ['Next 90 days', '90'], ['Last 30 days', '-30'], ['Last 90 days', '-90']];
    if (!L) {
      // fallback: PriceLabs listing feed (7/30/60 only)
      var fb = [['Next 7 days', l.occ7, l.mkt7], ['Next 30 days', l.occ30, l.mkt30], ['Next 60 days', l.occ60, l.mkt60]];
      return '<div class="li-panel"><div class="li-panel-title">Occupancy vs market</div><div class="li-muted" style="margin-bottom:8px;">Basic view from the PriceLabs listing feed. Tap Sync Data for 14/90-day windows, last-year pace, ADR and revenue.</div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>Window</th><th>This listing</th><th>Market</th><th>Gap</th></tr></thead><tbody>' +
        fb.map(function (r) { var g = r[1] != null && r[2] != null ? Math.round(r[1] - r[2]) : null; return '<tr><td>' + r[0] + '</td><td class="amount">' + liPct(r[1]) + '</td><td class="amount">' + liPct(r[2]) + '</td><td class="amount" style="color:' + (g == null ? '' : g <= -10 ? 'var(--red)' : g >= 5 ? 'var(--green)' : '') + '">' + (g == null ? '—' : (g > 0 ? '+' : '') + g + ' pts') + '</td></tr>'; }).join('') + '</tbody></table></div></div>';
    }
    var pk = L.booking_pickup || {}, spk = L.stly_booking_pickup || {};
    var html = '<div class="li-panel"><div class="li-panel-title">Performance vs market &amp; last year</div><div class="li-muted" style="margin-bottom:8px;">From PriceLabs. Occupancy excludes owner blocks; STLY = same time last year.</div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>Window</th><th>Occupancy</th><th>Market</th><th>Gap</th><th>STLY occ</th><th>ADR</th><th>STLY ADR</th><th>Revenue</th><th>STLY rev</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var k = r[1], o = mv(L.occupancy, k), mk = K ? mv(K.occupancy, k) : null, g = o != null && mk != null ? Math.round(o - mk) : null;
        return '<tr><td>' + r[0] + '</td><td class="amount">' + liPct(o) + '</td><td class="amount">' + liPct(mk) + '</td><td class="amount" style="color:' + (g == null ? '' : g <= -10 ? 'var(--red)' : g >= 5 ? 'var(--green)' : '') + '">' + (g == null ? '—' : (g > 0 ? '+' : '') + g + ' pts') + '</td>' +
          '<td class="amount">' + liPct(mv(L.stly_occupancy, k)) + '</td><td class="amount">' + liMoney(mv(L.adr, k)) + '</td><td class="amount">' + liMoney(mv(L.stly_adr, k)) + '</td><td class="amount">' + liMoney(mv(L.revenue, k)) + '</td><td class="amount">' + liMoney(mv(L.stly_revenue, k)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var p7 = mv(pk, '-7'), p30 = mv(pk, '-30'), s7 = mv(spk, '-7'), s30 = mv(spk, '-30');
    if (p7 != null || p30 != null) html += '<div class="li-muted" style="margin-top:8px;font-size:12px;">Nights picked up: last 7 days ' + (p7 != null ? p7 : '—') + (s7 != null ? ' (last year ' + s7 + ')' : '') + ' · last 30 days ' + (p30 != null ? p30 : '—') + (s30 != null ? ' (last year ' + s30 + ')' : '') + (L.last_booked_date ? ' · last booking made ' + new Date(L.last_booked_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '') + '</div>';
    return html + '</div>';
  }

  function plTable(l) {
    var a = l.analysis || {}, rows = [];
    (a.pricelabs_settings || []).forEach(function (s) { rows.push({ setting: s.setting, current: s.current, recommended: s.recommended, why: s.why, src: 'Claude' }); });
    plRules(l).forEach(function (r) { if (!rows.some(function (x) { return liSlug(x.setting) === liSlug(r.setting); })) rows.push({ setting: r.setting, current: r.current, recommended: r.recommended, why: r.why, src: 'From data' }); });
    var html = '<div class="li-panel"><div class="li-panel-title">Recommended PriceLabs changes</div><div class="li-muted" style="margin-bottom:8px;">Base and minimum price changes can be pushed live to PriceLabs with one tap (logged with undo). Minimum-stay, last-minute, gap and day-of-week rules are set in PriceLabs → Customizations — tick each when done so it’s tracked on this listing.</div>';
    if (!rows.length) return html + '<div class="li-muted">No changes recommended — current settings fit this listing’s pace vs market.' + (cust() ? '' : ' (Run Sync Data to load current PriceLabs customizations.)') + '</div></div>';
    return html + '<div class="inv-table-wrap"><table class="inv-table li-pl-table"><thead><tr><th></th><th>Setting</th><th>Current</th><th>Recommended</th><th>Why</th></tr></thead><tbody>' + rows.map(function (s) {
      var key = 'pl-' + liSlug(s.setting + '-' + s.recommended);
      var done = !!(window._shCompletions && window._shCompletions[l.lid + '::' + key]);
      var push = plPushFor(s);
      if (push) regPush(key, push);
      return '<tr class="' + (done ? 'li-done' : '') + '"><td><input type="checkbox" title="Mark as done" ' + (done ? 'checked' : '') + ' onchange="liToggleDone(\'' + l.lid + '\',\'' + key + '\',this)" data-text="' + esc(s.setting + ': ' + s.recommended) + '" data-src="' + (s.src === 'Claude' ? 'claude' : 'data') + '" data-cat="PriceLabs"></td><td><strong>' + esc(s.setting) + '</strong><div class="li-muted" style="font-size:11px;">' + esc(s.src) + '</div></td><td>' + esc(s.current || '—') + '</td><td class="li-rec">' + esc(s.recommended || '') + actionBtns(l, key, push, done, 'pricelabs') + '</td><td class="li-why">' + esc(s.why || '') + doneLine(key) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>';
  }

  var origPricing = window.wsPricingHtml;
  window.wsPricingHtml = function (l) {
    // Keep the price-level editor (first panel) from the original, drop its Claude-only settings table.
    var saved = l.analysis; var tmp = saved ? Object.assign({}, saved, { pricelabs_settings: [] }) : saved;
    l.analysis = tmp; var base; try { base = origPricing(l); } finally { l.analysis = saved; }
    var cal = ((window._wsIntelHist || [])[0] || {}).calendar;
    if (!cal || !cal.windows) base = base.replace(/(<div class="li-panel-title">Next 90 days<\/div>)/, '$1<div class="li-muted" style="margin-bottom:8px;">Open-night calendar loads with the next Sync Data.</div>');
    var parts = base.split('<div class="li-panel"><div class="li-panel-title">Next 90 days');
    return parts[0] + perfTable(l) + plTable(l) + (parts[1] ? '<div class="li-panel"><div class="li-panel-title">Open nights &amp; prices — next 90 days' + parts[1] : '');
  };


  // ── Recommendation tracking & one-tap push ───────────────────────────────
  window._wsPush = window._wsPush || {};
  function regPush(key, push) { window._wsPush[key] = push; }
  function money(str) { var m = String(str || '').match(/\$\s*(\d[\d,]*)/); return m ? Number(m[1].replace(/,/g, '')) : null; }
  function plPushFor(r) {
    var v = money(r.recommended);
    if (!v) return null;
    if (/^\s*base( price)?\s*$/i.test(r.setting)) return { kind: 'pl', field: 'base', value: v, label: 'Apply ' + liMoney(v) + ' in PriceLabs' };
    if (/^\s*min(imum)? price\s*$/i.test(r.setting)) return { kind: 'pl', field: 'min', value: v, label: 'Apply ' + liMoney(v) + ' in PriceLabs' };
    if (/^\s*max(imum)? price\s*$/i.test(r.setting)) return { kind: 'pl', field: 'max', value: v, label: 'Apply ' + liMoney(v) + ' in PriceLabs' };
    return null;
  }
  function doneRow(key) { return (window._wsDone || []).find(function (d) { return d.action_key === key; }); }
  function doneLine(key) {
    var d = doneRow(key); if (!d) return '';
    return '<div class="ws-done-line">&#10003; ' + (d.method === 'pushed' ? 'Pushed live' : 'Marked done') + ' by ' + esc((d.completed_by || 'team').split('@')[0]) + ' · ' + new Date(d.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</div>';
  }
  function actionBtns(l, key, push, done, tab) {
    if (done || !push) return '';
    return '<button class="btn btn-primary ws-push-btn" onclick="wsPushRec(\'' + l.lid + '\',\'' + key + '\',this)">' + esc(push.label || 'Apply') + '</button>';
  }
  function baselineFor(lid) {
    var l = (window._shListingData || []).find(function (x) { return x.lid === lid; }) || {};
    return { occ7: l.occ7, mkt7: l.mkt7, occ30: l.occ30, mkt30: l.mkt30, base: l.base, min: l.min, rec: l.rec, open14: l.open14, reviews: l.reviews, rating: l.rating,
      avg_rank: l.ranking ? l.ranking.avg_rank : null, avg_page: l.ranking ? l.ranking.avg_page : null, health: l.analysis ? l.analysis.health_score : null, photos: l.photos, date: new Date().toISOString().slice(0, 10) };
  }
  async function saveDone(lid, key, text, opts) {
    opts = opts || {};
    var row = { listing_id: lid, action_key: key, action_text: text || key, source: opts.src || 'intel', category: opts.cat || null, method: opts.method || 'manual', edit_id: opts.edit_id || null, baseline: baselineFor(lid) };
    var r = await db.from('recommendation_completions').insert([row]).select().single();
    if (r.error) throw r.error;
    window._shCompletions = window._shCompletions || {};
    window._shCompletions[lid + '::' + key] = true;
    if (window._wsLid === lid) (window._wsDone = window._wsDone || []).unshift(r.data);
    return r.data;
  }
  window.liToggleDone = async function (lid, key, cb) {
    var checked = cb.checked, text = cb.getAttribute('data-text') || '';
    var row = cb.closest('.li-action') || cb.closest('tr');
    try {
      if (checked) {
        await saveDone(lid, key, text, { src: cb.getAttribute('data-src') || 'intel', cat: cb.getAttribute('data-cat') || null });
      } else {
        var r2 = await db.from('recommendation_completions').delete().match({ listing_id: lid, action_key: key });
        if (r2.error) throw r2.error;
        delete window._shCompletions[lid + '::' + key];
        window._wsDone = (window._wsDone || []).filter(function (d) { return !(d.listing_id === lid && d.action_key === key); });
      }
      if (row) row.classList.toggle('li-done', checked);
      if (window._wsLid === lid && window._wsTab && document.getElementById('page-listing-ws').classList.contains('active')) wsTab(window._wsTab);
      showToast(checked ? 'Saved to this listing’s action history' : 'Unmarked', 'success');
    } catch (e) { cb.checked = !checked; showToast('Could not save: ' + (e.message || e), 'error'); }
  };
  window.wsPushRec = async function (lid, key, btn) {
    var p = window._wsPush[key]; if (!p) return;
    var l = (window._shListingData || []).find(function (x) { return x.lid === lid; }) || {};
    var msg = p.kind === 'pl' ? 'Change PriceLabs ' + (p.field === 'base' ? 'base price' : p.field === 'min' ? 'minimum price' : 'maximum price') + ' for ' + (l.name || 'this listing') + ' from ' + liMoney(l[p.field]) + ' to ' + liMoney(p.value) + '?\n\nThis goes live now (PriceLabs pushes to the channels) and can be undone in History & Rank.'
      : 'Add these amenities to ' + (l.name || 'this listing') + ' in Guesty (syncs to Airbnb/Vrbo)?\n\n' + p.add.join(', ') + '\n\nOnly continue if the home really has them. Can be undone in History & Rank.';
    if (!confirm(msg)) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }
    try {
      var res, payload = { listing_id: lid };
      if (p.kind === 'pl') { payload.action = 'update_pricelabs'; payload[p.field] = p.value; }
      else { payload.action = 'update_amenities'; payload.add = p.add; }
      res = await wsApi(payload);
      await saveDone(lid, key, p.kind === 'pl' ? 'PriceLabs ' + p.field + ' → ' + liMoney(p.value) : 'Added amenities: ' + p.add.join(', '), { src: 'intel', cat: p.kind === 'pl' ? 'PriceLabs' : 'Amenities', method: 'pushed', edit_id: res.edit && res.edit.id });
      if (p.kind === 'pl') { l[p.field] = p.value; }
      if (res.edit) (window._wsEdits = window._wsEdits || []).unshift(res.edit);
      var warn = res.not_standard && res.not_standard.length ? ' Not standard Guesty amenities (may not show as Airbnb filters): ' + res.not_standard.join(', ') + '.' : '';
      showToast('Pushed live and saved to this listing’s history.' + warn, warn ? 'info' : 'success');
      if (p.kind === 'amen') wsApi({ action: 'get', listing_id: lid }).then(function (g) { window._wsLive = g; });
      if (window._wsLid === lid) wsTab(window._wsTab);
    } catch (e) {
      showToast('Push failed: ' + (e.message || e), 'error');
      if (btn) { btn.disabled = false; btn.textContent = p.label || 'Apply'; }
    }
  };

  // History: completed recommendations with baseline → now
  var origHistory = window.wsHistoryHtml;
  window.wsHistoryHtml = function (l) {
    var D = window._wsDone || [];
    var now = baselineFor(l.lid);
    var fmtOcc = function (b) { return b && b.occ30 != null ? Math.round(b.occ30) + '%' + (b.mkt30 != null ? ' vs ' + Math.round(b.mkt30) + '%' : '') : '—'; };
    var html = '<div class="li-panel"><div class="li-panel-title">Completed recommendations</div><div class="li-muted" style="margin-bottom:8px;">Every recommendation the team pushed or marked done, with the listing’s numbers at that moment and today — so you can see what moved the needle.</div>';
    html += D.length ? '<div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>Date</th><th>Action</th><th>Who / how</th><th>Occ 30d vs mkt<br>then → now</th><th>Base<br>then → now</th><th>Rating · reviews<br>then → now</th><th>Avg rank<br>then → now</th><th></th></tr></thead><tbody>' + D.map(function (d) {
      var b = d.baseline || {};
      return '<tr><td>' + new Date(d.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</td><td style="max-width:280px;">' + esc(d.action_text) + (d.category ? '<div class="li-muted" style="font-size:11px;">' + esc(d.category) + '</div>' : '') + '</td><td style="font-size:12px;">' + esc((d.completed_by || 'team').split('@')[0]) + '<div class="li-muted">' + (d.method === 'pushed' ? 'Pushed live' : 'Marked done') + '</div></td>' +
        '<td class="amount">' + fmtOcc(b) + '<br>→ ' + fmtOcc(now) + '</td><td class="amount">' + liMoney(b.base) + ' → ' + liMoney(now.base) + '</td>' +
        '<td class="amount">' + (b.rating != null ? Number(b.rating).toFixed(2) : '—') + ' · ' + (b.reviews != null ? b.reviews : '—') + '<br>→ ' + (now.rating != null ? Number(now.rating).toFixed(2) : '—') + ' · ' + (now.reviews != null ? now.reviews : '—') + '</td>' +
        '<td class="amount">' + (b.avg_rank != null ? '#' + b.avg_rank : '—') + ' → ' + (now.avg_rank != null ? '#' + now.avg_rank : '—') + '</td>' +
        '<td>' + (d.method !== 'pushed' ? '<button class="expand-btn" onclick="wsUnmark(' + d.id + ')">Unmark</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="li-muted">Nothing completed yet. Tick a recommendation or use an Apply button and it will appear here.</div>';
    html += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><input id="ws-manual-done" placeholder="Log something else you did (e.g. replaced mattresses, new cover photo)" style="flex:1;min-width:220px;"><button class="expand-btn" onclick="wsLogManual()">Log it</button></div></div>';
    return html + origHistory(l);
  };
  window.wsUnmark = async function (id) {
    var d = (window._wsDone || []).find(function (x) { return x.id === id; }); if (!d) return;
    var r = await db.from('recommendation_completions').delete().eq('id', id);
    if (r.error) { showToast('Could not unmark: ' + r.error.message, 'error'); return; }
    window._wsDone = window._wsDone.filter(function (x) { return x.id !== id; });
    if (window._shCompletions) delete window._shCompletions[d.listing_id + '::' + d.action_key];
    wsTab(window._wsTab);
  };
  window.wsLogManual = async function () {
    var el = document.getElementById('ws-manual-done'); var t = el && el.value.trim(); if (!t) return;
    try { await saveDone(window._wsLid, 'manual-' + Date.now(), t, { src: 'manual', cat: 'Manual' }); showToast('Logged', 'success'); wsTab('history'); }
    catch (e) { showToast('Could not save: ' + (e.message || e), 'error'); }
  };

  // ── Rank ─────────────────────────────────────────────────────────────────
  var origRank = window.wsRankNow;
  window.wsRankNow = async function () {
    if (window._wsTab !== 'history') wsTab('history');
    var el = document.getElementById('ws-rank-body');
    if (el) el.innerHTML = 'Checking PriceLabs…';
    try {
      var d = await wsApi({ action: 'rank_now', listing_id: window._wsLid });
      if (!(d.segments || []).length) {
        el.innerHTML = '<div style="color:var(--yellow);font-weight:600;margin-bottom:6px;">PriceLabs isn’t tracking Airbnb rank for this listing yet.</div>' +
          '<div class="li-muted">PriceLabs answered (Airbnb ID ' + esc(d.airbnb_id || '—') + (d.neighborhood_count ? ', ' + d.neighborhood_count + ' competing listings in its search area' : '') + ') but returned no rankings and no history. Rank tracking has to be switched on per listing inside PriceLabs → <strong>Listing Optimizer</strong> (Ranking / Search Rank). Once it’s on, PriceLabs starts collecting within about a day and PropDesk pulls it on every sync and on “Check now”.</div>';
        return;
      }
      await origRank();
    } catch (e) { if (el) el.innerHTML = '<span style="color:var(--red);">' + esc(e.message) + '</span>'; }
  };

  // styles
  var st = document.createElement('style');
  st.textContent = '.ws-now{border-left:4px solid var(--accent, #c8a96e);} .ws-now-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;} .ws-now-list li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg, transparent);} .ws-now-list li input{margin-top:3px;flex-shrink:0;} .ws-now-go{flex-shrink:0;white-space:nowrap;} .ws-now-btns{display:flex;flex-direction:column;gap:6px;align-items:stretch;flex-shrink:0;align-self:center;} .ws-push-btn{font-size:11.5px;padding:6px 10px;white-space:nowrap;margin-top:6px;display:inline-block;} .ws-now-btns .ws-push-btn{margin-top:0;} .ws-done-line{font-size:11.5px;color:var(--green);margin-top:4px;font-weight:600;} @media (max-width:600px){.ws-now-list li{flex-wrap:wrap;} .ws-now-btns{margin-left:26px;flex-direction:row;}}';
  document.head.appendChild(st);

  // If the workspace is already open (script loaded late), re-render.
  if (window._wsLid && window._wsTab) { try { wsTab(window._wsTab); } catch (e) {} }
})();
