// js/ai-training.js — "Guest Guide & AI" tab on each PropDesk property (Properties page, staff only)
//
// Loaded by index.html (<script src="/js/ai-training.js" defer>). Adds a tab to the Property Detail
// modal. What's in this tab — plus Guesty's guest-facing info for the linked listing — is the ONLY
// home-specific information the guest Concierge (Home Guide page + AI chat) can use. Everything else
// on the property (owner details, contracts, care notes, cleaning notes…) stays team-only.
//
//   • "From Guesty" (read-only): Wi-Fi, door code, check-in / checkout instructions, parking, trash
//     day, house manual, times. Edit those in Guesty.
//   • "Home walkthrough": prompts the team fills in on site — breaker box, water heater, shut-off,
//     thermostat, quirks… each with details + photos.
//   • Items marked Sensitive are released to the guest and the AI only from the start of check-in day.
//     Items marked "AI only" are used by the AI chat but not shown in the guest guide.
//
// Data: properties.listing_id → Guesty listing; items in guest_guide_items (listing_id; NULL = all
// homes); photos in the PRIVATE storage bucket "guide-photos" (guests get 1-hour signed links).
(function () {
  'use strict';

  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function $(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); else if (t === 'error') alert(m); }
  var norm = function (s) { return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); };
  var BUCKET = 'guide-photos', MAX_PHOTOS = 8;

  var SECTIONS = ['About the home', 'Check-in', 'Wi-Fi', 'Parking', 'Heating & cooling', 'Kitchen', 'Laundry', 'Hot tub / pool', 'Utilities', 'Tech & TV', 'Supplies', 'Trash & recycling', 'House quirks', 'Troubleshooting', 'House rules', 'Checkout', 'Local tips', 'General'];
  // The on-site walkthrough. key → one item per home (except quirks, which can repeat).
  var PROMPTS = [
    { group: 'Overview', items: [
      { key: 'overview', section: 'About the home', title: 'Home overview', hint: 'A short, practical intro shown at the top of the guest guide (replaces the Guesty marketing description): layout, how many it sleeps, kitchen, laundry, TV/Wi-Fi, parking, trash, quiet hours, checkout time.' },
    ] },
    { group: 'Utilities', items: [
      { key: 'breaker', section: 'Utilities', title: 'Breaker box', hint: 'Where is it? Any labels? e.g. "Garage, left wall behind the bikes. Kitchen is #7."' },
      { key: 'water_heater', section: 'Utilities', title: 'Water heater', hint: 'Location, gas or electric, how long hot water lasts, how to relight.' },
      { key: 'water_shutoff', section: 'Utilities', title: 'Main water shut-off', hint: 'Where it is and which way to turn it.' },
      { key: 'gfci', section: 'Utilities', title: 'GFCI / reset outlets', hint: 'Which outlets trip and where their reset button is.' },
    ] },
    { group: 'Comfort', items: [
      { key: 'thermostat', section: 'Heating & cooling', title: 'Thermostat', hint: 'Location, how to use it, limits. e.g. "Won\'t go below 70°F."' },
      { key: 'fireplace', section: 'Heating & cooling', title: 'Fireplace', hint: 'How to turn it on/off, wood or gas, any rules.' },
      { key: 'hot_tub', section: 'Hot tub / pool', title: 'Hot tub / pool', hint: 'Controls, cover, temperature, rules.' },
    ] },
    { group: 'Tech', items: [
      { key: 'router', section: 'Tech & TV', title: 'Wi-Fi router', hint: 'Where it is and how to restart it. (The Wi-Fi password comes from Guesty.)' },
      { key: 'tv', section: 'Tech & TV', title: 'TV & streaming', hint: 'Which remote, which input, apps available.' },
    ] },
    { group: 'Kitchen & laundry', items: [
      { key: 'coffee', section: 'Kitchen', title: 'Coffee maker', hint: 'Type (Keurig, drip…), where filters/pods are.' },
      { key: 'dishwasher', section: 'Kitchen', title: 'Dishwasher', hint: 'Where pods are, any quirks.' },
      { key: 'laundry', section: 'Laundry', title: 'Washer & dryer', hint: 'Location, detergent, any quirks.' },
    ] },
    { group: 'Supplies & trash', items: [
      { key: 'linens', section: 'Supplies', title: 'Extra linens & towels', hint: 'Where extra blankets, pillows and towels are.' },
      { key: 'supplies', section: 'Supplies', title: 'Cleaning supplies & paper goods', hint: 'Where to find extra TP, paper towels, trash bags.' },
      { key: 'trash', section: 'Trash & recycling', title: 'Trash & recycling bins', hint: 'Where bins are, where to take full bags.' },
    ] },
  ];
  var QUIRK = { key: 'quirk', section: 'House quirks', title: '', hint: 'Anything that trips guests up. e.g. "Push the shower door in firmly or it leaks."' };
  var ALL_PROMPTS = [].concat.apply([], PROMPTS.map(function (g) { return g.items; }));

  var S = { prop: null, listings: [], items: [], scope: 'home', guesty: null, guestyErr: null, editing: null, urls: {}, reveal: {} };

  var CSS = [
    '#proptab-guide{padding:18px 22px 26px}',
    '#proptab-guide .gg-note{background:#1e2a29;border:1px solid #2f4a47;border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.5;color:#bcd}',
    '#proptab-guide h3{font-family:"Playfair Display",serif;font-size:16px;margin:22px 0 4px;display:flex;align-items:center;gap:8px}',
    '#proptab-guide h3 .c{font-family:"DM Sans",sans-serif;font-size:11px;font-weight:600;color:var(--text-muted,#888);background:var(--surface3,#2e2e2b);border-radius:10px;padding:2px 8px}',
    '#proptab-guide .sub{font-size:12px;color:var(--text-muted,#888);margin:0 0 10px;line-height:1.45}',
    '#proptab-guide .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '#proptab-guide select,#proptab-guide input[type=text],#proptab-guide textarea{width:100%;box-sizing:border-box;background:var(--surface2,#242422);border:1px solid var(--border,#333);color:var(--text,#f0ede6);border-radius:6px;padding:9px 10px;font:inherit;font-size:13.5px}',
    '#proptab-guide textarea{resize:vertical;min-height:74px;line-height:1.45}',
    '#proptab-guide .lbl{display:block;font-size:11px;color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px}',
    '#proptab-guide .b{font:inherit;font-size:12.5px;font-weight:600;border-radius:6px;padding:7px 12px;cursor:pointer;border:1px solid var(--border,#333);background:var(--surface3,#2e2e2b);color:var(--text,#f0ede6)}',
    '#proptab-guide .b.p{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e)}',
    '#proptab-guide .b.d{background:none;color:#e06b5a;border-color:#e06b5a55}',
    '#proptab-guide .b.sm{font-size:11.5px;padding:4px 9px}',
    '#proptab-guide .warn{color:#d4a843;font-size:12px;margin-top:6px}',
    '#proptab-guide .gx{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}',
    '#proptab-guide .gx>div{background:var(--surface2,#242422);border:1px solid var(--border,#333);border-radius:8px;padding:9px 11px;min-width:0}',
    '#proptab-guide .gx .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted,#888);display:flex;justify-content:space-between;gap:6px}',
    '#proptab-guide .gx .v{font-size:13px;margin-top:3px;white-space:pre-wrap;word-break:break-word;line-height:1.45;max-height:7.5em;overflow:auto}',
    '#proptab-guide .gx .v.none{color:var(--text-muted,#888);font-style:italic}',
    '#proptab-guide .gx .wide{grid-column:1/-1}',
    '#proptab-guide .lockt{font-size:9.5px;color:#d4a843;text-transform:none;letter-spacing:0}',
    '#proptab-guide .grp{font-size:11px;font-weight:700;color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.08em;margin:14px 0 6px}',
    '#proptab-guide .pr{display:flex;gap:10px;align-items:flex-start;background:var(--surface2,#242422);border:1px solid var(--border,#333);border-radius:10px;padding:10px 12px;margin-bottom:6px;cursor:pointer}',
    '#proptab-guide .pr:hover{border-color:var(--accent,#c8a96e)}',
    '#proptab-guide .pr .dot{width:20px;height:20px;border-radius:50%;border:1.5px dashed var(--border-light,#555);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;margin-top:1px}',
    '#proptab-guide .pr.done .dot{border:none;background:#3f7a52;color:#fff}',
    '#proptab-guide .pr .t{font-weight:600;font-size:13.5px}',
    '#proptab-guide .pr .s{font-size:12px;color:var(--text-muted,#888);margin-top:2px;line-height:1.4;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '#proptab-guide .pr .thumbs{display:flex;gap:4px;margin-top:6px}',
    '#proptab-guide .pr .thumbs img{width:40px;height:40px;object-fit:cover;border-radius:5px}',
    '#proptab-guide .tag{font-size:10px;padding:2px 7px;border-radius:10px;background:var(--surface3,#2e2e2b);color:var(--text-muted,#888);margin-left:6px;font-weight:600;vertical-align:1px}',
    '#proptab-guide .tag.sens{background:#d4a84322;color:#d4a843}',
    '#proptab-guide .tag.ai{background:#3fa7a022;color:#7fc7c0}',
    '#proptab-guide .pr.off{opacity:.5}',
    '#proptab-guide .ed{background:var(--surface,#1a1a18);border:1px solid var(--accent,#c8a96e);border-radius:10px;padding:12px;margin:0 0 10px}',
    '#proptab-guide .ph{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}',
    '#proptab-guide .ph .im{position:relative;width:84px;height:84px}',
    '#proptab-guide .ph .im img{width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--border,#333)}',
    '#proptab-guide .ph .im button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:none;background:#e06b5a;color:#fff;font-size:13px;line-height:22px;cursor:pointer;padding:0}',
    '#proptab-guide .ph label.add{width:84px;height:84px;border-radius:8px;border:1.5px dashed var(--border-light,#555);display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11.5px;color:var(--text-muted,#888);cursor:pointer;text-transform:none;letter-spacing:0;margin:0;gap:2px}',
    '#proptab-guide .ph label.add b{font-size:20px;font-weight:400}',
    '#proptab-guide .chk{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin-top:9px;cursor:pointer;line-height:1.4}',
    '#proptab-guide .chk input{width:16px;height:16px;margin-top:1px;flex-shrink:0}',
    '#proptab-guide .tabs2{display:flex;gap:6px;margin-top:14px}',
    '#proptab-guide .tab2{font:inherit;font-size:12px;padding:6px 12px;border-radius:20px;border:1px solid var(--border,#333);background:none;color:var(--text-muted,#888);cursor:pointer}',
    '#proptab-guide .tab2.on{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e);font-weight:600}',
    '#proptab-guide .empty{font-size:13px;color:var(--text-muted,#888);padding:4px 0 8px}',
    '#proptab-guide .bar{height:6px;border-radius:4px;background:var(--surface3,#2e2e2b);overflow:hidden;margin:6px 0 2px}',
    '#proptab-guide .bar i{display:block;height:100%;background:#3f7a52}',
  ].join('\n');

  // ── data ──────────────────────────────────────────────────────────────
  function props() { return window.properties || (typeof properties !== 'undefined' ? properties : []); }
  function currentProp() { var id = window.currentPropertyId; return props().find(function (p) { return p.id === id; }) || null; }
  async function loadListings() {
    if (S.listings.length) return S.listings;
    var r = await db.from('listing_registry').select('listing_id,nickname,title,concierge_name').eq('is_listed', true).order('nickname');
    S.listings = (r.data || []).map(function (l) { return { id: l.listing_id, gname: String(l.nickname || l.title || '').trim(), label: (l.concierge_name || l.title || l.nickname) + (l.nickname ? ' (' + l.nickname + ')' : ''), keys: [l.nickname, l.title, l.concierge_name].map(norm) }; });
    return S.listings;
  }
  function suggest(name) {
    var n = norm(name); if (!n) return null;
    var best = null, bestScore = 0;
    S.listings.forEach(function (l) {
      var score = 0;
      l.keys.forEach(function (k) { if (!k) return; if (k === n) score = Math.max(score, 100); else if (k.indexOf(n) >= 0 || n.indexOf(k) >= 0) score = Math.max(score, 60); });
      if (!score) String(name).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 3 && ['house', 'home', 'cabin', 'retreat', 'the'].indexOf(w) < 0; })
        .forEach(function (w) { if (l.keys.some(function (k) { return k.indexOf(w) >= 0; })) score += 20; });
      if (score > bestScore) { bestScore = score; best = l; }
    });
    return bestScore >= 20 ? best : null;
  }
  async function loadItems() {
    var q = db.from('guest_guide_items').select('*').order('sort').order('id');
    q = S.scope === 'all' ? q.is('listing_id', null) : q.eq('listing_id', S.prop.listing_id);
    var r = await q;
    if (r.error) { toast('Couldn’t load the guest guide: ' + r.error.message, 'error'); S.items = []; return; }
    S.items = r.data || [];
    await signAll([].concat.apply([], S.items.map(function (x) { return x.photos || []; })));
  }
  async function signAll(paths) {
    paths = paths.filter(function (p) { return p && !S.urls[p]; });
    if (!paths.length) return;
    var r = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (r.data || []).forEach(function (x) { if (x.signedUrl) S.urls[x.path] = x.signedUrl; });
  }
  async function loadGuesty() {
    S.guesty = null; S.guestyErr = null;
    if (!S.prop.listing_id) return;
    try {
      var f = typeof authFetch === 'function' ? authFetch : fetch;
      var r = await f('/.netlify/functions/guide-guesty?listing_id=' + encodeURIComponent(S.prop.listing_id));
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      S.guesty = j.guesty;
    } catch (e) { S.guestyErr = e.message; }
  }
  async function me() { try { return (await db.auth.getUser()).data.user.email; } catch (e) { return null; } }

  // ── render ────────────────────────────────────────────────────────────
  function panel() { return $('proptab-guide'); }
  function render() {
    var el = panel(); if (!el || !S.prop) return;
    var p = S.prop, sug = !p.listing_id ? suggest(p.name) : null;
    var opts = '<option value="">— Choose the Guesty listing —</option>' + S.listings.map(function (l) {
      var sel = (p.listing_id ? l.id === p.listing_id : sug && l.id === sug.id) ? ' selected' : '';
      return '<option value="' + E(l.id) + '"' + sel + '>' + E(l.label) + '</option>'; }).join('');
    var h = '<div class="gg-note">This tab + the home’s guest info in Guesty are the <b>only</b> things the guest Home Guide and AI chat know about this home. Owner info, contracts, care and cleaning notes stay team-only. <b>Sensitive</b> items are released on check-in day.</div>';
    h += '<span class="lbl">Guesty listing</span><div class="row"><select id="gg-listing" style="flex:1;min-width:220px;">' + opts + '</select><button class="b p" data-a="link">' + (p.listing_id ? 'Update' : 'Link') + '</button></div>';
    if (!p.listing_id) h += '<div class="warn">' + (sug ? 'Suggested match selected — confirm with Link.' : 'Pick the Guesty listing for this property.') + '</div>';
    var linkedL = p.listing_id && S.listings.find(function (l) { return l.id === p.listing_id; });
    if (linkedL && linkedL.gname && linkedL.gname !== p.name) h += '<div class="warn">Guesty calls this listing “' + E(linkedL.gname) + '”. <button class="b sm" data-a="usename">Use Guesty name</button></div>';
    h += '<div class="tabs2"><button class="tab2' + (S.scope === 'home' ? ' on' : '') + '" data-a="scope-home">This home</button><button class="tab2' + (S.scope === 'all' ? ' on' : '') + '" data-a="scope-all">All homes</button></div>';

    if (S.scope === 'all') {
      h += '<h3>All homes <span class="c">' + S.items.length + '</span></h3><p class="sub">Shown in every home’s guide (e.g. how to reach us, local tips). Never put a home’s codes here.</p>';
      h += itemsList(S.items) + '<div class="row" style="margin-top:8px;"><button class="b p" data-a="new">+ Add item</button></div>';
      el.innerHTML = h; return;
    }
    if (!p.listing_id) h += '<div class="gg-note" style="margin-top:14px;background:#2a2516;border-color:#5a4a22;color:#e8d9a8;">Link the Guesty listing above to start filling in this home. The walkthrough below is what your team will complete for each home.</div>';

    // From Guesty
    if (p.listing_id) h += '<h3>From Guesty <button class="b sm" data-a="refresh" style="margin-left:auto;">↻ Refresh</button></h3><p class="sub">Pulled live from the Guesty listing. Change these in Guesty.</p>';
    if (!p.listing_id) { /* nothing to pull yet */ }
    else if (S.guestyErr) h += '<div class="warn">' + E(S.guestyErr) + '</div>';
    else if (!S.guesty) h += '<p class="empty">Loading from Guesty…</p>';
    else {
      var g = S.guesty;
      var cell = function (k, v, opt) {
        opt = opt || {};
        var shown = v && (!opt.secret || S.reveal[k]) ? E(v) : (v ? '••••••' : 'Not set in Guesty');
        return '<div class="' + (opt.wide ? 'wide' : '') + '"><div class="k"><span>' + E(k) + (opt.secret ? ' <span class="lockt">· check-in day</span>' : '') + '</span>' +
          (opt.secret && v ? '<button class="b sm" data-a="reveal" data-k="' + E(k) + '" style="padding:1px 7px;">' + (S.reveal[k] ? 'Hide' : 'Show') + '</button>' : '') + '</div><div class="v' + (v ? '' : ' none') + '">' + shown + '</div></div>';
      };
      h += '<div class="gx">' + cell('Check-in time', g.check_in_time) + cell('Checkout time', g.check_out_time) +
        cell('Wi-Fi network', g.wifi_name, { secret: true }) + cell('Wi-Fi password', g.wifi_password, { secret: true }) + cell('Door code', g.door_code, { secret: true }) + cell('Trash day', g.trash_day) +
        cell('Check-in instructions', g.checkin_instructions, { secret: true, wide: true }) + cell('Checkout instructions', g.checkout_instructions, { wide: true }) +
        cell('Parking', g.parking, { wide: true }) + cell('House manual', g.house_manual, { secret: true, wide: true }) + '</div>';
      var d = g.detected || {};
      if (!d.checkin_field || !d.door_code_field) h += '<div class="warn">Couldn’t find a Guesty custom field for ' + [!d.checkin_field && 'check-in instructions', !d.door_code_field && 'door code'].filter(Boolean).join(' or ') + '.' + (d.errors && d.errors.length ? ' (' + E(d.errors[d.errors.length - 1]) + ')' : '') + '</div>';
    }

    // Walkthrough
    var byKey = {}; S.items.forEach(function (x) { if (x.prompt_key && x.prompt_key !== 'quirk') byKey[x.prompt_key] = x; });
    var done = ALL_PROMPTS.filter(function (pr) { return byKey[pr.key]; }).length;
    h += '<h3>Home walkthrough <span class="c">' + done + ' / ' + ALL_PROMPTS.length + '</span></h3><p class="sub">Fill these in on site. Short and specific, with a photo where it helps. Skip anything the home doesn’t have.</p>';
    h += '<div class="bar"><i style="width:' + Math.round(done / ALL_PROMPTS.length * 100) + '%"></i></div>';
    PROMPTS.forEach(function (grp) {
      h += '<div class="grp">' + E(grp.group) + '</div>';
      grp.items.forEach(function (pr) {
        var x = byKey[pr.key];
        if (S.editing && (S.editing.prompt === pr.key || (x && S.editing.id === x.id))) { h += editorHtml(); return; }
        h += promptRow(pr, x);
      });
    });
    // Quirks
    var quirks = S.items.filter(function (x) { return x.prompt_key === 'quirk'; });
    h += '<div class="grp">House quirks &amp; nuances</div>';
    quirks.forEach(function (x) { h += (S.editing && S.editing.id === x.id) ? editorHtml() : itemRow(x); });
    if (S.editing && S.editing.prompt === 'quirk' && !S.editing.id) h += editorHtml();
    h += '<button class="b sm" data-a="prompt" data-k="quirk">+ Add a quirk</button>';

    // Other
    var other = S.items.filter(function (x) { return !x.prompt_key; });
    h += '<h3>Other guide items <span class="c">' + other.length + '</span></h3><p class="sub">Anything else guests should know — check-in extras, house rules, local tips.</p>';
    h += itemsList(other);
    if (S.editing && !S.editing.id && !S.editing.prompt) h += editorHtml();
    h += '<div class="row" style="margin-top:8px;"><button class="b p" data-a="new">+ Add item</button></div>';
    el.innerHTML = h;
  }
  function tags(x) {
    return (x.sensitive ? '<span class="tag sens">Sensitive</span>' : '') + (x.ai_only ? '<span class="tag ai">AI only</span>' : '') + (x.active === false ? '<span class="tag">Hidden</span>' : '');
  }
  function thumbs(x) {
    var ph = (x.photos || []).filter(function (p) { return S.urls[p]; });
    return ph.length ? '<div class="thumbs">' + ph.slice(0, 5).map(function (p) { return '<img src="' + E(S.urls[p]) + '" alt="">'; }).join('') + (ph.length > 5 ? '<span class="tag">+' + (ph.length - 5) + '</span>' : '') + '</div>' : '';
  }
  function promptRow(pr, x) {
    if (!x) return '<div class="pr" data-a="prompt" data-k="' + E(pr.key) + '"><div class="dot"></div><div style="flex:1;min-width:0;"><div class="t">' + E(pr.title) + '</div><div class="s">' + E(pr.hint) + '</div></div><span class="b sm" style="flex-shrink:0;">+ Add details &amp; photos</span></div>';
    return itemRow(x, pr.title);
  }
  function itemRow(x, title) {
    return '<div class="pr done' + (x.active === false ? ' off' : '') + '" data-a="edit" data-id="' + E(x.id) + '"><div class="dot">&#10003;</div><div style="flex:1;min-width:0;"><div class="t">' + E(title || x.title) + tags(x) + '</div><div class="s">' + E(x.body) + '</div>' + thumbs(x) + '</div></div>';
  }
  function itemsList(list) {
    if (!list.length && !(S.editing && !S.editing.id && !S.editing.prompt)) return '<p class="empty">Nothing yet.</p>';
    return list.map(function (x) { return (S.editing && S.editing.id === x.id) ? editorHtml() : itemRow(x); }).join('');
  }
  function editorHtml() {
    var x = S.editing.draft, pr = S.editing.prompt && S.editing.prompt !== 'quirk' ? ALL_PROMPTS.find(function (p) { return p.key === S.editing.prompt; }) : null;
    var secs = SECTIONS.indexOf(x.section) >= 0 ? SECTIONS : SECTIONS.concat([x.section]);
    var hint = (pr && pr.hint) || (S.editing.prompt === 'quirk' ? QUIRK.hint : 'Write it the way you’d text it to a guest. Short and specific.');
    var h = '<div class="ed" id="gg-ed">';
    if (!pr) h += '<div class="row"><div style="flex:1;min-width:150px;"><span class="lbl" style="margin-top:0;">Section</span><select data-f="section">' + secs.map(function (s) { return '<option' + (s === x.section ? ' selected' : '') + '>' + E(s) + '</option>'; }).join('') + '</select></div>' +
      '<div style="flex:2;min-width:200px;"><span class="lbl" style="margin-top:0;">Title</span><input type="text" data-f="title" maxlength="120" value="' + E(x.title) + '" placeholder="' + (S.editing.prompt === 'quirk' ? 'e.g. Shower door' : 'e.g. Ceiling fans') + '"></div></div>';
    else h += '<div class="t" style="font-weight:700;font-size:14px;">' + E(pr.title) + '</div>';
    h += '<span class="lbl">Details</span><textarea data-f="body" maxlength="4000" placeholder="' + E(hint) + '">' + E(x.body) + '</textarea>';
    h += '<span class="lbl">Photos <span style="text-transform:none;letter-spacing:0;">(' + x.photos.length + '/' + MAX_PHOTOS + ')</span></span><div class="ph">' +
      x.photos.map(function (p, i) { return '<div class="im">' + (S.urls[p] ? '<img src="' + E(S.urls[p]) + '" alt="">' : '<img alt="">') + '<button type="button" data-a="rmphoto" data-i="' + i + '" aria-label="Remove photo">&times;</button></div>'; }).join('') +
      (x.photos.length < MAX_PHOTOS ? '<label class="add" id="gg-add-lbl"><b>+</b>' + (S.editing.uploading ? 'Uploading…' : 'Add photo') + '<input type="file" id="gg-file" accept="image/*" multiple style="display:none;"></label>' : '') + '</div>';
    h += '<label class="chk"><input type="checkbox" data-f="sensitive"' + (x.sensitive ? ' checked' : '') + '><span><b>Sensitive</b> — codes, passwords, lockbox. Only released on check-in day.</span></label>';
    h += '<label class="chk"><input type="checkbox" data-f="ai_only"' + (x.ai_only ? ' checked' : '') + '><span><b>AI only</b> — the AI chat can use it, but it isn’t shown in the guest guide.</span></label>';
    h += '<label class="chk"><input type="checkbox" data-f="active"' + (x.active !== false ? ' checked' : '') + '><span>Active (uncheck to hide without deleting)</span></label>';
    h += '<div class="row" style="margin-top:12px;justify-content:space-between;"><div>' + (x.id ? '<button class="b d" data-a="del">Delete</button>' : '') + '</div><div class="row"><button class="b" data-a="cancel">Cancel</button><button class="b p" data-a="save"' + (S.editing.uploading ? ' disabled' : '') + '>Save</button></div></div></div>';
    return h;
  }
  function readDraft() {
    var f = $('gg-ed'); if (!f) return;
    var d = S.editing.draft, get = function (k) { return f.querySelector('[data-f="' + k + '"]'); };
    if (get('section')) d.section = get('section').value;
    if (get('title')) d.title = get('title').value;
    d.body = get('body').value; d.sensitive = get('sensitive').checked; d.ai_only = get('ai_only').checked; d.active = get('active').checked;
  }
  function startEdit(x, promptKey) {
    var pr = promptKey ? (promptKey === 'quirk' ? QUIRK : ALL_PROMPTS.find(function (p) { return p.key === promptKey; })) : null;
    var base = x || { section: pr ? pr.section : 'General', title: pr ? pr.title : '', body: '', sensitive: false, ai_only: false, active: true, photos: [] };
    S.editing = { id: x ? x.id : null, prompt: x ? (x.prompt_key || null) : (promptKey || null), draft: JSON.parse(JSON.stringify(base)), uploaded: [], removed: [], original: x ? (x.photos || []).slice() : [] };
    S.editing.draft.photos = S.editing.draft.photos || [];
    render();
    var ed = $('gg-ed'); if (ed) { ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); var t = ed.querySelector('textarea'); if (t) t.focus(); }
  }
  async function cancelEdit() {
    if (S.editing && S.editing.uploaded.length) await db.storage.from(BUCKET).remove(S.editing.uploaded).catch(function () {});
    S.editing = null; render();
  }

  // ── photos ────────────────────────────────────────────────────────────
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1600, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Couldn’t read that image')); }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file isn’t an image we can read (try a JPG or PNG).')); };
      img.src = url;
    });
  }
  function rid() { var a = new Uint8Array(9); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  async function addPhotos(files) {
    readDraft();
    var d = S.editing.draft, room = MAX_PHOTOS - d.photos.length;
    files = Array.prototype.slice.call(files, 0, room);
    if (!files.length) return;
    S.editing.uploading = true; render();
    var folder = S.scope === 'all' ? 'all' : S.prop.listing_id;
    for (var i = 0; i < files.length; i++) {
      try {
        var blob = await compress(files[i]);
        var path = folder + '/' + Date.now().toString(36) + '-' + rid() + '.jpg';
        var r = await db.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (r.error) throw r.error;
        d.photos.push(path); S.editing.uploaded.push(path);
        S.urls[path] = URL.createObjectURL(blob);
      } catch (e) { toast('Photo upload failed: ' + (e.message || e), 'error'); }
    }
    S.editing.uploading = false; render();
  }

  // ── actions ───────────────────────────────────────────────────────────
  async function onClick(e) {
    var b = e.target.closest('[data-a]'); if (!b || !panel().contains(b)) return;
    var a = b.getAttribute('data-a');
    if (S.editing && ['prompt', 'edit', 'new', 'scope-home', 'scope-all', 'link'].indexOf(a) >= 0) {
      if (b.closest('#gg-ed')) return;
      readDraft();
      if (S.editing.draft.body.trim() || S.editing.uploaded.length) { if (!confirm('Discard the item you’re editing?')) return; }
      await cancelEdit();
    }
    if (a === 'scope-home' || a === 'scope-all') { S.scope = a === 'scope-all' ? 'all' : 'home'; S.items = []; if (S.scope === 'all' || S.prop.listing_id) await loadItems(); return render(); }
    if (a === 'refresh') { S.guesty = null; render(); await loadGuesty(); return render(); }
    if (a === 'reveal') { var k = b.getAttribute('data-k'); S.reveal[k] = !S.reveal[k]; return render(); }
    if (a === 'link') {
      var lid = $('gg-listing').value; if (!lid) return toast('Choose a listing first.', 'error');
      var taken = props().find(function (x) { return x.listing_id === lid && x.id !== S.prop.id; });
      if (taken && !confirm('“' + taken.name + '” is already linked to that listing. Link this property too?')) return;
      var r = await db.from('properties').update({ listing_id: lid }).eq('id', S.prop.id);
      if (r.error) return toast(/listing_id|schema cache/i.test(r.error.message) ? 'Couldn’t link: the Guest Guide database update hasn’t been run in Supabase yet.' : 'Couldn’t link: ' + r.error.message, 'error');
      S.prop.listing_id = lid; toast('Linked to Guesty.', 'success');
      var L = S.listings.find(function (l) { return l.id === lid; });
      if (L && L.gname && L.gname !== S.prop.name && confirm('Rename “' + S.prop.name + '” to “' + L.gname + '” so it matches Guesty?')) await renameProperty(S.prop, L.gname);
      await Promise.all([loadItems(), loadGuesty()]); render(); badge(); return;
    }
    if ((a === 'prompt' || a === 'new') && S.scope === 'home' && !S.prop.listing_id) { var sel = $('gg-listing'); if (sel) sel.focus(); return toast('Link this property to its Guesty listing first (top of this tab).', 'error'); }
    if (a === 'usename') { var L2 = S.listings.find(function (l) { return l.id === S.prop.listing_id; }); if (L2 && L2.gname) { await renameProperty(S.prop, L2.gname); render(); } return; }
    if (a === 'prompt') return startEdit(null, b.getAttribute('data-k'));
    if (a === 'new') return startEdit(null, null);
    if (a === 'edit') { var it = S.items.find(function (x) { return String(x.id) === b.getAttribute('data-id'); }); if (it) startEdit(it); return; }
    if (a === 'cancel') return cancelEdit();
    if (a === 'rmphoto') { readDraft(); var i = +b.getAttribute('data-i'), p = S.editing.draft.photos.splice(i, 1)[0]; if (p) S.editing.removed.push(p); return render(); }
    if (a === 'del') {
      if (!S.editing.id || !confirm('Delete this item? Guests and the AI stop seeing it right away.')) return;
      var rd = await db.from('guest_guide_items').delete().eq('id', S.editing.id);
      if (rd.error) return toast('Delete failed: ' + rd.error.message, 'error');
      var gone = S.editing.original.concat(S.editing.uploaded);
      if (gone.length) await db.storage.from(BUCKET).remove(gone).catch(function () {});
      S.editing = null; await loadItems(); render(); badge(); return;
    }
    if (a === 'save') return save();
  }
  function looksSecret(t) { return /\b(code|password|passcode|pin|wifi|wi-fi|lockbox|keypad)\b/i.test(t) && /\b[\dA-Z]{4,}\b/.test(t); }
  async function save() {
    readDraft();
    var ed = S.editing, d = ed.draft;
    var row = { section: d.section, title: String(d.title || '').trim(), body: String(d.body || '').trim(), sensitive: !!d.sensitive, ai_only: !!d.ai_only, active: d.active !== false, photos: d.photos, prompt_key: ed.prompt || null, updated_by: await me(), updated_at: new Date().toISOString() };
    if (!row.title) return toast('Add a title.', 'error');
    if (!row.body && !row.photos.length) return toast('Add some details or a photo.', 'error');
    if (!row.sensitive && looksSecret(row.title + ' ' + row.body) && !confirm('This looks like it has a code or password. Save it as NOT sensitive (visible up to 48h before check-in)?\n\nCancel, then tick “Sensitive”, to release it only on check-in day.')) return;
    if (S.scope === 'all' && looksSecret(row.title + ' ' + row.body) && !confirm('This shows in EVERY home’s guide. Are you sure it should include a code or password?')) return;
    var res;
    if (ed.id) res = await db.from('guest_guide_items').update(row).eq('id', ed.id);
    else { row.listing_id = S.scope === 'all' ? null : S.prop.listing_id; row.sort = (S.items.length + 1) * 10; res = await db.from('guest_guide_items').insert(row); }
    if (res.error) return toast('Save failed: ' + res.error.message + (/column|photos|ai_only|prompt_key/.test(res.error.message) ? ' — the guide database update hasn’t been run yet.' : ''), 'error');
    if (ed.removed.length) await db.storage.from(BUCKET).remove(ed.removed).catch(function () {});
    S.editing = null; toast('Saved — the guide and AI use this right away.', 'success');
    await loadItems(); render(); badge();
  }

  // ── property name (editable; can follow the Guesty listing name) ─────────
  // Invoices store the property NAME, so a rename also updates this property's charges and
  // recurring invoices — otherwise they'd lose their link (package badge, totals by property).
  async function renameProperty(p, newName) {
    newName = String(newName || '').trim(); var old = p.name;
    if (!newName || newName === old) return true;
    if (props().some(function (x) { return x.id !== p.id && String(x.name).trim().toLowerCase() === newName.toLowerCase(); })) { toast('Another property is already named “' + newName + '”.', 'error'); return false; }
    var r = await db.from('properties').update({ name: newName }).eq('id', p.id);
    if (r.error) { toast('Rename failed: ' + r.error.message, 'error'); return false; }
    var errs = [];
    for (var t of ['prop_charges', 'recurring_invoices']) {
      var u = await db.from(t).update({ property_name: newName }).eq('property_name', old);
      if (u.error) errs.push(t + ': ' + u.error.message);
    }
    props().forEach(function (x) { if (x.id === p.id) x.name = newName; }); p.name = newName;
    ['invCharges', 'propCharges', 'recurringInvoices'].forEach(function (k) { var arr = window[k]; if (Array.isArray(arr)) arr.forEach(function (c) { if (c && c.property_name === old) c.property_name = newName; }); });
    var hd = $('prop-detail-name'); if (hd && window.currentPropertyId === p.id) hd.textContent = newName;
    if (typeof renderPropertyGrid === 'function') try { renderPropertyGrid(); } catch (e) {}
    toast(errs.length ? 'Renamed, but some invoices didn’t update: ' + errs.join('; ') : 'Renamed to “' + newName + '”.', errs.length ? 'error' : 'success');
    return true;
  }
  function nameInput() {
    var i = $('pe-name');
    if (!i) {
      var hd = $('prop-detail-name'); if (!hd) return null;
      i = document.createElement('input'); i.id = 'pe-name'; i.type = 'text'; i.maxLength = 120; i.placeholder = 'Property name (match Guesty)';
      i.style.cssText = 'display:none;width:100%;min-width:220px;font:inherit;font-size:17px;font-weight:600;background:var(--surface2,#242422);border:1px solid var(--accent,#c8a96e);color:var(--text,#f0ede6);border-radius:6px;padding:6px 9px;box-sizing:border-box;';
      hd.parentNode.insertBefore(i, hd.nextSibling);
    }
    return i;
  }
  function showNameEdit(on) {
    var i = nameInput(), hd = $('prop-detail-name'); if (!i || !hd) return;
    var p = currentProp();
    if (on && p) { i.value = p.name || ''; i.style.display = ''; hd.style.display = 'none'; }
    else { i.style.display = 'none'; hd.style.display = ''; }
  }
  function wrapEdit() {
    if (typeof window.togglePropEdit === 'function' && !window.togglePropEdit.__gg) {
      var t0 = window.togglePropEdit;
      window.togglePropEdit = function () { var r = t0.apply(this, arguments); showNameEdit(!!window.propEditMode); return r; };
      window.togglePropEdit.__gg = true;
    }
    if (typeof window.savePropEdits === 'function' && !window.savePropEdits.__gg) {
      var s0 = window.savePropEdits;
      window.savePropEdits = async function () {
        var i = $('pe-name'), p = currentProp();
        if (i && i.style.display !== 'none' && p) {
          var nn = i.value.trim();
          if (!nn) return toast('The property needs a name.', 'error');
          if (nn !== p.name && !(await renameProperty(p, nn))) return;
        }
        var r = await s0.apply(this, arguments); showNameEdit(false); return r;
      };
      window.savePropEdits.__gg = true;
    }
  }

  // ── tab wiring ────────────────────────────────────────────────────────
  function badge() {
    var b = $('gg-tab-btn'); if (!b) return;
    var n = S.prop && S.prop.listing_id && S.scope === 'home' ? S.items.length : null;
    b.innerHTML = '&#129302; Guest Guide &amp; AI' + (n != null ? ' <span style="opacity:.6;font-weight:400;">' + n + '</span>' : '');
  }
  async function openTab(btn) {
    var p = currentProp(); if (!p) return;
    if (typeof switchPropTab === 'function') switchPropTab('guide', btn);
    if (!S.prop || S.prop.id !== p.id) { S.prop = p; S.scope = 'home'; S.items = []; S.guesty = null; S.guestyErr = null; S.editing = null; S.reveal = {}; }
    S.prop = p;
    panel().innerHTML = '<p class="empty">Loading…</p>';
    try { await loadListings(); render(); await Promise.all([S.prop.listing_id ? loadItems() : null, S.prop.listing_id ? loadGuesty() : null]); } catch (e) { toast('Couldn’t load: ' + e.message, 'error'); }
    render(); badge();
  }
  function install() {
    var modal = $('modal-property-detail'); if (!modal || $('gg-tab-btn')) return !!modal;
    var tabs = modal.querySelector('.prop-tabs'), last = $('proptab-notes'); if (!tabs || !last) return false;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var btn = document.createElement('button'); btn.className = 'prop-tab'; btn.id = 'gg-tab-btn'; btn.type = 'button';
    btn.innerHTML = '&#129302; Guest Guide &amp; AI';
    btn.addEventListener('click', function () { openTab(btn); });
    tabs.appendChild(btn);
    var pn = document.createElement('div'); pn.className = 'prop-tab-panel'; pn.id = 'proptab-guide'; pn.style.display = 'none';
    last.parentNode.insertBefore(pn, last.nextSibling);
    pn.addEventListener('click', onClick);
    wrapEdit();
    pn.addEventListener('change', function (e) { if (e.target.id === 'gg-file' && e.target.files && e.target.files.length) addPhotos(e.target.files); });
    // New property opened → forget the previous one's state
    if (typeof window.openPropertyDetail === 'function' && !window.openPropertyDetail.__gg) {
      var orig = window.openPropertyDetail;
      window.openPropertyDetail = function () { S.prop = null; S.editing = null; var r = orig.apply(this, arguments); btn.innerHTML = '&#129302; Guest Guide &amp; AI'; showNameEdit(false); return r; };
      window.openPropertyDetail.__gg = true;
    }
    return true;
  }
  function boot() {
    if (typeof db === 'undefined') return;
    if (!install()) { var t = 0, iv = setInterval(function () { if (install() || ++t > 30) clearInterval(iv); }, 1000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  // Also load the PropDesk Concierge dashboard (js/concierge-dashboard.js)
  if (!document.querySelector('script[src^="/js/concierge-dashboard.js"]')) { var cs = document.createElement('script'); cs.src = '/js/concierge-dashboard.js'; cs.defer = true; document.head.appendChild(cs); }
  window.PropDeskGuestGuide = { open: function () { var b = $('gg-tab-btn'); if (b) openTab(b); } };
})();
