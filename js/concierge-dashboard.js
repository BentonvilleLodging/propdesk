// js/concierge-dashboard.js — "Concierge" page in PropDesk (staff only)
//
// Loaded by js/ai-training.js. Adds a Concierge item to the PropDesk nav with five views:
//   • Overview         — sign-ins, guest messages, how many were answered instantly vs by the AI vs
//                        handed to the team, estimated AI cost, top topics, per-home table.
//   • Needs attention  — chats the AI handed to the team, and questions the guide couldn't answer
//                        ("missing from guide"). Mark each one Resolved / Added to guide / Ignore.
//   • Conversations    — every guest chat, with each reply tagged Instant / AI / Team.
//   • Sign-ins         — every sign-in attempt (who got in, what failed and why, repeated failures).
//   • Things to Do     — add / edit / hide the places in every guest guide.
//
// Reads concierge_sessions / concierge_attempts / concierge_messages (staff read-only via RLS) and
// writes concierge_reviews + local_places (staff only). Never selects token or IP hashes in full.
(function () {
  'use strict';
  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function $(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); else if (t === 'error') alert(m); }
  var TZ = 'America/Chicago';
  function when(d) { return d ? new Date(d).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function day(d) { return d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }) : ''; }
  function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; }
  function money(n) { return '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()); }

  // Estimated Claude cost per million tokens (Sonnet-class rates). Update if pricing changes.
  var RATE = { input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.3 };
  function cost(u) {
    if (!u) return 0;
    var cc = u.cache_creation || {}, w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens;
    if (w5 == null && w1 == null) w5 = u.cache_creation_input_tokens || 0;
    return ((u.input_tokens || 0) * RATE.input + (u.output_tokens || 0) * RATE.output + (w5 || 0) * RATE.cache_write_5m + (w1 || 0) * RATE.cache_write_1h + (u.cache_read_input_tokens || 0) * RATE.cache_read) / 1e6;
  }
  var TOPIC = { wifi: 'Wi-Fi', door: 'Door code', access: 'Door / access', checkin: 'Check-in', checkin_how: 'Check-in', checkout: 'Checkout', checkout_how: 'Checkout', address: 'Address & directions', parking: 'Parking', trash: 'Trash', place: 'Food & drink nearby', local: 'Things to do', appliances: 'Appliances', amenities: 'Amenities', supplies: 'Supplies', house_rules: 'House rules', issue: 'Problems', request: 'Requests', other: 'Other' };
  function topicLabel(t) { if (TOPIC[t]) return TOPIC[t]; var m = /^(?:item|guide|lookup)[:_](.+)$/i.exec(t || ''); return m ? m[1] : String(t || 'Other').replace(/_/g, ' '); }
  var CATS = ['Eat', 'Coffee', 'Drinks', 'Outdoors', 'Museums & Arts', 'Family', 'Explore'];
  var REASON = { 'no match (phone)': 'Phone + last name didn’t match a booking', 'no match (email)': 'Email + last name didn’t match a booking', 'no match (code)': 'Booking code not found', 'no match': 'No matching booking', 'bad input': 'Incomplete form', 'rate limited': 'Too many attempts (blocked)', 'too early': 'Before the 48-hour window', 'too late': 'After checkout', 'canceled': 'Reservation canceled' };
  function reasonLabel(r) { r = String(r || ''); if (REASON[r]) return REASON[r]; var m = /^ok \((\w+)\)$/.exec(r); return m ? 'Signed in with ' + ({ phone: 'phone', code: 'booking code', email: 'email' }[m[1]] || m[1]) : r; }

  var S = { view: 'overview', days: 30, loaded: false, sessions: [], attempts: [], msgs: [], reviews: {}, names: {}, props: [], places: [], showReviewed: false, q: '', open: {}, placeCat: '', editPlace: null };

  var CSS = [
    '#page-concierge main{max-width:1180px;margin:0 auto;padding:22px 20px 60px}',
    '#page-concierge h1{font-family:"Playfair Display",serif;font-size:24px;margin:0}',
    '#page-concierge .cd-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}',
    '#page-concierge .cd-top .sp{flex:1}',
    '#page-concierge select,#page-concierge input[type=text],#page-concierge input[type=number],#page-concierge textarea{background:var(--surface2,#242422);border:1px solid var(--border,#333);color:var(--text,#f0ede6);border-radius:6px;padding:8px 10px;font:inherit;font-size:13px;box-sizing:border-box}',
    '#page-concierge textarea{width:100%;min-height:60px;resize:vertical}',
    '#page-concierge .b{font:inherit;font-size:12.5px;font-weight:600;border-radius:6px;padding:7px 12px;cursor:pointer;border:1px solid var(--border,#333);background:var(--surface3,#2e2e2b);color:var(--text,#f0ede6)}',
    '#page-concierge .b.p{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e)}',
    '#page-concierge .b.sm{font-size:11.5px;padding:4px 9px}',
    '#page-concierge .b.d{background:none;color:#e06b5a;border-color:#e06b5a55}',
    '#page-concierge .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px;border-bottom:1px solid var(--border,#333);padding-bottom:10px}',
    '#page-concierge .tab{font:inherit;font-size:13px;padding:7px 14px;border-radius:20px;border:1px solid var(--border,#333);background:none;color:var(--text-muted,#999);cursor:pointer}',
    '#page-concierge .tab.on{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e);font-weight:700}',
    '#page-concierge .tab .n{display:inline-block;min-width:18px;margin-left:6px;padding:0 6px;border-radius:10px;background:#e06b5a;color:#fff;font-size:11px;font-weight:700;text-align:center}',
    '#page-concierge .kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-bottom:16px}',
    '#page-concierge .kpi{background:var(--surface,#1a1a18);border:1px solid var(--border,#333);border-radius:12px;padding:12px 14px}',
    '#page-concierge .kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted,#999)}',
    '#page-concierge .kpi .v{font-size:24px;font-weight:700;margin-top:4px}',
    '#page-concierge .kpi .s{font-size:12px;color:var(--text-muted,#999);margin-top:2px}',
    '#page-concierge .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px}',
    '#page-concierge .box{background:var(--surface,#1a1a18);border:1px solid var(--border,#333);border-radius:12px;padding:14px 16px;min-width:0}',
    '#page-concierge .box h3{margin:0 0 10px;font-size:14px}',
    '#page-concierge .bar{display:flex;align-items:center;gap:8px;font-size:12.5px;margin:6px 0}',
    '#page-concierge .bar .l{width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#page-concierge .bar .t{flex:1;height:8px;border-radius:4px;background:var(--surface3,#2e2e2b);overflow:hidden;display:flex}',
    '#page-concierge .bar .t i{display:block;height:100%}',
    '#page-concierge .bar .c{width:46px;text-align:right;color:var(--text-muted,#999)}',
    '#page-concierge .leg{display:flex;gap:14px;font-size:12px;color:var(--text-muted,#999);margin-top:8px;flex-wrap:wrap}',
    '#page-concierge .leg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:0}',
    '#page-concierge table{width:100%;border-collapse:collapse;font-size:12.5px}',
    '#page-concierge th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted,#999);font-weight:600;padding:7px 8px;border-bottom:1px solid var(--border,#333)}',
    '#page-concierge td{padding:8px;border-bottom:1px solid var(--border,#2a2a28);vertical-align:top}',
    '#page-concierge .tw{overflow-x:auto}',
    '#page-concierge .pill{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:10px;letter-spacing:.02em;white-space:nowrap}',
    '#page-concierge .p-instant{background:#3f7a5233;color:#7fcf98}',
    '#page-concierge .p-ai{background:#3fa7a026;color:#7fc7c0}',
    '#page-concierge .p-team{background:#d4a84333;color:#e2bf62}',
    '#page-concierge .p-urgent,#page-concierge .p-emergency,#page-concierge .p-fail{background:#e06b5a33;color:#f09080}',
    '#page-concierge .p-gap{background:#8a6fd633;color:#b9a6f0}',
    '#page-concierge .p-ok{background:#3f7a5233;color:#7fcf98}',
    '#page-concierge .p-muted{background:var(--surface3,#2e2e2b);color:var(--text-muted,#999)}',
    '#page-concierge .att{background:var(--surface,#1a1a18);border:1px solid var(--border,#333);border-radius:12px;padding:12px 14px;margin-bottom:10px}',
    '#page-concierge .att.done{opacity:.55}',
    '#page-concierge .att .hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--text-muted,#999)}',
    '#page-concierge .att .hd b{color:var(--text,#f0ede6)}',
    '#page-concierge .att .q{margin:8px 0 4px;font-size:14px}',
    '#page-concierge .att .a{font-size:13px;color:var(--text-muted,#aaa);white-space:pre-wrap;border-left:2px solid var(--border,#333);padding-left:10px;margin:6px 0}',
    '#page-concierge .att .sum{font-size:13px;margin-top:6px}',
    '#page-concierge .att .ac{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}',
    '#page-concierge .att .ac input{flex:1;min-width:160px}',
    '#page-concierge .conv{background:var(--surface,#1a1a18);border:1px solid var(--border,#333);border-radius:12px;margin-bottom:8px}',
    '#page-concierge .conv .row{display:flex;gap:10px;align-items:center;padding:11px 14px;cursor:pointer;flex-wrap:wrap}',
    '#page-concierge .conv .row .nm{font-weight:700;font-size:13.5px}',
    '#page-concierge .conv .row .mt{font-size:12px;color:var(--text-muted,#999)}',
    '#page-concierge .conv .row .sp{flex:1}',
    '#page-concierge .thread{padding:4px 14px 14px;display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--border,#2a2a28)}',
    '#page-concierge .bub{max-width:78%;padding:8px 11px;border-radius:14px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}',
    '#page-concierge .bub.u{align-self:flex-end;background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e)}',
    '#page-concierge .bub.a{align-self:flex-start;background:var(--surface3,#2e2e2b)}',
    '#page-concierge .bub .tm{display:block;font-size:10.5px;opacity:.65;margin-top:3px}',
    '#page-concierge .empty{color:var(--text-muted,#999);font-size:13px;padding:10px 0}',
    '#page-concierge .note{font-size:12.5px;color:var(--text-muted,#999);margin:-4px 0 12px;line-height:1.5}',
    '#page-concierge .pl{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '#page-concierge .pl label{font-size:11px;color:var(--text-muted,#999);text-transform:uppercase;letter-spacing:.05em;display:block}',
    '#page-concierge .pl label input,#page-concierge .pl label select{width:100%;margin-top:3px}',
    '#page-concierge .pl .w{grid-column:1/-1}',
    '#page-concierge .chk{display:flex !important;align-items:center;gap:6px;font-size:12.5px !important;text-transform:none !important;letter-spacing:0 !important;color:var(--text,#f0ede6) !important}',
    '#page-concierge .pl label.chk input{width:16px;height:16px;margin:0}',
    '#page-concierge tr.off td{opacity:.45}',
    '@media(max-width:640px){#page-concierge .bar .l{width:100px}#page-concierge .pl{grid-template-columns:1fr}}',
  ].join('\n');

  // ── data ─────────────────────────────────────────────────────────────────
  async function q(builder) { var r = await builder; if (r.error) throw new Error(r.error.message); return r.data || []; }
  async function load() {
    var since = new Date(Date.now() - S.days * 86400000).toISOString();
    var res = await Promise.all([
      q(db.from('concierge_sessions').select('id,reservation_id,listing_id,guest_first_name,check_in,check_out_date,expires_at,method,revoked,revoked_reason,created_at,last_verified_at').gte('created_at', since).order('created_at', { ascending: false }).limit(2000)),
      q(db.from('concierge_attempts').select('id,created_at,listing_id,ok,reason,ip_hash').gte('created_at', since).order('created_at', { ascending: false }).limit(3000)),
      q(db.from('concierge_messages').select('id,session_id,reservation_id,listing_id,role,content,escalate,meta,created_at').gte('created_at', since).order('id', { ascending: true }).limit(5000)),
      q(db.from('concierge_reviews').select('*').gte('reviewed_at', new Date(Date.now() - (S.days + 30) * 86400000).toISOString()).limit(5000)),
      S.loaded ? Promise.resolve(null) : q(db.from('listing_registry').select('listing_id,nickname,title,concierge_name')),
    ]);
    S.sessions = res[0]; S.attempts = res[1]; S.msgs = res[2];
    S.reviews = {}; res[3].forEach(function (r) { S.reviews[r.message_id] = r; });
    if (res[4]) res[4].forEach(function (l) { S.names[l.listing_id] = l.nickname || l.concierge_name || l.title || l.listing_id; });
    S.props = window.properties || (typeof properties !== 'undefined' ? properties : []);
    S.loaded = true;
    derive();
  }
  async function loadPlaces() { S.places = await q(db.from('local_places').select('*').order('category').order('sort').order('name')); }
  function home(id) { return S.names[id] || (id ? 'Home ' + String(id).slice(-5) : '—'); }

  function source(m) {
    var meta = m.meta || {};
    if (m.escalate) return 'team';
    if (meta.canned) return 'instant';
    return 'ai';
  }
  // pair every reply with the guest message it answers; build "needs attention" + topics
  function derive() {
    var lastUser = {}, sess = {};
    S.sessions.forEach(function (s) { sess[s.id] = s; });
    S.pairs = []; S.byRes = {};
    S.msgs.forEach(function (m) {
      var key = m.reservation_id || ('s' + m.session_id);
      (S.byRes[key] = S.byRes[key] || []).push(m);
      if (m.role === 'user') { lastUser[key] = m; return; }
      var u = lastUser[key], meta = m.meta || {};
      var topics = meta.canned === 'quick' ? (meta.intents || []) : meta.canned ? [] : [meta.topic || (m.escalate ? 'issue' : 'other')];
      S.pairs.push({ m: m, u: u || null, key: key, src: source(m), meta: meta, topics: topics, cost: cost(meta.usage), session: sess[m.session_id] || null });
    });
    S.attention = S.pairs.filter(function (p) { return p.m.escalate || p.meta.gap || p.meta.error; }).reverse();
    S.openCount = S.attention.filter(function (p) { return !S.reviews[p.m.id]; }).length;
  }

  // ── views ────────────────────────────────────────────────────────────────
  function page() { return $('page-concierge'); }
  function render() {
    var el = page(); if (!el) return;
    var h = '<main><div class="cd-top"><h1>Concierge</h1><span class="sp"></span>' +
      '<select data-a="days">' + [7, 30, 90].map(function (d) { return '<option value="' + d + '"' + (S.days === d ? ' selected' : '') + '>Last ' + d + ' days</option>'; }).join('') + '</select>' +
      '<button class="b" data-a="reload">&#8635; Refresh</button></div>';
    var tabs = [['overview', 'Overview'], ['attention', 'Needs attention'], ['convos', 'Conversations'], ['signins', 'Sign-ins'], ['places', 'Things to Do']];
    h += '<div class="tabs">' + tabs.map(function (t) { return '<button class="tab' + (S.view === t[0] ? ' on' : '') + '" data-a="view" data-v="' + t[0] + '">' + t[1] + (t[0] === 'attention' && S.openCount ? '<span class="n">' + S.openCount + '</span>' : '') + '</button>'; }).join('') + '</div>';
    if (!S.loaded) h += '<p class="empty">Loading…</p>';
    else h += ({ overview: vOverview, attention: vAttention, convos: vConvos, signins: vSignins, places: vPlaces })[S.view]();
    el.innerHTML = h + '</main>';
  }

  function bars(rows, wide, color) {
    if (!rows.length) return '<p class="empty">Nothing yet.</p>';
    var max = Math.max.apply(null, rows.map(function (r) { return r[1]; })) || 1;
    return rows.map(function (r) { return '<div class="bar"><span class="l" style="' + (wide ? 'width:min(360px,55%)' : '') + '" title="' + E(r[0]) + '">' + E(r[0]) + '</span><span class="t"><i style="width:' + (r[1] / max * 100) + '%;background:' + (color || 'var(--accent,#c8a96e)') + '"></i></span><span class="c">' + r[1] + '</span></div>'; }).join('');
  }
  function count(list, fn) { var o = {}; list.forEach(function (x) { var k = fn(x); if (k == null) return; [].concat(k).forEach(function (kk) { o[kk] = (o[kk] || 0) + 1; }); }); return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; }); }

  function vOverview() {
    var okAtt = S.attempts.filter(function (a) { return a.ok; }), bad = S.attempts.filter(function (a) { return !a.ok; });
    var guests = {}; S.sessions.forEach(function (s) { guests[s.reservation_id] = 1; });
    var now = Date.now(), active = S.sessions.filter(function (s) { return !s.revoked && new Date(s.expires_at) > now; });
    var activeRes = {}; active.forEach(function (s) { activeRes[s.reservation_id] = 1; });
    var userMsgs = S.msgs.filter(function (m) { return m.role === 'user'; });
    var inst = S.pairs.filter(function (p) { return p.src === 'instant'; }).length, ai = S.pairs.filter(function (p) { return p.src === 'ai'; }).length, team = S.pairs.filter(function (p) { return p.src === 'team'; }).length;
    var tot = inst + ai + team, spend = S.pairs.reduce(function (a, p) { return a + p.cost; }, 0);
    var aiCalls = S.pairs.filter(function (p) { return p.meta.usage; }).length;
    var chatted = {}; userMsgs.forEach(function (m) { chatted[m.reservation_id] = 1; });
    var h = '<div class="kpis">' +
      kpi('Guests signed in', Object.keys(guests).length, Object.keys(activeRes).length + ' with an open guide now') +
      kpi('Failed sign-ins', bad.length, pct(bad.length, S.attempts.length) + ' of attempts') +
      kpi('Guest messages', userMsgs.length, Object.keys(chatted).length + ' guests used the chat') +
      kpi('Answered instantly', pct(inst, tot), inst + ' free replies from the guide') +
      kpi('Handed to the team', team, S.openCount + ' still open') +
      kpi('Est. AI cost', money(spend), aiCalls ? aiCalls + ' AI replies · ' + money(spend / aiCalls) + ' each' : 'no AI replies') + '</div>';
    h += '<div class="grid2"><div class="box"><h3>How replies were handled</h3>' +
      '<div class="bar"><span class="l">All replies (' + tot + ')</span><span class="t">' + (tot ? '<i style="width:' + inst / tot * 100 + '%;background:#5fae78"></i><i style="width:' + ai / tot * 100 + '%;background:#4fb3ab"></i><i style="width:' + team / tot * 100 + '%;background:#d4a843"></i>' : '') + '</span><span class="c"></span></div>' +
      '<div class="leg"><span><i style="background:#5fae78"></i>Instant from guide · ' + inst + '</span><span><i style="background:#4fb3ab"></i>AI · ' + ai + '</span><span><i style="background:#d4a843"></i>Team needed · ' + team + '</span></div>' +
      '<h3 style="margin-top:16px;">How guests signed in</h3>' + bars(count(okAtt, function (a) { var t = reasonLabel(a.reason).replace('Signed in with ', ''); return t.charAt(0).toUpperCase() + t.slice(1); }), 0, '#5fae78') +
      (bad.length ? '<h3 style="margin-top:16px;">Why sign-ins failed</h3>' + bars(count(bad, function (a) { return reasonLabel(a.reason); }), 1, '#e06b5a') : '') + '</div>';
    h += '<div class="box"><h3>What guests ask about</h3>' + bars(count(S.pairs, function (p) { return p.topics.map(topicLabel); }).slice(0, 12)) + '</div></div>';
    // per home
    var hs = {};
    function H(id) { return hs[id] = hs[id] || { id: id, guests: {}, msgs: 0, inst: 0, tot: 0, team: 0, gaps: 0, fails: 0, cost: 0 }; }
    S.sessions.forEach(function (s) { H(s.listing_id).guests[s.reservation_id] = 1; });
    userMsgs.forEach(function (m) { H(m.listing_id).msgs++; });
    S.pairs.forEach(function (p) { var x = H(p.m.listing_id); x.tot++; if (p.src === 'instant') x.inst++; if (p.src === 'team') x.team++; if (p.meta.gap) x.gaps++; x.cost += p.cost; });
    bad.forEach(function (a) { if (a.listing_id) H(a.listing_id).fails++; });
    var rows = Object.keys(hs).map(function (k) { return hs[k]; }).sort(function (a, b) { return Object.keys(b.guests).length - Object.keys(a.guests).length || b.msgs - a.msgs; });
    h += '<div class="box"><h3>By home</h3>' + (rows.length ? '<div class="tw"><table><tr><th>Home</th><th>Guests</th><th>Messages</th><th>Instant</th><th>Team needed</th><th>Missing from guide</th><th>Failed sign-ins</th><th>Est. AI cost</th></tr>' +
      rows.map(function (r) { return '<tr><td>' + E(home(r.id)) + '</td><td>' + Object.keys(r.guests).length + '</td><td>' + r.msgs + '</td><td>' + pct(r.inst, r.tot) + '</td><td>' + r.team + '</td><td>' + (r.gaps ? '<span class="pill p-gap">' + r.gaps + '</span>' : '0') + '</td><td>' + r.fails + '</td><td>' + money(r.cost) + '</td></tr>'; }).join('') + '</table></div>' : '<p class="empty">No guest activity in this period.</p>') + '</div>';
    return h;
  }
  function kpi(k, v, s) { return '<div class="kpi"><div class="k">' + E(k) + '</div><div class="v">' + E(v) + '</div><div class="s">' + E(s) + '</div></div>'; }

  function guestName(p) { return (p.session && p.session.guest_first_name) || 'Guest'; }
  function vAttention() {
    var list = S.attention.filter(function (p) { return S.showReviewed || !S.reviews[p.m.id]; });
    var gaps = count(S.attention.filter(function (p) { return p.meta.gap && !S.reviews[p.m.id]; }), function (p) { return home(p.m.listing_id) + ' — ' + p.meta.gap.toLowerCase(); });
    var h = '<p class="note">Chats the AI handed to your team, and questions the guide couldn’t answer. Add the missing info in the home’s <b>Guest Guide &amp; AI</b> tab. From then on the guide answers it instantly and for free. Then mark it here.</p>';
    if (gaps.length) h += '<div class="box" style="margin-bottom:14px;"><h3>Missing from the guide</h3>' + bars(gaps.slice(0, 15), 1, '#8a6fd6') + '</div>';
    h += '<div class="row" style="display:flex;gap:10px;align-items:center;margin-bottom:10px;"><label class="chk" style="font-size:12.5px;"><input type="checkbox" data-a="showrev"' + (S.showReviewed ? ' checked' : '') + '> Show reviewed</label></div>';
    if (!list.length) return h + '<p class="empty">' + (S.attention.length ? 'All caught up. Nothing open.' : 'Nothing needs attention in this period.') + '</p>';
    list.forEach(function (p) {
      var rv = S.reviews[p.m.id], meta = p.meta, urg = meta.urgency && meta.urgency !== 'none' ? meta.urgency : null;
      var prop = S.props.find(function (x) { return x.listing_id === p.m.listing_id; });
      h += '<div class="att' + (rv ? ' done' : '') + '"><div class="hd"><b>' + E(home(p.m.listing_id)) + '</b><span>· ' + E(guestName(p)) + '</span><span>· ' + E(when(p.m.created_at)) + '</span>' +
        (p.m.escalate ? '<span class="pill ' + (urg === 'urgent' || urg === 'emergency' ? 'p-' + urg : 'p-team') + '">' + (urg === 'emergency' ? 'EMERGENCY' : urg === 'urgent' ? 'Urgent' : 'Team needed') + '</span>' : '') +
        (meta.gap ? '<span class="pill p-gap">Missing: ' + E(meta.gap) + '</span>' : '') + (meta.error ? '<span class="pill p-fail">AI error</span>' : '') +
        (rv ? '<span class="pill p-ok">' + E({ resolved: 'Resolved', added_to_guide: 'Added to guide', ignored: 'Ignored' }[rv.status]) + (rv.reviewed_by ? ' · ' + E(String(rv.reviewed_by).split('@')[0]) : '') + '</span>' : '') + '</div>' +
        (p.u ? '<div class="q">“' + E(p.u.content) + '”</div>' : '') + '<div class="a">' + E(p.m.content) + '</div>' +
        (meta.summary ? '<div class="sum"><b>For the team:</b> ' + E(meta.summary) + '</div>' : '') + (rv && rv.note ? '<div class="sum"><b>Note:</b> ' + E(rv.note) + '</div>' : '') +
        '<div class="ac">' + (rv ? '<button class="b sm" data-a="reopen" data-id="' + p.m.id + '">Reopen</button>' :
          '<input type="text" maxlength="500" placeholder="Note (optional): what was done" data-note="' + p.m.id + '"><button class="b sm p" data-a="rev" data-s="resolved" data-id="' + p.m.id + '">Resolved</button>' +
          (meta.gap ? '<button class="b sm" data-a="rev" data-s="added_to_guide" data-id="' + p.m.id + '">Added to guide</button>' : '') +
          '<button class="b sm" data-a="rev" data-s="ignored" data-id="' + p.m.id + '">Ignore</button>') +
        '<button class="b sm" data-a="chat" data-k="' + E(p.key) + '">View chat</button>' + (prop ? '<button class="b sm" data-a="guide" data-p="' + E(prop.id) + '">Open home guide</button>' : '') + '</div></div>';
    });
    return h;
  }

  function vConvos() {
    var keys = Object.keys(S.byRes), sessByRes = {};
    S.sessions.forEach(function (s) { (sessByRes[s.reservation_id] = sessByRes[s.reservation_id] || []).push(s); });
    var ql = S.q.trim().toLowerCase();
    var convs = keys.map(function (k) {
      var ms = S.byRes[k], s = (sessByRes[k] || [])[0] || S.sessions.find(function (x) { return x.id === ms[0].session_id; }) || {};
      return { k: k, ms: ms, s: s, last: ms[ms.length - 1].created_at, lid: ms[0].listing_id };
    }).filter(function (c) {
      if (!ql) return true;
      return (home(c.lid) + ' ' + (c.s.guest_first_name || '') + ' ' + c.ms.map(function (m) { return m.content; }).join(' ')).toLowerCase().indexOf(ql) >= 0;
    }).sort(function (a, b) { return new Date(b.last) - new Date(a.last); });
    var h = '<div style="display:flex;gap:8px;margin-bottom:12px;"><input type="text" data-a="search" placeholder="Search guest, home or message…" value="' + E(S.q) + '" style="flex:1;max-width:420px;"></div>';
    if (!convs.length) return h + '<p class="empty">' + (ql ? 'No chats match.' : 'No guest chats in this period.') + '</p>';
    convs.forEach(function (c) {
      var u = c.ms.filter(function (m) { return m.role === 'user'; }).length, team = c.ms.some(function (m) { return m.escalate; });
      var isOpen = !!S.open[c.k];
      h += '<div class="conv" id="cv-' + E(c.k) + '"><div class="row" data-a="toggle" data-k="' + E(c.k) + '"><span class="nm">' + E(c.s.guest_first_name || 'Guest') + '</span><span class="mt">' + E(home(c.lid)) + (c.s.check_in ? ' · ' + E(day(c.s.check_in)) + '–' + E(day(c.s.check_out_date)) : '') + '</span><span class="sp"></span>' +
        (team ? '<span class="pill p-team">Team needed</span>' : '') + '<span class="mt">' + u + ' message' + (u === 1 ? '' : 's') + ' · ' + E(when(c.last)) + '</span><span class="mt">' + (isOpen ? '&#9650;' : '&#9660;') + '</span></div>';
      if (isOpen) {
        h += '<div class="thread">';
        c.ms.forEach(function (m) {
          if (m.role === 'user') { h += '<div class="bub u">' + E(m.content) + '<span class="tm">' + E(when(m.created_at)) + '</span></div>'; return; }
          var src = source(m), lab = { instant: 'Instant', ai: 'AI', team: 'Team needed' }[src];
          h += '<div class="bub a">' + E(m.content) + '<span class="tm"><span class="pill p-' + src + '">' + lab + '</span> ' + E(when(m.created_at)) + ((m.meta || {}).gap ? ' · <span class="pill p-gap">Missing: ' + E(m.meta.gap) + '</span>' : '') + '</span></div>';
        });
        h += '</div>';
      }
      h += '</div>';
    });
    return h;
  }

  function vSignins() {
    var bad = S.attempts.filter(function (a) { return !a.ok; });
    var byDev = {}; bad.forEach(function (a) { if (a.ip_hash) (byDev[a.ip_hash] = byDev[a.ip_hash] || []).push(a); });
    var rep = Object.keys(byDev).filter(function (k) { return byDev[k].length >= 3; }).map(function (k) { return { k: k, n: byDev[k].length, last: byDev[k][0].created_at, homes: count(byDev[k], function (a) { return home(a.listing_id); }).map(function (x) { return x[0]; }) }; }).sort(function (a, b) { return b.n - a.n; });
    var h = '<p class="note">Every attempt to open a guest guide. A “device” is an anonymous fingerprint of the connection (we never store IP addresses). A failed phone sign-in usually means the Guesty reservation has no phone number, or a different one. Those guests can use their booking code or email instead.</p>';
    if (rep.length) h += '<div class="box" style="margin-bottom:14px;"><h3>Repeated failures (3+ from one device)</h3><div class="tw"><table><tr><th>Device</th><th>Failed tries</th><th>Homes tried</th><th>Last try</th></tr>' +
      rep.map(function (r) { return '<tr><td><code>' + E(r.k.slice(0, 8)) + '</code></td><td>' + r.n + '</td><td>' + E(r.homes.join(', ')) + '</td><td>' + E(when(r.last)) + '</td></tr>'; }).join('') + '</table></div>' +
      '<p class="note" style="margin:8px 0 0;">One device trying several homes or many times can be someone guessing. Rate limits already block it after a few tries.</p></div>';
    var sess = S.sessions.slice(0, 200);
    h += '<div class="grid2"><div class="box"><h3>Guests who signed in</h3>' + (sess.length ? '<div class="tw"><table><tr><th>Guest</th><th>Home</th><th>Stay</th><th>How</th><th>Signed in</th><th>Status</th></tr>' +
      sess.map(function (s) {
        var st = s.revoked ? (s.revoked_reason === 'logout' || /log ?out/i.test(s.revoked_reason || '') ? 'Logged out' : 'Ended' + (s.revoked_reason ? ': ' + s.revoked_reason : '')) : new Date(s.expires_at) > new Date() ? 'Active' : 'Expired';
        return '<tr><td>' + E(s.guest_first_name || '—') + '</td><td>' + E(home(s.listing_id)) + '</td><td>' + E(day(s.check_in)) + '–' + E(day(s.check_out_date)) + '</td><td>' + E({ phone: 'Phone', code: 'Booking code', email: 'Email' }[s.method] || s.method || '—') + '</td><td>' + E(when(s.created_at)) + '</td><td><span class="pill ' + (st === 'Active' ? 'p-ok' : 'p-muted') + '">' + E(st) + '</span></td></tr>';
      }).join('') + '</table></div>' : '<p class="empty">No sign-ins in this period.</p>') + '</div>';
    h += '<div class="box"><h3>All attempts</h3>' + (S.attempts.length ? '<div class="tw"><table><tr><th>When</th><th>Home</th><th>Result</th><th>Device</th></tr>' +
      S.attempts.slice(0, 300).map(function (a) { return '<tr><td>' + E(when(a.created_at)) + '</td><td>' + E(home(a.listing_id)) + '</td><td><span class="pill ' + (a.ok ? 'p-ok' : 'p-fail') + '">' + (a.ok ? 'OK' : 'Failed') + '</span> ' + E(reasonLabel(a.reason)) + '</td><td><code>' + E(String(a.ip_hash || '').slice(0, 8)) + '</code></td></tr>'; }).join('') + '</table></div>' : '<p class="empty">No attempts in this period.</p>') + '</div></div>';
    return h;
  }

  function vPlaces() {
    if (!S.placesLoaded) return '<p class="empty">Loading places…</p>';
    var list = S.places.filter(function (p) { return !S.placeCat || p.category === S.placeCat; });
    var h = '<p class="note">These show in every guest guide’s <b>Things to Do</b> tab, and the AI recommends from them. “Every home” places show for all homes. “Nearby only” places show only for homes within 15 miles. A place with no map location gets one automatically the next time a guest opens their guide.</p>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;"><select data-a="pcat"><option value="">All categories (' + S.places.length + ')</option>' + CATS.map(function (c) { var n = S.places.filter(function (p) { return p.category === c; }).length; return '<option' + (S.placeCat === c ? ' selected' : '') + ' value="' + E(c) + '">' + E(c) + ' (' + n + ')</option>'; }).join('') + '</select><span style="flex:1"></span><button class="b p" data-a="pnew">+ Add a place</button></div>';
    if (S.editPlace && !S.editPlace.id) h += placeForm(S.editPlace);
    h += '<div class="box"><div class="tw"><table><tr><th>Place</th><th>Category</th><th>Shows at</th><th>Map</th><th></th></tr>';
    list.forEach(function (p) {
      if (S.editPlace && S.editPlace.id === p.id) { h += '<tr><td colspan="5">' + placeForm(S.editPlace) + '</td></tr>'; return; }
      h += '<tr class="' + (p.active === false ? 'off' : '') + '"><td><b>' + E(p.name) + '</b>' + (p.partner ? ' <span class="pill p-team">Partner</span>' : '') + (p.active === false ? ' <span class="pill p-muted">Hidden</span>' : '') + '<div style="font-size:12px;color:var(--text-muted,#999);margin-top:2px;">' + E(p.blurb) + '</div></td><td>' + E(p.category) + '</td><td>' + (p.source === 'website' ? 'Every home' : 'Nearby only') + '</td><td>' + (p.lat != null ? '&#10003;' : '<span class="pill p-muted">pending</span>') + '</td><td><button class="b sm" data-a="pedit" data-id="' + p.id + '">Edit</button></td></tr>';
    });
    return h + '</table></div>' + (list.length ? '' : '<p class="empty">No places in this category.</p>') + '</div>';
  }
  function placeForm(p) {
    return '<div class="box" id="pf" style="margin:6px 0 12px;border-color:var(--accent,#c8a96e);"><div class="pl">' +
      '<label>Name<input type="text" data-f="name" maxlength="120" value="' + E(p.name) + '"></label>' +
      '<label>Category<select data-f="category">' + CATS.map(function (c) { return '<option' + (c === p.category ? ' selected' : '') + '>' + E(c) + '</option>'; }).join('') + '</select></label>' +
      '<label class="w">Short description (1–2 sentences guests will read)<textarea data-f="blurb" maxlength="400">' + E(p.blurb) + '</textarea></label>' +
      '<label>Website<input type="text" data-f="url" maxlength="300" value="' + E(p.url) + '" placeholder="https://…"></label>' +
      '<label>Map search (for directions)<input type="text" data-f="maps_q" maxlength="200" value="' + E(p.maps_q) + '" placeholder="e.g. The Preacher’s Son, Bentonville AR"></label>' +
      '<label>Shows at<select data-f="source"><option value="website"' + (p.source === 'website' ? ' selected' : '') + '>Every home</option><option value="added"' + (p.source !== 'website' ? ' selected' : '') + '>Nearby homes only (15 mi)</option></select></label>' +
      '<label>Sort (lower = first)<input type="number" data-f="sort" value="' + E(p.sort == null ? 100 : p.sort) + '"></label>' +
      '<label class="chk"><input type="checkbox" data-f="partner"' + (p.partner ? ' checked' : '') + '> Our partner</label>' +
      '<label class="chk"><input type="checkbox" data-f="active"' + (p.active !== false ? ' checked' : '') + '> Show to guests</label>' +
      '</div><div style="display:flex;gap:8px;margin-top:12px;justify-content:space-between;"><div>' + (p.id ? '<button class="b d" data-a="pdel">Delete</button>' : '') + '</div><div style="display:flex;gap:8px;"><button class="b" data-a="pcancel">Cancel</button><button class="b p" data-a="psave">Save</button></div></div></div>';
  }

  // ── actions ──────────────────────────────────────────────────────────────
  async function me() { try { return (await db.auth.getUser()).data.user.email; } catch (e) { return null; } }
  async function refresh() { try { await load(); } catch (e) { toast('Couldn’t load the concierge data: ' + e.message, 'error'); } render(); badge(); }
  async function onClick(e) {
    var b = e.target.closest('[data-a]'); if (!b || !page().contains(b)) return;
    var a = b.getAttribute('data-a');
    if (a === 'days' || a === 'search' || a === 'pcat') return;
    if (a === 'reload') { S.loaded = false; render(); return refresh(); }
    if (a === 'view') { S.view = b.getAttribute('data-v'); render(); if (S.view === 'places' && !S.placesLoaded) { try { await loadPlaces(); S.placesLoaded = true; } catch (er) { toast('Couldn’t load places: ' + er.message, 'error'); } render(); } return; }
    if (a === 'showrev') { S.showReviewed = b.checked; return render(); }
    if (a === 'toggle') { var k = b.getAttribute('data-k'); S.open[k] = !S.open[k]; return render(); }
    if (a === 'chat') { var k2 = b.getAttribute('data-k'); S.view = 'convos'; S.q = ''; S.open = {}; S.open[k2] = true; render(); var c = document.getElementById('cv-' + k2); if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (a === 'guide') { var pid = b.getAttribute('data-p'); if (typeof showPage === 'function') showPage('properties'); if (typeof openPropertyDetail === 'function') { openPropertyDetail(isNaN(+pid) ? pid : +pid); setTimeout(function () { if (window.PropDeskGuestGuide) window.PropDeskGuestGuide.open(); }, 150); } return; }
    if (a === 'rev') {
      var id = +b.getAttribute('data-id'), note = (page().querySelector('[data-note="' + id + '"]') || {}).value || '';
      var row = { message_id: id, status: b.getAttribute('data-s'), note: note.trim() || null, reviewed_by: await me(), reviewed_at: new Date().toISOString() };
      var r = await db.from('concierge_reviews').upsert(row);
      if (r.error) return toast('Couldn’t save: ' + r.error.message, 'error');
      S.reviews[id] = row; derive(); render(); badge(); return;
    }
    if (a === 'reopen') { var id2 = +b.getAttribute('data-id'); var r2 = await db.from('concierge_reviews').delete().eq('message_id', id2); if (r2.error) return toast('Couldn’t reopen: ' + r2.error.message, 'error'); delete S.reviews[id2]; derive(); render(); badge(); return; }
    if (a === 'pnew') { S.editPlace = { name: '', category: S.placeCat || 'Eat', blurb: '', url: '', maps_q: '', source: 'added', sort: 100, partner: false, active: true }; return render(); }
    if (a === 'pedit') { var pl = S.places.find(function (x) { return String(x.id) === b.getAttribute('data-id'); }); S.editPlace = pl ? Object.assign({}, pl) : null; return render(); }
    if (a === 'pcancel') { S.editPlace = null; return render(); }
    if (a === 'psave') return savePlace();
    if (a === 'pdel') {
      if (!confirm('Delete “' + S.editPlace.name + '” from every guest guide? (To keep it but stop showing it, untick “Show to guests” instead.)')) return;
      var rd = await db.from('local_places').delete().eq('id', S.editPlace.id); if (rd.error) return toast('Delete failed: ' + rd.error.message, 'error');
      S.editPlace = null; await loadPlaces(); render(); return;
    }
  }
  async function savePlace() {
    var f = $('pf'), p = S.editPlace, get = function (k) { return f.querySelector('[data-f="' + k + '"]'); };
    var row = { name: get('name').value.trim(), category: get('category').value, blurb: get('blurb').value.trim(), url: get('url').value.trim() || null, maps_q: get('maps_q').value.trim() || null, source: get('source').value, sort: parseInt(get('sort').value, 10) || 100, partner: get('partner').checked, active: get('active').checked, updated_at: new Date().toISOString() };
    if (!row.name) return toast('Add a name.', 'error');
    if (!row.blurb) return toast('Add a short description.', 'error');
    if (row.url && !/^https?:\/\/[^\s]+$/i.test(row.url)) return toast('The website should start with https://', 'error');
    if (!row.maps_q) row.maps_q = row.name + ', AR';
    // the map search changed → clear the old pin so it's looked up again
    if (p.id && (row.maps_q !== p.maps_q)) { row.lat = null; row.lng = null; }
    var r = p.id ? await db.from('local_places').update(row).eq('id', p.id) : await db.from('local_places').insert(row);
    if (r.error) return toast('Save failed: ' + r.error.message, 'error');
    S.editPlace = null; toast('Saved. Guests see it next time they open the guide.', 'success'); await loadPlaces(); render();
  }
  function onChange(e) {
    var t = e.target, a = t.getAttribute('data-a');
    if (a === 'days') { S.days = +t.value; S.loaded = false; render(); refresh(); }
    if (a === 'pcat') { S.placeCat = t.value; S.editPlace = null; render(); }
  }
  var searchT = null;
  function onInput(e) {
    if (e.target.getAttribute('data-a') !== 'search') return;
    var v = e.target.value; clearTimeout(searchT);
    searchT = setTimeout(function () { S.q = v; render(); var i = page().querySelector('[data-a="search"]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 250);
  }

  // ── nav wiring ───────────────────────────────────────────────────────────
  function badge() {
    document.querySelectorAll('.cd-nav .n').forEach(function (n) { n.textContent = S.openCount ? S.openCount : ''; n.style.display = S.openCount ? '' : 'none'; });
  }
  function open(btn) {
    if (typeof showPage === 'function') showPage('concierge', btn);
    document.querySelectorAll('.cd-nav').forEach(function (b) { b.classList.add('active'); });
    if (typeof closeMobileNav === 'function') try { closeMobileNav(); } catch (e) {}
    window.scrollTo(0, 0);
    render(); refresh();
  }
  function navBtn(mobile) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'cd-nav';
    b.innerHTML = (mobile ? '&#128172; ' : '') + 'Concierge <span class="n" style="display:none;background:#e06b5a;color:#fff;border-radius:10px;font-size:10.5px;font-weight:700;padding:1px 6px;margin-left:4px;"></span>';
    b.addEventListener('click', function () { open(b); });
    return b;
  }
  var installed = false;
  async function install() {
    if (installed) return true;
    var nav = $('desktop-nav'); if (!nav || typeof db === 'undefined') return false;
    // staff only (RLS enforces this too). Not signed in yet / not staff → try again on sign-in.
    try { var r = await db.rpc('is_staff'); if (r.error || r.data !== true) return false; } catch (e) { return false; }
    if (installed) return true; installed = true;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var pg = document.createElement('div'); pg.className = 'page'; pg.id = 'page-concierge';
    var anchor = $('page-dashboard'); (anchor ? anchor.parentNode : document.body).insertBefore(pg, anchor ? anchor.nextSibling : null);
    pg.addEventListener('click', onClick); pg.addEventListener('change', onChange); pg.addEventListener('input', onInput);
    nav.appendChild(navBtn(false));
    var drawer = document.querySelector('.nav-drawer-panel');
    if (drawer) { var so = drawer.querySelector('.nav-drawer-signout'); drawer.insertBefore(navBtn(true), so || null); }
    // quiet badge count for the nav
    try { await load(); badge(); } catch (e) {}
    return true;
  }
  function boot() {
    var t = 0; (async function tick() { if (await install()) return; if (++t < 20) setTimeout(tick, 1500); })();
    try { db.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_IN') setTimeout(install, 500); }); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.PropDeskConcierge = { open: function () { var b = document.querySelector('.cd-nav'); if (b) open(b); } };
})();
