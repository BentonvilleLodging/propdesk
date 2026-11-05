// js/daily-brief.js — PropDesk Daily Brief
//
// Loaded by index.html (<script src="/js/daily-brief.js" defer>). Staff only.
// Pops up the first time each staff member opens PropDesk each day (and once more if a newer
// morning recap lands later that day). Also reachable from the "Today's Brief" button on the
// dashboard. No Claude calls here — content comes from:
//   • daily_recaps.brief   written by the 7:54 AM ET "BLC Chief of Staff Recap" task
//   • todo_suggestions     suggested to-dos (Listing Intelligence agent + recap). Nothing goes on
//                          the to-do list until someone clicks "Add".
//   • pricing_proposals / todos  live counts (pending approvals, overdue / due today)
// Uses the page globals `db`, `showToast`, and `loadAllData` (to refresh the to-do list).
(function () {
  'use strict';

  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function $(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
  function ctDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d || new Date()); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function money(v) { return '$' + Math.round(Number(v) || 0).toLocaleString('en-US'); }
  function niceDate(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
  function hash(s) { var h = 5381; s = String(s); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  var CATS = { maintenance: 1, admin: 1, tenant: 1, property: 1 };
  function cat(c) { c = String(c || '').toLowerCase(); return CATS[c] ? c : (c === 'listing' ? 'property' : 'maintenance'); }
  function pri(p) { p = String(p || '').toLowerCase(); return p === 'high' || p === 'low' ? p : 'medium'; }
  // Generic owners from AI suggestions aren't people — leave the assignee blank for staff to fill.
  function who(a) { return /^(blc team|owner|cleaning team|anyone)$/i.test(String(a || '').trim()) ? '' : (a || ''); }

  var S = { recap: null, sugg: [], counts: {}, user: null, open: false };

  var CSS = [
    '#db-ov{position:fixed;inset:0;z-index:1003;background:rgba(0,0,0,.72);display:none;align-items:flex-start;justify-content:center;padding:28px 14px;overflow-y:auto;backdrop-filter:blur(4px)}',
    '#db-ov.open{display:flex}',
    '#db-ov .db-box{background:var(--surface,#1a1a18);color:var(--text,#f0ede6);border:1px solid var(--border-light,#3d3d39);border-radius:14px;width:100%;max-width:680px;box-shadow:0 8px 48px rgba(0,0,0,.6);font-family:"DM Sans",sans-serif}',
    '#db-ov .db-hd{padding:20px 22px 14px;border-bottom:1px solid var(--border,#333);display:flex;gap:12px;align-items:flex-start}',
    '#db-ov .db-hd h2{margin:0;font-family:"Playfair Display",serif;font-size:21px}',
    '#db-ov .db-sub{font-size:12px;color:var(--text-muted,#888);margin-top:3px}',
    '#db-ov .db-x{margin-left:auto;background:none;border:none;color:var(--text-muted,#888);font-size:20px;cursor:pointer;padding:2px 6px}',
    '#db-ov .db-head{padding:14px 22px 0;font-size:15px;line-height:1.5;font-weight:600;color:var(--accent,#c8a96e)}',
    '#db-ov .db-sec{padding:14px 22px 4px}',
    '#db-ov .db-sec h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--text-muted,#888);font-weight:700}',
    '#db-ov ul.db-know{margin:0;padding-left:18px;font-size:13.5px;line-height:1.55}',
    '#db-ov ul.db-know li{margin-bottom:4px}',
    '#db-ov .db-item{display:flex;gap:10px;align-items:flex-start;background:var(--surface2,#242422);border:1px solid var(--border,#333);border-radius:10px;padding:10px 12px;margin-bottom:8px}',
    '#db-ov .db-item .t{font-size:13.5px;font-weight:600;line-height:1.4}',
    '#db-ov .db-item .d{font-size:12.5px;color:var(--text-muted,#888);line-height:1.45;margin-top:2px}',
    '#db-ov .db-item .m{font-size:11px;color:var(--text-muted,#888);margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '#db-ov .db-tag{font-size:10px;padding:2px 7px;border-radius:10px;background:var(--surface3,#2e2e2b);color:var(--text-muted,#888)}',
    '#db-ov .db-tag.high{background:#e06b5a22;color:#e06b5a}#db-ov .db-tag.medium{background:#d4a84322;color:#d4a843}#db-ov .db-tag.low{background:#7ab87a22;color:#7ab87a}',
    '#db-ov .db-tag.usd{background:#7ab87a22;color:#7ab87a;font-weight:700}',
    '#db-ov .db-btns{margin-left:auto;display:flex;gap:6px;flex-shrink:0;align-items:center}',
    '#db-ov .db-btn{font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:6px 12px;cursor:pointer;border:1px solid var(--border,#333);background:var(--surface3,#2e2e2b);color:var(--text,#f0ede6)}',
    '#db-ov .db-btn.add{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e)}',
    '#db-ov .db-btn.ghost{background:none;color:var(--text-muted,#888)}',
    '#db-ov .db-btn:disabled{opacity:.5;cursor:default}',
    '#db-ov .db-form{display:none;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center}',
    '#db-ov .db-item.editing .db-form{display:flex}',
    '#db-ov .db-form input{background:var(--bg,#0f0f0e);border:1px solid var(--border,#333);color:var(--text,#f0ede6);border-radius:6px;padding:6px 8px;font:inherit;font-size:12px}',
    '#db-ov .db-done{font-size:12px;color:#7ab87a;font-weight:600}',
    '#db-ov .db-empty{font-size:13px;color:var(--text-muted,#888);padding:4px 0 8px}',
    '#db-ov .db-ft{padding:12px 22px 18px;display:flex;gap:8px;justify-content:space-between;align-items:center;border-top:1px solid var(--border,#333);margin-top:10px}',
    '#db-ov .db-ft .s{font-size:11px;color:var(--text-muted,#888)}',
    '.db-launch{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;margin:0 0 16px;padding:12px 16px;border-radius:10px;border:1px solid var(--border,#333);background:var(--surface,#1a1a18);color:var(--text,#f0ede6);font:inherit;font-size:13px;cursor:pointer;text-align:left}',
    '.db-launch:hover{border-color:var(--accent,#c8a96e)}',
    '.db-launch b{color:var(--accent,#c8a96e)}',
    '.db-launch .n{margin-left:auto;font-size:11px;color:var(--text-muted,#888)}',
    '@media (max-width:600px){#db-ov{padding:0}#db-ov .db-box{border-radius:0;min-height:100%}#db-ov .db-item{flex-wrap:wrap}#db-ov .db-btns{margin-left:0;width:100%;justify-content:flex-end}}',
  ].join('\n');

  // ── data ──────────────────────────────────────────────────────────────
  async function isStaff() {
    try {
      var s = (await db.auth.getSession()).data.session; if (!s) return false;
      S.user = s.user;
      var r = await db.rpc('my_team_role'); return !r.error && r.data === 'staff';
    } catch (e) { return false; }
  }

  async function load() {
    var today = ctDate();
    var res = await Promise.all([
      db.from('daily_recaps').select('recap_date,brief,actions,kpis').order('recap_date', { ascending: false }).limit(1),
      db.from('pricing_proposals').select('id', { count: 'exact', head: true }).eq('status', 'pending').gte('stay_date', today),
      db.from('todos').select('id,due_date', { count: 'exact' }).eq('completed', false).lte('due_date', today),
    ]);
    S.recap = (res[0].data && res[0].data[0]) || null;
    S.counts = { approvals: res[1].count || 0, dueTodos: (res[2].data || []).length, overdue: (res[2].data || []).filter(function (t) { return t.due_date < today; }).length };
    await syncRecapTodos();
    var sg = await db.from('todo_suggestions').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(40);
    var rank = { high: 0, medium: 1, low: 2 };
    S.sugg = (sg.data || []).sort(function (a, b) { return (rank[pri(a.priority)] - rank[pri(b.priority)]) || (a.source === 'recap' ? -1 : 0) - (b.source === 'recap' ? -1 : 0); });
  }

  // Recap to-dos become suggestions (once each) so Add / Dismiss is tracked for the whole team.
  async function syncRecapTodos() {
    var b = S.recap && S.recap.brief; if (!b || !Array.isArray(b.todos) || !b.todos.length) return;
    var rows = b.todos.filter(function (t) { return t && t.title; }).slice(0, 8).map(function (t) {
      return { source: 'recap', source_ref: 'recap:' + hash(String(t.property || '') + '|' + String(t.title).toLowerCase()), title: String(t.title).slice(0, 200),
        description: String(t.detail || '').slice(0, 600) || null, property: t.property || null, category: 'maintenance', priority: pri(t.priority),
        assigned_to: t.assigned_to || null, due_in_days: Math.max(0, Math.min(60, parseInt(t.due_in_days, 10) || 3)) };
    });
    try { await db.from('todo_suggestions').upsert(rows, { onConflict: 'source_ref', ignoreDuplicates: true }); } catch (e) {}
  }

  async function markSeen() {
    if (!S.user) return;
    try { await db.from('daily_brief_seen').upsert({ user_id: S.user.id, brief_date: ctDate(), recap_date: S.recap ? S.recap.recap_date : null, seen_at: new Date().toISOString() }, { onConflict: 'user_id,brief_date' }); } catch (e) {}
  }

  async function shouldAutoShow() {
    var r = await db.from('daily_brief_seen').select('recap_date').eq('brief_date', ctDate()).maybeSingle();
    if (r.error) return false;            // table missing / not allowed → never nag
    if (!r.data) return true;             // first open today
    return !!(S.recap && S.recap.recap_date && (!r.data.recap_date || r.data.recap_date < S.recap.recap_date)); // newer recap since
  }

  // ── render ────────────────────────────────────────────────────────────
  function actionsList() {
    var b = (S.recap && S.recap.brief) || {};
    var acts = Array.isArray(b.actions) && b.actions.length ? b.actions
      : ((S.recap && Array.isArray(S.recap.actions)) ? S.recap.actions.map(function (a) { return { title: a.action || a.title, impact_usd: a.est_mgmt_impact || a.impact_usd }; }) : []);
    return acts.filter(function (a) { return a && a.title; }).slice(0, 5);
  }
  function knowList() {
    var b = (S.recap && S.recap.brief) || {}, k = S.recap && S.recap.kpis;
    if (Array.isArray(b.know) && b.know.length) return b.know.slice(0, 8);
    if (!k) return [];
    var out = [];
    if (k.est_mgmt_otb_30 != null) out.push('On the books next 30 days: ' + money(k.est_mgmt_otb_30) + ' est. management revenue.');
    if (k.occ_30 != null && k.mkt_occ_30 != null) out.push('Occupancy next 30 days: ' + k.occ_30 + '% vs market ' + k.mkt_occ_30 + '%.');
    if (k.new_bookings != null) out.push('New bookings yesterday: ' + k.new_bookings + (k.est_mgmt_new != null ? ' (' + money(k.est_mgmt_new) + ' est. mgmt)' : '') + '.');
    if (k.guesty_ingest_ok === false) out.push('Guesty booking data didn’t update this morning — numbers may be stale.');
    return out;
  }

  function render() {
    var today = ctDate(), rd = S.recap && S.recap.recap_date, b = (S.recap && S.recap.brief) || {};
    var stale = rd && rd < today;
    var live = [];
    if (S.counts.approvals) live.push({ title: S.counts.approvals + ' pricing change' + (S.counts.approvals > 1 ? 's' : '') + ' waiting for approval', detail: 'Review them on the Approvals tab in Listing Intelligence.' });
    if (S.counts.dueTodos) live.push({ title: S.counts.dueTodos + ' to-do' + (S.counts.dueTodos > 1 ? 's' : '') + ' due today' + (S.counts.overdue ? ' (' + S.counts.overdue + ' overdue)' : ''), detail: 'Open the to-do list on the dashboard.' });
    var acts = actionsList(), know = knowList();

    var html = '<div class="db-box" role="dialog" aria-label="Daily brief">' +
      '<div class="db-hd"><div><h2>&#9728; Daily Brief</h2><div class="db-sub">' + E(niceDate(today)) +
      (rd ? ' · from the ' + E(stale ? niceDate(rd) : 'morning') + ' recap' : '') + '</div></div><button class="db-x" data-a="close" aria-label="Close">&times;</button></div>' +
      (b.headline ? '<div class="db-head">' + E(b.headline) + '</div>' : '') +
      (stale ? '<div class="db-sec" style="padding-bottom:0;"><div class="db-empty">Today’s recap isn’t in yet (it runs around 6:55 AM Central) — this is the most recent one.</div></div>' : '') +
      '<div class="db-sec"><h3>Things to know</h3>' + (know.length ? '<ul class="db-know">' + know.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul>' : '<div class="db-empty">Nothing new yet.</div>') + '</div>' +
      '<div class="db-sec"><h3>Important action items</h3>' +
      (acts.length || live.length ? acts.map(function (a, i) {
        return '<div class="db-item" data-act="' + i + '"><div style="flex:1;min-width:0;"><div class="t">' + E(a.title) + '</div>' + (a.detail ? '<div class="d">' + E(a.detail) + '</div>' : '') +
          '<div class="m">' + (a.impact_usd ? '<span class="db-tag usd">~' + money(a.impact_usd) + ' est. mgmt</span>' : '') + (a.property ? '<span class="db-tag">' + E(a.property) + '</span>' : '') + '</div>' + formHtml('', 1) + '</div>' +
          '<div class="db-btns"><button class="db-btn ghost" data-a="addact">+ To-do</button></div></div>';
      }).join('') + live.map(function (a) { return '<div class="db-item"><div style="flex:1;"><div class="t">' + E(a.title) + '</div><div class="d">' + E(a.detail) + '</div></div></div>'; }).join('')
        : '<div class="db-empty">No action items today.</div>') + '</div>' +
      '<div class="db-sec"><h3>Suggested to-dos</h3>' +
      (S.sugg.length ? S.sugg.map(function (s) {
        return '<div class="db-item" data-sid="' + E(s.id) + '"><div style="flex:1;min-width:0;"><div class="t">' + E(s.title) + '</div>' +
          (s.description ? '<div class="d">' + E(String(s.description).replace(/\s*·\s*From the Monday listing analysis\s*$/i, '').slice(0, 220)) + '</div>' : '') +
          '<div class="m"><span class="db-tag ' + pri(s.priority) + '">' + E(pri(s.priority)) + '</span>' + (s.property ? '<span class="db-tag">' + E(s.property) + '</span>' : '') +
          (s.assigned_to ? '<span class="db-tag">' + E(s.assigned_to) + '</span>' : '') + '<span>' + (s.source === 'recap' ? 'Daily recap' : 'Listing Intelligence') + '</span></div>' +
          formHtml(who(s.assigned_to), s.due_in_days) + '</div>' +
          '<div class="db-btns"><button class="db-btn ghost" data-a="dismiss" title="Dismiss for the whole team">Dismiss</button><button class="db-btn add" data-a="add">Add</button></div></div>';
      }).join('') : '<div class="db-empty">No suggested to-dos right now.</div>') + '</div>' +
      '<div class="db-ft"><span class="s">Suggestions only go on the to-do list when you click Add.</span><button class="db-btn add" data-a="close">Got it</button></div>' +
      '</div>';
    $('db-ov').innerHTML = html;
  }
  function formHtml(assignee, dueIn) {
    var due = addDays(ctDate(), Math.max(0, Math.min(60, parseInt(dueIn, 10) || 3)));
    return '<div class="db-form"><input data-f="who" placeholder="Assign to (optional)" maxlength="60" value="' + E(assignee) + '" style="flex:1;min-width:130px;">' +
      '<input data-f="due" type="date" value="' + E(due) + '"><button class="db-btn add" data-a="confirm">Add to list</button><button class="db-btn ghost" data-a="cancel">Cancel</button></div>';
  }

  // ── actions ───────────────────────────────────────────────────────────
  async function addTodo(item, data) {
    var f = item.querySelector('.db-form');
    var payload = {
      title: String(data.title).slice(0, 200), description: data.description || null, property: data.property || null,
      category: cat(data.category), priority: pri(data.priority), assigned_to: f.querySelector('[data-f="who"]').value.trim() || null,
      due_date: f.querySelector('[data-f="due"]').value || null, completed: false,
    };
    var ins = await db.from('todos').insert(payload).select('id').single();
    if (ins.error) { toast('Couldn’t add the to-do: ' + ins.error.message, 'error'); return false; }
    if (data.sid) await db.from('todo_suggestions').update({ status: 'added', todo_id: ins.data.id, decided_by: S.user && S.user.email, decided_at: new Date().toISOString() }).eq('id', data.sid);
    item.querySelector('.db-btns').innerHTML = '<span class="db-done">&#10003; Added</span>';
    item.classList.remove('editing');
    if (typeof loadAllData === 'function') { try { loadAllData(); } catch (e) {} }
    toast('Added to your to-do list.', 'success');
    return true;
  }

  async function onClick(e) {
    if (e.target === $('db-ov')) return close();
    var b = e.target.closest('[data-a]'); if (!b) return;
    var a = b.getAttribute('data-a'), item = b.closest('.db-item');
    if (a === 'close') return close();
    if (a === 'add' || a === 'addact') { item.classList.add('editing'); var w = item.querySelector('[data-f="who"]'); if (w) w.focus(); return; }
    if (a === 'cancel') { item.classList.remove('editing'); return; }
    if (a === 'dismiss') {
      b.disabled = true;
      var r = await db.from('todo_suggestions').update({ status: 'dismissed', decided_by: S.user && S.user.email, decided_at: new Date().toISOString() }).eq('id', Number(item.getAttribute('data-sid')));
      if (r.error) { b.disabled = false; toast('Couldn’t dismiss: ' + r.error.message, 'error'); return; }
      item.style.opacity = '.45'; item.querySelector('.db-btns').innerHTML = '<span class="db-empty" style="padding:0;">Dismissed</span>';
      return;
    }
    if (a === 'confirm') {
      b.disabled = true;
      var data;
      if (item.hasAttribute('data-sid')) {
        var s = S.sugg.find(function (x) { return String(x.id) === item.getAttribute('data-sid'); });
        data = { sid: s.id, title: s.title, description: s.description, property: s.property, category: s.category, priority: s.priority };
      } else {
        var act = actionsList()[Number(item.getAttribute('data-act'))];
        data = { title: act.title, description: [act.detail, act.impact_usd ? '~' + money(act.impact_usd) + ' est. mgmt impact' : null, 'From the daily brief'].filter(Boolean).join(' · '), property: act.property, category: 'admin', priority: 'high' };
      }
      if (!(await addTodo(item, data))) b.disabled = false;
    }
  }

  // ── open / close ──────────────────────────────────────────────────────
  function ensureDom() {
    if ($('db-ov')) return;
    var st = document.createElement('style'); st.id = 'db-css'; st.textContent = CSS; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.id = 'db-ov'; document.body.appendChild(ov);
    ov.addEventListener('click', onClick);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) close(); });
  }
  async function open(auto) {
    ensureDom();
    try { await load(); } catch (e) { if (!auto) toast('Couldn’t load the brief.', 'error'); return; }
    if (auto && !(await shouldAutoShow())) return;
    render();
    $('db-ov').classList.add('open'); S.open = true;
    markSeen();
    updateLauncher();
  }
  function close() { var o = $('db-ov'); if (o) o.classList.remove('open'); S.open = false; }

  function updateLauncher() {
    var n = document.querySelector('.db-launch .n'); if (!n) return;
    var c = S.sugg.length; n.textContent = c ? c + ' suggested to-do' + (c > 1 ? 's' : '') : '';
  }
  function addLauncher() {
    var main = document.querySelector('#page-dashboard main');
    if (!main || main.querySelector('.db-launch')) return !!main;
    ensureDom();
    var btn = document.createElement('button');
    btn.className = 'db-launch'; btn.type = 'button';
    btn.innerHTML = '<span>&#9728;</span><span><b>Today’s Brief</b> — things to know, action items and suggested to-dos</span><span class="n"></span>';
    btn.addEventListener('click', function () { open(false); });
    main.insertBefore(btn, main.firstChild);
    return true;
  }

  // ── boot: wait until the staff app is showing, then auto-open once per day ──
  var started = false;
  async function tryStart() {
    if (started) return;
    var shell = $('app-shell');
    if (!shell || shell.style.display !== 'block') return;
    started = true;
    if (!(await isStaff())) { started = false; return; }
    addLauncher();
    setTimeout(function () { open(true); }, 900); // let the dashboard paint first
  }
  function boot() {
    if (typeof db === 'undefined') return;
    var iv = setInterval(function () { tryStart(); if (started) clearInterval(iv); }, 1000);
    try { db.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') { started = false; close(); var l = document.querySelector('.db-launch'); if (l) l.remove(); var iv2 = setInterval(function () { tryStart(); if (started) clearInterval(iv2); }, 1000); } }); } catch (e) {}
    // New day while the app stays open (e.g. phone left on overnight): re-check on return.
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && started && !S.open) open(true); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.PropDeskBrief = { open: function () { open(false); } };
})();
