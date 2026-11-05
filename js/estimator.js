// js/estimator.js — PropDesk "Create an Estimate" (AI estimator)
//
// Loaded by index.html (<script src="/js/estimator.js" defer>). Self-contained: adds a fourth
// card to the Invoicing page and a full-screen estimator. Uses the page's existing globals:
// `db` (Supabase client), `authFetch`, `showToast`.
//
//  • Type or dictate (Web Speech API) the project. Claude is called ONLY when the user clicks
//    "Generate Estimate" (server: netlify/functions/estimate-ai-background.js, 10/day cap).
//  • Claude returns internal COSTS; prices default to the 30% margin floor. Everything is
//    editable in the preview. Internal cost / margin is never exported or emailed.
//  • Pricing mirrors netlify/lib/estimate-pricing.js — keep the two in sync:
//      overhead 10% of subtotal · sales tax 7.2% of (subtotal + overhead)
//      margin = (subtotal − cost) ÷ (subtotal + overhead) ≥ 30%  ⇒ price ≥ cost ÷ 0.67
(function () {
  'use strict';

  var OVERHEAD = 0.10, TAX = 0.072, MIN_MARGIN = 0.30, FLOOR = 1 - MIN_MARGIN * (1 + OVERHEAD);
  var CATS = ['Labor', 'Materials', 'Equipment', 'Subcontractor', 'Disposal', 'Permits & Fees', 'Other'];

  // ── helpers ───────────────────────────────────────────────────────────
  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function NL(s) { return E(s).replace(/\n/g, '<br>'); }
  function n(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }
  function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
  function money(v) { return '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v) { return (Math.round(v * 1000) / 10).toFixed(1) + '%'; }
  function qtyFmt(v) { var x = Number(v) || 0; return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); }
  function priceForCost(c) { c = n(c); if (c <= 0) return 0; var p = c / FLOOR; return p >= 20 ? Math.ceil(p) : Math.ceil(p * 100) / 100; }
  function totals(lines) {
    var sub = 0, cost = 0;
    (lines || []).forEach(function (l) { sub += r2(n(l.qty) * n(l.unit_price)); cost += n(l.qty) * n(l.unit_cost); });
    sub = r2(sub); cost = r2(cost);
    var oh = r2(sub * OVERHEAD), tax = r2((sub + oh) * TAX), rev = sub + oh;
    var m = rev > 0 ? (sub - cost) / rev : 0;
    return { subtotal: sub, overhead: oh, tax: tax, total: r2(sub + oh + tax), cost: cost, margin: Math.round(m * 10000) / 10000, meets_floor: rev > 0 && m >= MIN_MARGIN - 0.00005 };
  }
  function lineMargin(l) { var p = n(l.unit_price); return p > 0 ? (p - n(l.unit_cost)) / (p * (1 + OVERHEAD)) : 0; }
  function toast(msg, type) { if (typeof showToast === 'function') showToast(msg, type); else alert(msg); }
  function $(id) { return document.getElementById(id); }
  function fmtDate(d) { return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }

  // ── state ─────────────────────────────────────────────────────────────
  var S = { est: null, doc: null, biz: null, showInternal: true, saving: null, pollTimer: null, rec: null, listening: false, lineSeq: 1 };

  // ── styles ────────────────────────────────────────────────────────────
  var CSS = [
    '.inv-add-card-estimate::before{background:#3fa7a0}',
    '#est-ov{position:fixed;inset:0;z-index:1001;background:rgba(0,0,0,.78);display:none;backdrop-filter:blur(4px)}',
    '#est-ov.open{display:flex}',
    '#est-ov .est-shell{background:var(--bg,#0f0f0e);color:var(--text,#f0ede6);width:100%;height:100%;display:flex;flex-direction:column;font-family:"DM Sans",sans-serif}',
    '#est-ov .est-top{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--border,#333);background:var(--surface,#1a1a18);flex-wrap:wrap}',
    '#est-ov .est-top h2{font-family:"Playfair Display",serif;font-size:18px;margin:0;flex:1;min-width:160px}',
    '#est-ov .est-num{font-family:"DM Mono",monospace;font-size:12px;color:var(--text-muted,#888)}',
    '#est-ov .est-body{flex:1;display:grid;grid-template-columns:minmax(300px,380px) 1fr;min-height:0}',
    '#est-ov .est-left{border-right:1px solid var(--border,#333);padding:16px 18px;overflow-y:auto;background:var(--surface,#1a1a18)}',
    '#est-ov .est-right{overflow-y:auto;padding:18px;min-width:0}',
    '#est-ov label{display:block;font-size:11px;color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px}',
    '#est-ov input,#est-ov textarea,#est-ov select{width:100%;box-sizing:border-box;background:var(--surface2,#242422);border:1px solid var(--border,#333);color:var(--text,#f0ede6);border-radius:6px;padding:8px 10px;font:inherit;font-size:13px}',
    '#est-ov textarea{resize:vertical}',
    '#est-ov .est-desc{min-height:170px}',
    '#est-ov .est-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '#est-ov .est-mic{display:flex;align-items:center;gap:8px;margin-top:8px}',
    '#est-ov .est-mic button{white-space:nowrap}',
    '#est-ov .est-mic .live{color:#e06b5a;font-size:12px;animation:estpulse 1.2s infinite}',
    '@keyframes estpulse{50%{opacity:.4}}',
    '#est-ov .est-interim{font-size:12px;color:var(--text-muted,#888);font-style:italic;min-height:16px;margin-top:4px}',
    '#est-ov .est-gen{width:100%;margin-top:14px;padding:12px;font-size:14px}',
    '#est-ov .est-hint{font-size:11px;color:var(--text-muted,#888);margin-top:6px;line-height:1.45}',
    '#est-ov .est-status{margin-top:12px;font-size:13px;line-height:1.45}',
    '#est-ov .est-spin{display:inline-block;width:14px;height:14px;border:2px solid var(--accent,#c8a96e);border-right-color:transparent;border-radius:50%;animation:estspin .8s linear infinite;vertical-align:-2px;margin-right:6px}',
    '@keyframes estspin{to{transform:rotate(360deg)}}',
    '#est-ov .est-empty{color:var(--text-muted,#888);text-align:center;padding:60px 20px;font-size:14px;line-height:1.6}',
    '#est-ov .est-internal{background:#1e2a29;border:1px solid #2f4a47;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px}',
    '#est-ov .est-internal .hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}',
    '#est-ov .est-internal .tag{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#7fc7c0;font-weight:700}',
    '#est-ov .est-kpis{display:flex;gap:18px;flex-wrap:wrap}',
    '#est-ov .est-kpis div{font-size:12px;color:var(--text-muted,#888)}',
    '#est-ov .est-kpis b{display:block;font-size:16px;color:var(--text,#f0ede6)}',
    '#est-ov .ok{color:#7ab87a!important}#est-ov .bad{color:#e06b5a!important}',
    '#est-ov .est-q{margin:8px 0 0;padding-left:18px;color:#bcd;font-size:12px;line-height:1.5}',
    '#est-ov .est-paper{background:#fff;color:#1d1b18;border-radius:10px;padding:26px 24px;max-width:900px;margin:0 auto;box-shadow:0 8px 30px rgba(0,0,0,.4)}',
    '#est-ov .est-paper input,#est-ov .est-paper textarea,#est-ov .est-paper select{background:transparent;border:1px solid transparent;color:#1d1b18;padding:4px 6px;border-radius:4px}',
    '#est-ov .est-paper input:hover,#est-ov .est-paper textarea:hover{border-color:#e2ddd2}',
    '#est-ov .est-paper input:focus,#est-ov .est-paper textarea:focus,#est-ov .est-paper select:focus{border-color:#c8a96e;outline:none;background:#fffdf7}',
    '#est-ov .est-ph{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}',
    '#est-ov .est-biz{font-size:12px;color:#555;line-height:1.5}',
    '#est-ov .est-biz b{font-size:19px;color:#1d1b18;display:block}',
    '#est-ov .est-biz img{max-height:52px;max-width:170px;display:block;margin-bottom:6px}',
    '#est-ov .est-meta{text-align:right;font-size:12px;color:#555;line-height:1.6}',
    '#est-ov .est-meta .t{font-size:22px;font-weight:700;color:#a8893f;letter-spacing:1px}',
    '#est-ov .est-for{margin-top:16px;background:#f8f6f2;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5}',
    '#est-ov .est-for .k{font-size:10px;color:#8a857a;text-transform:uppercase;letter-spacing:.08em}',
    '#est-ov .est-title{font-size:17px!important;font-weight:700;margin-top:14px}',
    '#est-ov .est-tablewrap{overflow-x:auto;margin-top:14px}',
    '#est-ov table.est-lines{width:100%;border-collapse:collapse;font-size:13px;min-width:640px}',
    '#est-ov table.est-lines th{background:#1d1b18;color:#fff;padding:8px 6px;text-align:left;font-weight:600;font-size:12px}',
    '#est-ov table.est-lines th.r,#est-ov table.est-lines td.r{text-align:right}',
    '#est-ov table.est-lines th.int{background:#2f4a47}',
    '#est-ov table.est-lines td{border-bottom:1px solid #ece8df;padding:3px 2px;vertical-align:top}',
    '#est-ov table.est-lines td.int{background:#eef6f5}',
    '#est-ov table.est-lines td.amt{padding:8px 6px;white-space:nowrap;font-weight:600}',
    '#est-ov table.est-lines textarea{min-height:34px;font-size:13px}',
    '#est-ov table.est-lines input.num{text-align:right;width:84px}',
    '#est-ov table.est-lines input.unit{width:62px}',
    '#est-ov table.est-lines select{font-size:11px;color:#8a857a;width:120px;padding:2px 4px}',
    '#est-ov .lm{font-size:11px;padding:8px 4px;white-space:nowrap}',
    '#est-ov .x{background:none;border:none;color:#b9b2a4;cursor:pointer;font-size:16px;padding:6px}',
    '#est-ov .x:hover{color:#e06b5a}',
    '#est-ov .floorbtn{background:none;border:1px solid #7fc7c0;color:#2f6f69;border-radius:4px;font-size:10px;cursor:pointer;padding:1px 4px;margin-left:4px}',
    '#est-ov .est-addline{margin-top:8px;background:none;border:1px dashed #c8c0b0;color:#8a857a;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}',
    '#est-ov .est-tot{margin:12px 0 0 auto;font-size:13px;min-width:260px;border-collapse:collapse}',
    '#est-ov .est-tot td{padding:4px 8px}#est-ov .est-tot td:last-child{text-align:right}',
    '#est-ov .est-tot tr.g td{font-weight:700;font-size:15px;border-top:2px solid #1d1b18;padding-top:8px}',
    '#est-ov .est-sec{margin-top:14px}',
    '#est-ov .est-sec .k{font-weight:700;font-size:13px;margin:0 0 2px 6px}',
    '#est-ov .est-sec .h{font-size:11px;color:#8a857a;margin-left:6px}',
    '#est-ov .est-terms{font-size:11px;color:#8a857a;margin-top:18px;border-top:1px solid #ece8df;padding-top:10px;line-height:1.5}',
    '#est-ov .est-actions{position:sticky;bottom:-18px;z-index:2;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:12px 14px;max-width:900px;margin:14px auto 0;background:var(--bg,#0f0f0e);border-top:1px solid var(--border,#333);border-radius:10px 10px 0 0}',
    '#est-ov .est-pop{position:fixed;inset:0;z-index:1002;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}',
    '#est-ov .est-pop .bx{background:var(--surface,#1a1a18);border:1px solid var(--border-light,#3d3d39);border-radius:12px;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;padding:18px 20px}',
    '#est-ov .est-pop h3{margin:0 0 6px;font-family:"Playfair Display",serif;font-size:17px}',
    '#est-ov .est-pop .ft{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}',
    '#est-ov .est-rec{width:100%;border-collapse:collapse;font-size:13px}',
    '#est-ov .est-rec td{padding:8px 6px;border-bottom:1px solid var(--border,#333);cursor:pointer}',
    '#est-ov .est-rec tr:hover td{background:var(--surface2,#242422)}',
    '#est-ov .pill{font-size:10px;padding:2px 7px;border-radius:10px;background:var(--surface3,#2e2e2b);color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.05em}',
    '#est-ov .pill.sent{background:#7ab87a22;color:#7ab87a}#est-ov .pill.ready{background:#c8a96e22;color:#c8a96e}#est-ov .pill.error{background:#e06b5a22;color:#e06b5a}',
    '@media (max-width:860px){#est-ov .est-body{grid-template-columns:1fr;overflow-y:auto}#est-ov .est-left,#est-ov .est-right{overflow:visible;border-right:none}#est-ov .est-paper{padding:18px 14px}#est-ov .est-top{padding:10px 12px}#est-ov .est-actions{position:static;border-radius:10px}}',
  ].join('\n');

  // ── mount ─────────────────────────────────────────────────────────────
  function addCard() {
    var wrap = document.querySelector('#page-invoicing .inv-action-cards');
    if (!wrap || wrap.querySelector('.inv-add-card-estimate')) return !!wrap;
    var card = document.createElement('div');
    card.className = 'inv-add-card inv-add-card-estimate';
    card.innerHTML = '<div class="inv-add-icon" style="background:rgba(63,167,160,.14);color:#3fa7a0;">&#9998;</div>' +
      '<div class="inv-add-info"><div class="inv-add-title">Create an Estimate</div>' +
      '<div class="inv-add-desc">Describe or dictate a project — AI drafts line items you can adjust, export or email.</div></div>';
    card.addEventListener('click', function () { openEstimator(); });
    wrap.appendChild(card);
    return true;
  }

  function buildOverlay() {
    if ($('est-ov')) return;
    var st = document.createElement('style'); st.id = 'est-css'; st.textContent = CSS; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.id = 'est-ov';
    ov.innerHTML =
      '<div class="est-shell">' +
      ' <div class="est-top"><h2>&#9998; Estimate <span class="est-num" id="est-num"></span></h2>' +
      '  <button class="btn btn-secondary" data-a="new">New</button>' +
      '  <button class="btn btn-secondary" data-a="recent">Recent</button>' +
      '  <button class="btn btn-secondary" data-a="biz" title="Business info shown on estimates">Business info</button>' +
      '  <button class="btn btn-secondary" data-a="close">Close</button></div>' +
      ' <div class="est-body">' +
      '  <div class="est-left">' +
      '   <div style="font-weight:600;font-size:14px;">Client</div>' +
      '   <label>Name *</label><input id="est-cname" maxlength="120" placeholder="Client or company name">' +
      '   <div class="est-row2"><div><label>Email</label><input id="est-cemail" type="email" maxlength="160" placeholder="client@email.com"></div>' +
      '   <div><label>Phone</label><input id="est-cphone" maxlength="40"></div></div>' +
      '   <label>Property / job address</label><input id="est-caddr" maxlength="240" placeholder="Street, city">' +
      '   <div style="font-weight:600;font-size:14px;margin-top:16px;">Project</div>' +
      '   <label>Describe the work *</label>' +
      '   <textarea id="est-req" class="est-desc" maxlength="6000" placeholder="e.g. Replace carpet in 2 bedrooms (12x12 and 11x13) with mid-grade LVP, new baseboards, haul away old carpet. Also patch & paint the hallway, about 30 ft long, 8 ft ceilings."></textarea>' +
      '   <div class="est-mic"><button class="btn btn-secondary" data-a="mic" id="est-micbtn">&#127908; Dictate</button><span id="est-miclive"></span></div>' +
      '   <div class="est-interim" id="est-interim"></div>' +
      '   <button class="btn btn-primary est-gen" data-a="generate" id="est-genbtn">Generate Estimate</button>' +
      '   <div class="est-hint" id="est-budget">Claude is only called when you click Generate.</div>' +
      '   <div class="est-hint"><a href="#" data-a="blank" style="color:var(--accent,#c8a96e);">Or build one manually</a></div>' +
      '   <div class="est-status" id="est-status"></div>' +
      '  </div>' +
      '  <div class="est-right" id="est-right"><div class="est-empty">Describe the project on the left and click <b>Generate Estimate</b>.<br>A draft with materials, labor and other line items will appear here for you to review and adjust.</div></div>' +
      ' </div>' +
      '</div>';
    document.body.appendChild(ov);

    ov.addEventListener('click', onClick);
    ov.addEventListener('input', onInput);
    ov.addEventListener('change', onInput);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('open') && !ov.querySelector('.est-pop')) closeEstimator(); });
    setupMic();
  }

  function openEstimator() {
    buildOverlay();
    $('est-ov').classList.add('open');
    document.body.style.overflow = 'hidden';
    loadBiz();
    refreshBudget();
    if (!S.est) newEstimate(true);
  }
  function closeEstimator() {
    flushSave();
    stopMic();
    $('est-ov').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── data ──────────────────────────────────────────────────────────────
  async function loadBiz() {
    try { var r = await db.from('business_profile').select('*').eq('id', 1).maybeSingle(); if (!r.error) S.biz = r.data || {}; } catch (e) {}
    if (S.doc) renderPreview();
  }
  async function refreshBudget() {
    try {
      var r = await db.rpc('estimate_budget_status');
      if (!r.error && r.data) { var left = Math.max(0, r.data.limit - r.data.used); $('est-budget').textContent = 'Claude is only called when you click Generate · ' + left + ' of ' + r.data.limit + ' left today.'; }
    } catch (e) {}
  }
  async function me() { try { var u = (await db.auth.getUser()).data.user; return u ? u.email : null; } catch (e) { return null; } }

  function clientFields() {
    return { client_name: $('est-cname').value.trim(), client_email: $('est-cemail').value.trim(), client_phone: $('est-cphone').value.trim(), client_address: $('est-caddr').value.trim() };
  }
  function fillClient(e) {
    $('est-cname').value = e.client_name || ''; $('est-cemail').value = e.client_email || '';
    $('est-cphone').value = e.client_phone || ''; $('est-caddr').value = e.client_address || '';
    $('est-req').value = e.request_text || '';
  }

  function newEstimate(silent) {
    if (!silent && S.est && S.doc && !confirm('Start a new estimate? The current one is saved under Recent.')) return;
    flushSave(); stopPoll();
    S.est = { id: null, estimate_number: '', status: 'draft' }; S.doc = null;
    fillClient({}); $('est-num').textContent = ''; $('est-status').innerHTML = '';
    $('est-right').innerHTML = '<div class="est-empty">Describe the project on the left and click <b>Generate Estimate</b>.<br>A draft with materials, labor and other line items will appear here for you to review and adjust.</div>';
    setGenBusy(false);
  }

  async function ensureRow(extra) {
    var c = clientFields();
    var payload = Object.assign({}, c, { request_text: $('est-req').value.trim(), updated_at: new Date().toISOString() }, extra || {});
    if (S.est && S.est.id) {
      var u = await db.from('estimates').update(payload).eq('id', S.est.id).select('id,estimate_number,status').single();
      if (u.error) throw u.error; return u.data;
    }
    payload.created_by = await me();
    var ins = await db.from('estimates').insert(payload).select('id,estimate_number,status,created_at').single();
    if (ins.error) throw ins.error;
    S.est = ins.data; $('est-num').textContent = ins.data.estimate_number;
    return ins.data;
  }

  function setGenBusy(b) {
    var btn = $('est-genbtn'); if (!btn) return;
    btn.disabled = b; btn.textContent = b ? 'Generating…' : (S.doc ? 'Regenerate Estimate' : 'Generate Estimate');
  }

  async function generate() {
    var req = $('est-req').value.trim();
    if (req.length < 15) { toast('Describe the project in a bit more detail first.', 'error'); $('est-req').focus(); return; }
    if (!$('est-cname').value.trim()) { toast('Add the client name first.', 'error'); $('est-cname').focus(); return; }
    if (S.doc && S.doc.lines && S.doc.lines.length && !confirm('Regenerate? This replaces the current line items and any edits.')) return;
    stopMic();
    setGenBusy(true);
    $('est-status').innerHTML = '<span class="est-spin"></span>Building your estimate — usually 20–60 seconds…';
    try {
      var row = await ensureRow({ status: 'generating', error: null });
      var res = await authFetch('/.netlify/functions/estimate-ai-background', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estimate_id: row.id }),
      });
      if (res.status === 401) throw new Error('Not authorized — staff sign-in required.');
      if (!res.ok && res.status !== 202) throw new Error('Could not start generation (HTTP ' + res.status + ').');
      poll(row.id, Date.now());
    } catch (e) {
      setGenBusy(false);
      $('est-status').innerHTML = '<span class="bad">' + E(e.message || e) + '</span>';
    }
  }

  function stopPoll() { if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; } }
  function poll(id, started) {
    stopPoll();
    S.pollTimer = setTimeout(async function () {
      if (!S.est || S.est.id !== id) return;
      var r = await db.from('estimates').select('*').eq('id', id).single();
      if (r.error) { S.pollTimer = null; return poll(id, started); }
      var e = r.data;
      if (e.status === 'ready' && e.doc) {
        S.est = e; S.doc = normalizeDoc(e.doc);
        setGenBusy(false); refreshBudget();
        $('est-status').innerHTML = '<span class="ok">&#10003; Draft ready.</span> Review every line — quantities and costs are AI estimates.';
        renderPreview();
        return;
      }
      if (e.status === 'error') {
        setGenBusy(false); refreshBudget();
        $('est-status').innerHTML = '<span class="bad">' + E(e.error || 'Generation failed.') + '</span>';
        await db.from('estimates').update({ status: S.doc ? 'ready' : 'draft' }).eq('id', id);
        return;
      }
      if (Date.now() - started > 5 * 60000) {
        setGenBusy(false);
        $('est-status').innerHTML = '<span class="bad">This is taking too long. Try again in a minute.</span>';
        await db.from('estimates').update({ status: S.doc ? 'ready' : 'draft' }).eq('id', id);
        return;
      }
      poll(id, started);
    }, 3000);
  }

  function normalizeDoc(d) {
    d = JSON.parse(JSON.stringify(d || {}));
    d.lines = (d.lines || []).map(function (l) { return Object.assign({ id: 'l' + (S.lineSeq++), category: 'Other', description: '', qty: 1, unit: 'ea', unit_cost: 0, unit_price: 0, cost_basis: '' }, l, { id: l.id || ('l' + (S.lineSeq++)) }); });
    S.lineSeq = d.lines.length + 100;
    d.assumptions = d.assumptions || []; d.exclusions = d.exclusions || []; d.internal_questions = d.internal_questions || [];
    return d;
  }

  async function startBlank() {
    if (!$('est-cname').value.trim()) { toast('Add the client name first.', 'error'); $('est-cname').focus(); return; }
    if (S.doc && !confirm('Replace the current estimate with a blank one?')) return;
    S.doc = normalizeDoc({ project_title: '', scope_summary: '', lines: [{ category: 'Labor', description: '', qty: 1, unit: 'hr', unit_cost: 0, unit_price: 0 }], assumptions: [], exclusions: [], timeline: '', notes: '', valid_days: (S.biz && S.biz.valid_days) || 30 });
    try { await ensureRow({ status: 'ready' }); } catch (e) { toast('Could not save: ' + e.message, 'error'); }
    renderPreview(); scheduleSave();
  }

  // ── save ──────────────────────────────────────────────────────────────
  function scheduleSave() { if (S.saving) clearTimeout(S.saving); S.saving = setTimeout(saveNow, 900); }
  function flushSave() { if (S.saving) { clearTimeout(S.saving); S.saving = null; saveNow(); } }
  async function saveNow() {
    S.saving = null;
    if (!S.est || !S.est.id) return;
    var t = S.doc ? totals(S.doc.lines) : null;
    var patch = Object.assign(clientFields(), { request_text: $('est-req').value.trim(), updated_at: new Date().toISOString() });
    if (S.doc) { patch.doc = S.doc; patch.totals = t; patch.margin_pct = t.margin; }
    var r = await db.from('estimates').update(patch).eq('id', S.est.id);
    if (r.error) toast('Autosave failed: ' + r.error.message, 'error');
  }

  // ── preview ───────────────────────────────────────────────────────────
  function bizBlock() {
    var b = S.biz || {};
    var lines = [b.address, [b.phone, b.email].filter(Boolean).join(' · '), b.website, b.license ? 'License: ' + b.license : null].filter(Boolean);
    return (b.logo_data_url && /^data:image\//.test(b.logo_data_url) ? '<img src="' + E(b.logo_data_url) + '" alt="">' : '') +
      '<b>' + E(b.name || 'Bentonville Lodging Co.') + '</b>' + (b.tagline ? '<div>' + E(b.tagline) + '</div>' : '') + lines.map(function (x) { return '<div>' + E(x) + '</div>'; }).join('');
  }
  function issuedDate() { return S.est && S.est.created_at ? new Date(S.est.created_at) : new Date(); }
  function validDate() { return new Date(issuedDate().getTime() + (n(S.doc.valid_days) || (S.biz && S.biz.valid_days) || 30) * 86400000); }

  function renderPreview() {
    var d = S.doc; if (!d) return;
    var c = clientFields();
    var catOpts = function (sel) { return CATS.map(function (k) { return '<option' + (k === sel ? ' selected' : '') + '>' + E(k) + '</option>'; }).join(''); };
    var rows = d.lines.map(function (l) {
      var lm = lineMargin(l), floorP = priceForCost(l.unit_cost);
      return '<tr data-id="' + E(l.id) + '">' +
        '<td><textarea data-f="description" rows="1" placeholder="Describe this line">' + E(l.description) + '</textarea>' +
        '<select data-f="category">' + catOpts(l.category) + '</select></td>' +
        '<td class="r"><input class="num" data-f="qty" type="number" step="0.01" min="0" value="' + E(l.qty) + '"></td>' +
        '<td><input class="unit" data-f="unit" maxlength="20" value="' + E(l.unit) + '"></td>' +
        '<td class="r"><input class="num" data-f="unit_price" type="number" step="0.01" min="0" value="' + E(l.unit_price) + '"></td>' +
        '<td class="r amt" data-amt>' + money(n(l.qty) * n(l.unit_price)) + '</td>' +
        (S.showInternal ? '<td class="int r"><input class="num" data-f="unit_cost" type="number" step="0.01" min="0" value="' + E(l.unit_cost) + '" title="' + E(l.cost_basis || 'Your cost per unit') + '"></td>' +
          '<td class="int lm" data-lm><span class="' + (lm >= MIN_MARGIN - 0.00005 ? 'ok' : 'bad') + '">' + pct(lm) + '</span>' +
          (n(l.unit_price) < floorP ? '<button class="floorbtn" data-a="floor1" title="Set to 30% floor: ' + E(money(floorP)) + '">&#8593;30%</button>' : '') + '</td>' : '') +
        '<td><button class="x" data-a="del" title="Remove line">&times;</button></td></tr>';
    }).join('');

    var t = totals(d.lines);
    var html =
      (S.showInternal ? internalPanel(t) : '<div style="text-align:right;max-width:900px;margin:0 auto 8px;"><button class="btn btn-secondary" data-a="toggleint">Show internal cost &amp; margin</button></div>') +
      '<div class="est-paper" id="est-paper">' +
      ' <div class="est-ph"><div class="est-biz">' + bizBlock() + '</div>' +
      '  <div class="est-meta"><div class="t">ESTIMATE</div>' + E(S.est.estimate_number || '') + '<br>Date: ' + E(fmtDate(issuedDate())) + '<br>Valid until: ' + E(fmtDate(validDate())) + '</div></div>' +
      ' <div class="est-for"><div class="k">Prepared for</div><b>' + E(c.client_name) + '</b>' + (c.client_address ? '<br>' + E(c.client_address) : '') + (c.client_email ? '<br>' + E(c.client_email) : '') + (c.client_phone ? '<br>' + E(c.client_phone) : '') + '</div>' +
      ' <input class="est-title" data-d="project_title" maxlength="140" placeholder="Project title" value="' + E(d.project_title) + '">' +
      ' <textarea data-d="scope_summary" rows="3" placeholder="Scope summary">' + E(d.scope_summary) + '</textarea>' +
      ' <div class="est-tablewrap"><table class="est-lines"><thead><tr><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit price</th><th class="r">Amount</th>' +
      (S.showInternal ? '<th class="int r" title="Internal — never shown to the client">Cost/unit</th><th class="int">Margin</th>' : '') + '<th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      ' <button class="est-addline" data-a="addline">+ Add line</button>' +
      ' <table class="est-tot" id="est-tot">' + totRows(t) + '</table>' +
      ' <div class="est-sec"><div class="k">Estimated timeline</div><input data-d="timeline" maxlength="200" value="' + E(d.timeline) + '" placeholder="e.g. 2–3 working days"></div>' +
      ' <div class="est-sec"><div class="k">Assumptions</div><div class="h">One per line</div><textarea data-d="assumptions" rows="3">' + E(d.assumptions.join('\n')) + '</textarea></div>' +
      ' <div class="est-sec"><div class="k">Not included</div><div class="h">One per line</div><textarea data-d="exclusions" rows="3">' + E(d.exclusions.join('\n')) + '</textarea></div>' +
      ' <div class="est-sec"><div class="k">Notes</div><textarea data-d="notes" rows="2" placeholder="Optional note to the client">' + E(d.notes) + '</textarea></div>' +
      ((S.biz && S.biz.terms) ? ' <div class="est-terms">' + NL(S.biz.terms) + '</div>' : '') +
      '</div>' +
      '<div class="est-actions"><span class="est-hint" id="est-savehint" style="margin-right:auto;align-self:center;">Changes save automatically.</span>' +
      ' <button class="btn btn-secondary" data-a="export">Export PDF</button>' +
      ' <button class="btn btn-primary" data-a="email">Email to client</button></div>';
    $('est-right').innerHTML = html;
    autosizeAll();
  }

  function totRows(t) {
    return '<tr><td>Subtotal</td><td>' + money(t.subtotal) + '</td></tr>' +
      '<tr><td>Overhead (10%)</td><td>' + money(t.overhead) + '</td></tr>' +
      '<tr><td>Sales tax (7.2%)</td><td>' + money(t.tax) + '</td></tr>' +
      '<tr class="g"><td>Total</td><td>' + money(t.total) + '</td></tr>';
  }
  function internalPanel(t) {
    var q = (S.doc.internal_questions || []).filter(Boolean);
    return '<div class="est-internal" id="est-int" style="max-width:900px;margin:0 auto 14px;">' +
      '<div class="hd"><span class="tag">Internal only — never shown to the client</span><span style="flex:1"></span>' +
      '<button class="btn btn-secondary" data-a="floorall" style="padding:5px 10px;font-size:12px;">Set all lines to 30% floor</button>' +
      '<button class="btn btn-secondary" data-a="toggleint" style="padding:5px 10px;font-size:12px;">Hide</button></div>' +
      '<div class="est-kpis" id="est-kpis">' + kpis(t) + '</div>' +
      (q.length ? '<div style="margin-top:8px;font-size:12px;color:#7fc7c0;font-weight:600;">Verify before sending</div><ul class="est-q">' + q.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul>' : '') +
      '</div>';
  }
  function kpis(t) {
    return '<div>Your cost<b>' + money(t.cost) + '</b></div>' +
      '<div>Revenue before tax<b>' + money(t.subtotal + t.overhead) + '</b></div>' +
      '<div>Gross profit after overhead<b>' + money(t.subtotal - t.cost) + '</b></div>' +
      '<div>Margin (min 30%)<b class="' + (t.meets_floor ? 'ok' : 'bad') + '">' + pct(t.margin) + (t.meets_floor ? ' ✓' : ' — too low') + '</b></div>';
  }
  function refreshNumbers() {
    var t = totals(S.doc.lines);
    var tot = $('est-tot'); if (tot) tot.innerHTML = totRows(t);
    var k = $('est-kpis'); if (k) k.innerHTML = kpis(t);
    document.querySelectorAll('#est-ov table.est-lines tbody tr').forEach(function (tr) {
      var l = findLine(tr.getAttribute('data-id')); if (!l) return;
      var a = tr.querySelector('[data-amt]'); if (a) a.textContent = money(n(l.qty) * n(l.unit_price));
      var m = tr.querySelector('[data-lm]');
      if (m) { var lm = lineMargin(l), fp = priceForCost(l.unit_cost);
        m.innerHTML = '<span class="' + (lm >= MIN_MARGIN - 0.00005 ? 'ok' : 'bad') + '">' + pct(lm) + '</span>' + (n(l.unit_price) < fp ? '<button class="floorbtn" data-a="floor1" title="Set to 30% floor: ' + E(money(fp)) + '">&#8593;30%</button>' : ''); }
    });
  }
  function findLine(id) { return S.doc && S.doc.lines.find(function (l) { return l.id === id; }); }
  function autosizeAll() { document.querySelectorAll('#est-ov .est-paper textarea').forEach(autosize); }
  function autosize(el) { el.style.height = 'auto'; el.style.height = Math.max(34, el.scrollHeight + 2) + 'px'; }

  // ── events ────────────────────────────────────────────────────────────
  function onInput(e) {
    var el = e.target;
    if (/^est-c(name|email|phone|addr)$/.test(el.id) || el.id === 'est-req') {
      if (S.doc && el.id !== 'est-req' && e.type === 'change') renderPreview();
      if (S.est && S.est.id) scheduleSave();
      return;
    }
    if (!S.doc) return;
    var f = el.getAttribute('data-f'), dk = el.getAttribute('data-d');
    // Text/number fields already handled on 'input'; re-handling 'change' (fired on blur) would
    // re-render the row's buttons mid-click. Selects only fire a meaningful 'change'.
    if (e.type === 'change' && el.tagName !== 'SELECT') return;
    if (f) {
      var tr = el.closest('tr'); var l = tr && findLine(tr.getAttribute('data-id')); if (!l) return;
      if (f === 'qty' || f === 'unit_price' || f === 'unit_cost') l[f] = r2(Math.max(0, n(el.value)));
      else l[f] = String(el.value).slice(0, f === 'description' ? 500 : 40);
      if (el.tagName === 'TEXTAREA') autosize(el);
      refreshNumbers(); scheduleSave();
    } else if (dk) {
      if (dk === 'assumptions' || dk === 'exclusions') S.doc[dk] = el.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 20);
      else S.doc[dk] = el.value;
      if (el.tagName === 'TEXTAREA') autosize(el);
      scheduleSave();
    }
  }

  function onClick(e) {
    var b = e.target.closest('[data-a]'); if (!b) return;
    var a = b.getAttribute('data-a');
    if (b.tagName === 'A') e.preventDefault();
    if (a === 'close') return closeEstimator();
    if (a === 'new') return newEstimate(false);
    if (a === 'recent') return showRecent();
    if (a === 'biz') return showBiz();
    if (a === 'mic') return toggleMic();
    if (a === 'generate') return generate();
    if (a === 'blank') return startBlank();
    if (!S.doc) return;
    if (a === 'toggleint') { S.showInternal = !S.showInternal; return renderPreview(); }
    if (a === 'addline') { S.doc.lines.push({ id: 'l' + (S.lineSeq++), category: 'Other', description: '', qty: 1, unit: 'ea', unit_cost: 0, unit_price: 0, cost_basis: '' }); renderPreview(); scheduleSave(); var ta = document.querySelectorAll('#est-ov table.est-lines textarea'); if (ta.length) ta[ta.length - 1].focus(); return; }
    if (a === 'del') { var tr = b.closest('tr'); S.doc.lines = S.doc.lines.filter(function (l) { return l.id !== tr.getAttribute('data-id'); }); renderPreview(); scheduleSave(); return; }
    if (a === 'floor1') { var l = findLine(b.closest('tr').getAttribute('data-id')); if (l) { l.unit_price = priceForCost(l.unit_cost); renderPreview(); scheduleSave(); } return; }
    if (a === 'floorall') { S.doc.lines.forEach(function (l) { if (n(l.unit_price) < priceForCost(l.unit_cost)) l.unit_price = priceForCost(l.unit_cost); }); renderPreview(); scheduleSave(); toast('Lines below 30% raised to the floor.', 'success'); return; }
    if (a === 'export') return exportPdf();
    if (a === 'email') return emailDialog();
  }

  function checkReady() {
    var c = clientFields();
    if (!c.client_name) { toast('Add the client name.', 'error'); return false; }
    var lines = S.doc.lines.filter(function (l) { return String(l.description).trim(); });
    if (!lines.length) { toast('Add at least one line item.', 'error'); return false; }
    if (S.doc.lines.some(function (l) { return !String(l.description).trim() && (n(l.unit_price) || n(l.unit_cost)); })) { toast('Every priced line needs a description.', 'error'); return false; }
    var t = totals(S.doc.lines);
    if (!t.meets_floor) { toast('Margin is ' + pct(t.margin) + ' — below the 30% minimum. Raise prices (or use "Set all lines to 30% floor").', 'error'); if (!S.showInternal) { S.showInternal = true; renderPreview(); } return false; }
    return true;
  }
  function cleanLines() { S.doc.lines = S.doc.lines.filter(function (l) { return String(l.description).trim() || n(l.unit_price) || n(l.unit_cost); }); }

  // ── export (browser print → Save as PDF) ──────────────────────────────
  function clientDocHtml() {
    var d = S.doc, c = clientFields(), t = totals(d.lines);
    var rows = d.lines.map(function (l) {
      return '<tr><td>' + NL(l.description) + (l.category ? '<div class="cat">' + E(l.category) + '</div>' : '') + '</td><td class="r">' + E(qtyFmt(l.qty)) + ' ' + E(l.unit) + '</td><td class="r">' + money(l.unit_price) + '</td><td class="r">' + money(n(l.qty) * n(l.unit_price)) + '</td></tr>';
    }).join('');
    var list = function (title, arr) { return arr && arr.length ? '<h4>' + E(title) + '</h4><ul>' + arr.map(function (x) { return '<li>' + E(x) + '</li>'; }).join('') + '</ul>' : ''; };
    return '<div class="hd"><div class="biz">' + bizBlock() + '</div><div class="meta"><div class="t">ESTIMATE</div>' + E(S.est.estimate_number || '') + '<br>Date: ' + E(fmtDate(issuedDate())) + '<br>Valid until: ' + E(fmtDate(validDate())) + '</div></div>' +
      '<div class="for"><div class="k">Prepared for</div><b>' + E(c.client_name) + '</b>' + (c.client_address ? '<br>' + E(c.client_address) : '') + (c.client_email ? '<br>' + E(c.client_email) : '') + (c.client_phone ? '<br>' + E(c.client_phone) : '') + '</div>' +
      (d.project_title ? '<h2>' + E(d.project_title) + '</h2>' : '') + (d.scope_summary ? '<p>' + NL(d.scope_summary) + '</p>' : '') +
      '<table class="ln"><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<table class="tot">' + totRows(t) + '</table>' +
      (d.timeline ? '<p><b>Estimated timeline:</b> ' + E(d.timeline) + '</p>' : '') + list('Assumptions', d.assumptions) + list('Not included', d.exclusions) +
      (d.notes ? '<h4>Notes</h4><p>' + NL(d.notes) + '</p>' : '') + (S.biz && S.biz.terms ? '<div class="terms">' + NL(S.biz.terms) + '</div>' : '') +
      '<div class="sign"><div>Accepted by</div><div>Date</div></div>';
  }
  function exportPdf() {
    cleanLines(); if (!checkReady()) return; flushSave();
    var w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for PropDesk to export.', 'error'); return; }
    var css = 'body{font-family:Helvetica,Arial,sans-serif;color:#1d1b18;margin:28px;font-size:13px}.hd{display:flex;justify-content:space-between;gap:20px}.biz{font-size:12px;color:#555;line-height:1.5}.biz b{font-size:20px;color:#1d1b18;display:block}.biz img{max-height:56px;max-width:180px;display:block;margin-bottom:6px}.meta{text-align:right;font-size:12px;color:#555;line-height:1.6}.meta .t{font-size:24px;font-weight:700;color:#a8893f;letter-spacing:1px}.for{margin-top:18px;background:#f8f6f2;border-radius:8px;padding:10px 12px;line-height:1.5}.for .k{font-size:10px;color:#8a857a;text-transform:uppercase;letter-spacing:.08em}h2{font-size:17px;margin:18px 0 4px}p{line-height:1.55;margin:6px 0}table.ln{width:100%;border-collapse:collapse;margin-top:14px}table.ln th{background:#1d1b18;color:#fff;padding:8px;text-align:left;font-size:12px}table.ln td{padding:8px;border-bottom:1px solid #e8e4dc;vertical-align:top}.r{text-align:right;white-space:nowrap}.cat{font-size:10px;color:#8a857a}table.tot{margin:12px 0 0 auto;min-width:260px;border-collapse:collapse}table.tot td{padding:4px 8px}table.tot td:last-child{text-align:right}table.tot tr.g td{font-weight:700;font-size:15px;border-top:2px solid #1d1b18}h4{margin:16px 0 4px;font-size:13px}ul{margin:0;padding-left:18px;line-height:1.5}.terms{margin-top:20px;border-top:1px solid #e8e4dc;padding-top:10px;font-size:11px;color:#8a857a;line-height:1.5}.sign{display:flex;gap:30px;margin-top:40px}.sign div{flex:1;border-top:1px solid #999;padding-top:4px;font-size:11px;color:#666}tr{page-break-inside:avoid}@media print{body{margin:14mm}}';
    w.document.open();
    w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + E((S.est.estimate_number || 'Estimate') + ' - ' + clientFields().client_name) + '</title><style>' + css + '</style></head><body>' + clientDocHtml() + '</body></html>');
    w.document.close();
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 350);
  }

  // ── email ─────────────────────────────────────────────────────────────
  function pop(html) {
    var p = document.createElement('div'); p.className = 'est-pop'; p.innerHTML = '<div class="bx">' + html + '</div>';
    p.addEventListener('click', function (e) { if (e.target === p || e.target.closest('[data-pop="close"]')) p.remove(); });
    $('est-ov').appendChild(p); return p;
  }
  function emailDialog() {
    cleanLines(); if (!checkReady()) return;
    var c = clientFields();
    if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(c.client_email)) { toast('Add a valid client email on the left first.', 'error'); $('est-cemail').focus(); return; }
    var t = totals(S.doc.lines);
    var p = pop('<h3>Email estimate</h3><div class="est-hint">To <b>' + E(c.client_email) + '</b> · Total ' + money(t.total) + '. Replies come to you, and you\'re CC\'d. Internal cost and margin are never included.</div>' +
      '<label>Message (optional)</label><textarea id="est-msg" rows="5" maxlength="3000">Hi ' + E((c.client_name || '').split(' ')[0]) + ',\n\nThanks for the opportunity. Please find your estimate below. Let us know if you have any questions or would like to move forward.\n\nThank you,\n' + E((S.biz && S.biz.name) || 'Bentonville Lodging Co.') + '</textarea>' +
      '<div class="ft"><button class="btn btn-secondary" data-pop="close">Cancel</button><button class="btn btn-primary" id="est-sendbtn">Send estimate</button></div>');
    p.querySelector('#est-sendbtn').addEventListener('click', async function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Sending…';
      try {
        if (S.saving) { clearTimeout(S.saving); S.saving = null; }
        await saveNow();
        var res = await authFetch('/.netlify/functions/estimate-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estimate_id: S.est.id, message: p.querySelector('#est-msg').value }) });
        var j = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        S.est.status = 'sent'; p.remove(); toast('Estimate sent to ' + j.sent_to, 'success');
      } catch (e) { btn.disabled = false; btn.textContent = 'Send estimate'; toast('Send failed: ' + e.message, 'error'); }
    });
  }

  // ── recent ────────────────────────────────────────────────────────────
  async function showRecent() {
    flushSave();
    var r = await db.from('estimates').select('id,estimate_number,client_name,status,totals,doc->>project_title,created_at').order('created_at', { ascending: false }).limit(25);
    if (r.error) { toast('Could not load estimates: ' + r.error.message, 'error'); return; }
    var rows = (r.data || []).map(function (e) {
      return '<tr data-open="' + E(e.id) + '"><td><div style="font-weight:600;">' + E(e.client_name || '—') + '</div><div class="est-hint" style="margin:0;">' + E(e.estimate_number) + ' · ' + E(e.project_title || '') + '</div></td>' +
        '<td style="text-align:right;white-space:nowrap;">' + (e.totals ? money(e.totals.total) : '') + '<div><span class="pill ' + E(e.status) + '">' + E(e.status) + '</span></div></td></tr>';
    }).join('') || '<tr><td>No estimates yet.</td></tr>';
    var p = pop('<h3>Recent estimates</h3><table class="est-rec">' + rows + '</table><div class="ft"><button class="btn btn-secondary" data-pop="close">Close</button></div>');
    p.querySelectorAll('[data-open]').forEach(function (tr) { tr.addEventListener('click', function () { p.remove(); openExisting(Number(tr.getAttribute('data-open'))); }); });
  }
  async function openExisting(id) {
    stopPoll();
    var r = await db.from('estimates').select('*').eq('id', id).single();
    if (r.error) { toast(r.error.message, 'error'); return; }
    var e = r.data; S.est = e; S.doc = e.doc ? normalizeDoc(e.doc) : null;
    fillClient(e); $('est-num').textContent = e.estimate_number || ''; $('est-status').innerHTML = e.status === 'sent' ? '<span class="ok">Sent to ' + E(e.sent_to || '') + '</span>' : '';
    setGenBusy(false);
    if (e.status === 'generating') { setGenBusy(true); $('est-status').innerHTML = '<span class="est-spin"></span>Still generating…'; poll(id, Date.now()); }
    if (S.doc) renderPreview(); else $('est-right').innerHTML = '<div class="est-empty">No line items yet — click <b>Generate Estimate</b>.</div>';
  }

  // ── business info ─────────────────────────────────────────────────────
  function showBiz() {
    var b = S.biz || {};
    var f = function (k, label, ph) { return '<label>' + label + '</label><input data-b="' + k + '" maxlength="240" value="' + E(b[k] || '') + '" placeholder="' + E(ph || '') + '">'; };
    var p = pop('<h3>Business info on estimates</h3>' + f('name', 'Business name') + f('tagline', 'Tagline', 'Optional') + f('address', 'Address') +
      '<div class="est-row2"><div>' + f('phone', 'Phone') + '</div><div>' + f('email', 'Email') + '</div></div>' +
      '<div class="est-row2"><div>' + f('website', 'Website') + '</div><div>' + f('license', 'License #', 'Optional') + '</div></div>' +
      '<label>Logo (PNG/JPG)</label><input type="file" accept="image/png,image/jpeg,image/webp" id="est-logo"><div id="est-logoprev" style="margin-top:6px;">' + (b.logo_data_url ? '<img src="' + E(b.logo_data_url) + '" style="max-height:48px;background:#fff;padding:4px;border-radius:4px;"> <a href="#" id="est-logorm" style="color:var(--red,#e06b5a);font-size:12px;">remove</a>' : '') + '</div>' +
      '<label>Valid for (days)</label><input data-b="valid_days" type="number" min="1" max="365" value="' + E(b.valid_days || 30) + '">' +
      '<label>Terms (shown at the bottom)</label><textarea data-b="terms" rows="4" maxlength="2000">' + E(b.terms || '') + '</textarea>' +
      '<div class="ft"><button class="btn btn-secondary" data-pop="close">Cancel</button><button class="btn btn-primary" id="est-bizsave">Save</button></div>');
    var logo = b.logo_data_url || null;
    p.querySelector('#est-logo').addEventListener('change', function () {
      var file = this.files && this.files[0]; if (!file) return;
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, 400 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        logo = cv.toDataURL('image/png'); URL.revokeObjectURL(url);
        p.querySelector('#est-logoprev').innerHTML = '<img src="' + E(logo) + '" style="max-height:48px;background:#fff;padding:4px;border-radius:4px;">';
      };
      img.src = url;
    });
    var rm = p.querySelector('#est-logorm'); if (rm) rm.addEventListener('click', function (e) { e.preventDefault(); logo = null; p.querySelector('#est-logoprev').innerHTML = ''; });
    p.querySelector('#est-bizsave').addEventListener('click', async function () {
      var patch = { logo_data_url: logo, updated_at: new Date().toISOString() };
      p.querySelectorAll('[data-b]').forEach(function (el) { var k = el.getAttribute('data-b'); patch[k] = k === 'valid_days' ? Math.min(365, Math.max(1, parseInt(el.value, 10) || 30)) : (el.value.trim() || null); });
      if (!patch.name) patch.name = 'Bentonville Lodging Co.';
      var r = await db.from('business_profile').update(patch).eq('id', 1).select('*').single();
      if (r.error) { toast('Save failed: ' + r.error.message, 'error'); return; }
      S.biz = r.data; p.remove(); toast('Business info saved.', 'success'); if (S.doc) renderPreview();
    });
  }

  // ── voice (Web Speech API; audio never goes to Claude) ────────────────
  function setupMic() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition, btn = $('est-micbtn');
    if (!SR) { btn.disabled = true; btn.title = 'Voice dictation isn\'t supported in this browser — use Chrome, Edge or Safari.'; btn.textContent = '🎤 Dictation unavailable'; return; }
    var rec = new SR(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = function (ev) {
      var interim = '', fin = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) { var tx = ev.results[i][0].transcript; if (ev.results[i].isFinal) fin += tx; else interim += tx; }
      if (fin) { var ta = $('est-req'); ta.value = (ta.value.replace(/\s+$/, '') + (ta.value.trim() ? ' ' : '') + fin.trim()).slice(0, 6000); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      $('est-interim').textContent = interim;
    };
    rec.onerror = function (ev) { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('Microphone access was blocked. Allow it in your browser settings.', 'error'); else if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('Dictation error: ' + ev.error, 'error'); };
    rec.onend = function () { if (S.listening) { try { rec.start(); } catch (e) { setMicUi(false); } } else setMicUi(false); };
    S.rec = rec;
  }
  function setMicUi(on) {
    S.listening = on;
    $('est-micbtn').innerHTML = on ? '&#9632; Stop' : '&#127908; Dictate';
    $('est-miclive').innerHTML = on ? '<span class="live">● Listening…</span>' : '';
    if (!on) $('est-interim').textContent = '';
  }
  function toggleMic() { if (!S.rec) return; if (S.listening) stopMic(); else { try { S.rec.start(); setMicUi(true); } catch (e) { toast('Could not start the microphone.', 'error'); } } }
  function stopMic() { if (S.rec && S.listening) { S.listening = false; try { S.rec.stop(); } catch (e) {} } if ($('est-micbtn')) setMicUi(false); }

  // ── boot ──────────────────────────────────────────────────────────────
  function boot() {
    if (typeof db === 'undefined' || typeof authFetch === 'undefined') return;
    if (addCard()) return;
    var tries = 0, iv = setInterval(function () { if (addCard() || ++tries > 40) clearInterval(iv); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.PropDeskEstimator = { open: openEstimator, _test: { totals: totals, priceForCost: priceForCost } };
})();
