// js/ai-training.js — PropDesk "AI Training" card on each property card (staff only)
//
// Loaded by index.html (<script src="/js/ai-training.js" defer>). Adds an "AI Training" button to
// every card in the staff Property Cards grid. The training card is the ONLY home-specific
// information the guest Concierge (Home Guide + AI chat) can use, besides Guesty's public listing
// text. The rest of the property card (door code, supply-closet codes, stocking notes, photos) is
// team-only and is never shown to guests or the AI.
//
// Data: property_cards.listing_id links a card to its Guesty listing; items are guest_guide_items
// (listing_id = that listing; listing_id NULL = "all homes"). Items marked Sensitive (door codes,
// Wi-Fi…) are only released to the guest and the AI from the start of check-in day.
(function () {
  'use strict';

  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function $(id) { return document.getElementById(id); }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
  var norm = function (s) { return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); };

  var SECTIONS = ['Check-in', 'Wi-Fi', 'Parking', 'Heating & cooling', 'Kitchen', 'Hot tub / pool', 'Laundry', 'Trash & recycling', 'Breakers & utilities', 'Troubleshooting', 'House rules', 'Checkout', 'Local tips', 'General'];
  var TEMPLATES = [
    { section: 'Check-in', title: 'Door code & entry', body: 'Front door keypad code: ____. Enter the code, then press the lock button.', sensitive: true },
    { section: 'Wi-Fi', title: 'Wi-Fi network & password', body: 'Network: ____\nPassword: ____\nRouter is located ____. If it drops, unplug it for 30 seconds.', sensitive: true },
    { section: 'Parking', title: 'Where to park', body: 'Park ____. Max ____ vehicles. No street parking ____.', sensitive: false },
    { section: 'Heating & cooling', title: 'Thermostat', body: 'Thermostat is in the ____. Please keep it between 68–76°F.', sensitive: false },
    { section: 'Breakers & utilities', title: 'Breaker panel', body: 'Breaker panel is in the ____. Kitchen/bath GFCI outlets reset with the button on the outlet.', sensitive: false },
    { section: 'Hot tub / pool', title: 'Hot tub', body: 'Hot tub controls ____. Please keep the cover on when not in use.', sensitive: false },
    { section: 'Trash & recycling', title: 'Trash', body: 'Bins are ____. Pickup day is ____.', sensitive: false },
    { section: 'Checkout', title: 'Checkout steps', body: 'Before you go: start the dishwasher, put towels in the tub, take trash to the bins, lock the door.', sensitive: false },
    { section: 'Troubleshooting', title: 'TV / streaming', body: 'Use the ____ remote. Input should be HDMI ____.', sensitive: false },
  ];

  var S = { card: null, listings: [], items: [], scope: 'home' };

  var CSS = [
    '.ait-btn{margin-top:10px;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid #3fa7a055;background:#3fa7a014;color:#7fc7c0;cursor:pointer}',
    '.ait-btn:hover{background:#3fa7a026}',
    '.ait-btn .n{font-weight:400;color:var(--text-muted,#888)}',
    '#ait-ov{position:fixed;inset:0;z-index:1004;background:rgba(0,0,0,.72);display:none;align-items:flex-start;justify-content:center;padding:24px 14px;overflow-y:auto;backdrop-filter:blur(4px)}',
    '#ait-ov.open{display:flex}',
    '#ait-ov .bx{background:var(--surface,#1a1a18);color:var(--text,#f0ede6);border:1px solid var(--border-light,#3d3d39);border-radius:14px;width:100%;max-width:760px;font-family:"DM Sans",sans-serif;box-shadow:0 8px 48px rgba(0,0,0,.6)}',
    '#ait-ov .hd{padding:18px 20px 12px;border-bottom:1px solid var(--border,#333);display:flex;gap:12px;align-items:flex-start}',
    '#ait-ov .hd h2{margin:0;font-family:"Playfair Display",serif;font-size:20px}',
    '#ait-ov .hd .s{font-size:12px;color:var(--text-muted,#888);margin-top:3px;line-height:1.45}',
    '#ait-ov .x{margin-left:auto;background:none;border:none;color:var(--text-muted,#888);font-size:20px;cursor:pointer}',
    '#ait-ov .sec{padding:14px 20px}',
    '#ait-ov .note{background:#1e2a29;border:1px solid #2f4a47;border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.5;color:#bcd}',
    '#ait-ov label{display:block;font-size:11px;color:var(--text-muted,#888);text-transform:uppercase;letter-spacing:.06em;margin:10px 0 4px}',
    '#ait-ov input,#ait-ov textarea,#ait-ov select{width:100%;box-sizing:border-box;background:var(--surface2,#242422);border:1px solid var(--border,#333);color:var(--text,#f0ede6);border-radius:6px;padding:8px 10px;font:inherit;font-size:13px}',
    '#ait-ov textarea{resize:vertical;min-height:70px}',
    '#ait-ov .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '#ait-ov .tabs{display:flex;gap:6px;margin-top:12px}',
    '#ait-ov .tab{font:inherit;font-size:12px;padding:6px 12px;border-radius:20px;border:1px solid var(--border,#333);background:none;color:var(--text-muted,#888);cursor:pointer}',
    '#ait-ov .tab.on{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e);font-weight:600}',
    '#ait-ov .item{background:var(--surface2,#242422);border:1px solid var(--border,#333);border-radius:10px;padding:10px 12px;margin-bottom:8px}',
    '#ait-ov .item.off{opacity:.5}',
    '#ait-ov .item .t{font-weight:600;font-size:13.5px}',
    '#ait-ov .item .b{font-size:12.5px;color:var(--text-muted,#888);white-space:pre-wrap;margin-top:3px;line-height:1.45}',
    '#ait-ov .tag{font-size:10px;padding:2px 7px;border-radius:10px;background:var(--surface3,#2e2e2b);color:var(--text-muted,#888);margin-right:4px}',
    '#ait-ov .tag.sens{background:#d4a84322;color:#d4a843}',
    '#ait-ov .btn-s{font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:6px 11px;cursor:pointer;border:1px solid var(--border,#333);background:var(--surface3,#2e2e2b);color:var(--text,#f0ede6)}',
    '#ait-ov .btn-p{background:var(--accent,#c8a96e);color:var(--bg,#0f0f0e);border-color:var(--accent,#c8a96e)}',
    '#ait-ov .btn-d{background:none;color:#e06b5a;border-color:#e06b5a55}',
    '#ait-ov .chips{display:flex;flex-wrap:wrap;gap:6px}',
    '#ait-ov .chip{font:inherit;font-size:11.5px;padding:5px 10px;border-radius:20px;border:1px dashed var(--border-light,#3d3d39);background:none;color:var(--text-muted,#888);cursor:pointer}',
    '#ait-ov .chip:hover{color:var(--text,#f0ede6);border-color:var(--accent,#c8a96e)}',
    '#ait-ov .check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;text-transform:none;letter-spacing:0;color:var(--text,#f0ede6);margin:10px 0 0;cursor:pointer}',
    '#ait-ov .check input{width:16px;height:16px;margin-top:1px;flex-shrink:0}',
    '#ait-ov .empty{font-size:13px;color:var(--text-muted,#888);padding:6px 0 10px}',
    '#ait-ov .ft{padding:12px 20px 18px;border-top:1px solid var(--border,#333);display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '#ait-ov .warn{color:#d4a843;font-size:12px}',
  ].join('\n');

  // ── data ──────────────────────────────────────────────────────────────
  async function loadListings() {
    if (S.listings.length) return S.listings;
    var r = await db.from('listing_registry').select('listing_id,nickname,title,concierge_name').eq('is_listed', true).order('nickname');
    S.listings = (r.data || []).map(function (l) { return { id: l.listing_id, label: (l.concierge_name || l.title || l.nickname) + (l.nickname ? ' (' + l.nickname + ')' : ''), keys: [l.nickname, l.title, l.concierge_name].map(norm) }; });
    return S.listings;
  }
  // Best guess for an unlinked card: name containment either way, then shared-word score
  function suggest(card) {
    var n = norm(card.name); if (!n) return null;
    var best = null, bestScore = 0;
    S.listings.forEach(function (l) {
      var score = 0;
      l.keys.forEach(function (k) { if (!k) return; if (k === n) score = Math.max(score, 100); else if (k.indexOf(n) >= 0 || n.indexOf(k) >= 0) score = Math.max(score, 60); });
      if (!score) {
        var words = String(card.name).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 3 && ['house', 'home', 'cabin', 'retreat', 'the'].indexOf(w) < 0; });
        words.forEach(function (w) { if (l.keys.some(function (k) { return k.indexOf(w) >= 0; })) score += 20; });
      }
      if (score > bestScore) { bestScore = score; best = l; }
    });
    return bestScore >= 20 ? best : null;
  }
  async function loadItems() {
    var q = db.from('guest_guide_items').select('*').order('sort').order('id');
    q = S.scope === 'all' ? q.is('listing_id', null) : q.eq('listing_id', S.card.listing_id);
    var r = await q;
    if (r.error) { toast('Couldn’t load AI training: ' + r.error.message, 'error'); S.items = []; return; }
    S.items = r.data || [];
  }
  async function me() { try { return (await db.auth.getUser()).data.user.email; } catch (e) { return null; } }

  // ── render ────────────────────────────────────────────────────────────
  function render() {
    var c = S.card, linked = c.listing_id && S.listings.find(function (l) { return l.id === c.listing_id; });
    var sug = !c.listing_id ? suggest(c) : null;
    var opts = '<option value="">— Choose the Guesty listing —</option>' + S.listings.map(function (l) {
      var sel = (c.listing_id ? l.id === c.listing_id : sug && l.id === sug.id) ? ' selected' : '';
      return '<option value="' + E(l.id) + '"' + sel + '>' + E(l.label) + '</option>'; }).join('');
    var html = '<div class="bx" role="dialog" aria-label="AI training">' +
      '<div class="hd"><div><h2>&#129302; AI Training — ' + E(c.name) + '</h2><div class="s">What the guest Concierge (Home Guide + AI chat) is allowed to know about this home.</div></div><button class="x" data-a="close" aria-label="Close">&times;</button></div>' +
      '<div class="sec"><div class="note">This is the <b>only</b> home-specific information the guest AI can use, together with the public Guesty listing description. The rest of this property card — door code, supply/garage codes, stocking notes, photos — stays team-only. Mark door codes and Wi-Fi <b>Sensitive</b>: guests and the AI only get those from the start of check-in day.</div>' +
      '<label>Linked Guesty listing</label><div class="row"><select id="ait-listing" style="flex:1;min-width:220px;">' + opts + '</select><button class="btn-s btn-p" data-a="link">' + (c.listing_id ? 'Update link' : 'Link') + '</button></div>' +
      (!c.listing_id ? '<div class="warn" style="margin-top:6px;">' + (sug ? 'Suggested match selected — confirm with Link.' : 'Pick the listing this card belongs to.') + '</div>' : '') +
      '<div class="tabs"><button class="tab' + (S.scope === 'home' ? ' on' : '') + '" data-a="scope-home">This home</button><button class="tab' + (S.scope === 'all' ? ' on' : '') + '" data-a="scope-all">All homes</button></div>' +
      '</div>';
    if (S.scope === 'home' && !c.listing_id) {
      html += '<div class="sec"><div class="empty">Link this card to its Guesty listing to start training the AI for this home.</div></div>';
    } else {
      html += '<div class="sec" style="padding-top:0;">' +
        (S.scope === 'all' ? '<div class="empty" style="padding-top:0;">Company-wide items apply to every home (e.g. how to reach us, general troubleshooting). Don\'t put any home\'s codes here.</div>' : '') +
        '<div id="ait-list">' + (S.items.length ? S.items.map(itemHtml).join('') : '<div class="empty">Nothing yet — add an item or start from a template below.</div>') + '</div>' +
        '<div id="ait-form-wrap"></div>' +
        '<div class="row" style="margin-top:10px;"><button class="btn-s btn-p" data-a="new">+ Add item</button></div>' +
        (S.scope === 'home' ? '<label style="margin-top:14px;">Quick-start templates</label><div class="chips">' + TEMPLATES.map(function (t, i) { return '<button class="chip" data-a="tpl" data-i="' + i + '">' + E(t.title) + '</button>'; }).join('') + '</div>' : '') +
        '</div>';
    }
    html += '<div class="ft"><span class="empty" style="padding:0;">' + S.items.filter(function (x) { return x.active; }).length + ' active item(s) the AI can use' + (S.scope === 'all' ? ' across all homes' : '') + '</span><button class="btn-s" data-a="close">Done</button></div></div>';
    $('ait-ov').innerHTML = html;
  }
  function itemHtml(x) {
    return '<div class="item' + (x.active ? '' : ' off') + '" data-id="' + E(x.id) + '"><div class="row" style="justify-content:space-between;align-items:flex-start;"><div style="flex:1;min-width:0;">' +
      '<div><span class="tag">' + E(x.section) + '</span>' + (x.sensitive ? '<span class="tag sens">Sensitive · check-in day</span>' : '') + (x.active ? '' : '<span class="tag">Hidden</span>') + '</div>' +
      '<div class="t" style="margin-top:4px;">' + E(x.title) + '</div><div class="b">' + E(x.body) + '</div></div>' +
      '<div class="row" style="flex-shrink:0;"><button class="btn-s" data-a="edit">Edit</button></div></div></div>';
  }
  function formHtml(x) {
    x = x || { section: 'General', title: '', body: '', sensitive: false, active: true };
    var secs = SECTIONS.indexOf(x.section) >= 0 ? SECTIONS : SECTIONS.concat([x.section]);
    return '<div class="item" id="ait-form" data-edit="' + E(x.id || '') + '">' +
      '<div class="row"><div style="flex:1;min-width:150px;"><label style="margin-top:0;">Section</label><select data-f="section">' + secs.map(function (s) { return '<option' + (s === x.section ? ' selected' : '') + '>' + E(s) + '</option>'; }).join('') + '</select></div>' +
      '<div style="flex:2;min-width:200px;"><label style="margin-top:0;">Title</label><input data-f="title" maxlength="120" value="' + E(x.title) + '" placeholder="e.g. Breaker panel"></div></div>' +
      '<label>What guests / the AI should know</label><textarea data-f="body" maxlength="4000" placeholder="Write it the way you\'d explain it to a guest.">' + E(x.body) + '</textarea>' +
      '<label class="check"><input type="checkbox" data-f="sensitive"' + (x.sensitive ? ' checked' : '') + '><span>Sensitive (door codes, Wi-Fi, lockbox) — only released from the start of check-in day</span></label>' +
      '<label class="check"><input type="checkbox" data-f="active"' + (x.active ? ' checked' : '') + '><span>Active (uncheck to hide without deleting)</span></label>' +
      '<div class="row" style="margin-top:10px;justify-content:space-between;"><div>' + (x.id ? '<button class="btn-s btn-d" data-a="del">Delete</button>' : '') + '</div>' +
      '<div class="row"><button class="btn-s" data-a="cancel">Cancel</button><button class="btn-s btn-p" data-a="save">Save</button></div></div></div>';
  }
  function showForm(x) { $('ait-form-wrap').innerHTML = formHtml(x); var t = $('ait-form').querySelector('[data-f="title"]'); if (t) t.focus(); $('ait-form').scrollIntoView({ block: 'nearest' }); }

  // Light guard: codes belong in Sensitive items so they aren't released early.
  function looksSecret(text) { return /\b(code|password|passcode|pin|wifi|wi-fi|lockbox|keypad)\b/i.test(text) && /\b[\dA-Z]{4,}\b/.test(text); }

  // ── actions ───────────────────────────────────────────────────────────
  async function onClick(e) {
    if (e.target === $('ait-ov')) return close();
    var b = e.target.closest('[data-a]'); if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'close') return close();
    if (a === 'scope-home' || a === 'scope-all') { S.scope = a === 'scope-all' ? 'all' : 'home'; if (S.scope === 'all' || S.card.listing_id) await loadItems(); else S.items = []; return render(); }
    if (a === 'link') {
      var lid = $('ait-listing').value; if (!lid) return toast('Choose a listing first.', 'error');
      var taken = (window.propertyCards || []).find(function (pc) { return pc.listing_id === lid && pc.id !== S.card.id; });
      if (taken && !confirm('“' + taken.name + '” is already linked to that listing. Link this card too?')) return;
      var r = await db.from('property_cards').update({ listing_id: lid }).eq('id', S.card.id);
      if (r.error) return toast('Couldn’t link: ' + r.error.message, 'error');
      S.card.listing_id = lid; var pc = (window.propertyCards || []).find(function (x) { return x.id === S.card.id; }); if (pc) pc.listing_id = lid;
      toast('Linked to Guesty listing.', 'success'); await loadItems(); render(); decorate(); return;
    }
    if (a === 'new') return showForm();
    if (a === 'tpl') return showForm(Object.assign({ active: true }, TEMPLATES[+b.getAttribute('data-i')]));
    if (a === 'edit') { var it = S.items.find(function (x) { return String(x.id) === b.closest('.item').getAttribute('data-id'); }); return showForm(it); }
    if (a === 'cancel') { $('ait-form-wrap').innerHTML = ''; return; }
    if (a === 'del') {
      var did = $('ait-form').getAttribute('data-edit'); if (!did || !confirm('Delete this item? The AI will stop using it immediately.')) return;
      var rd = await db.from('guest_guide_items').delete().eq('id', Number(did));
      if (rd.error) return toast('Delete failed: ' + rd.error.message, 'error');
      await loadItems(); render(); decorate(); return;
    }
    if (a === 'save') {
      var f = $('ait-form'), get = function (k) { return f.querySelector('[data-f="' + k + '"]'); };
      var row = { section: get('section').value, title: get('title').value.trim(), body: get('body').value.trim(), sensitive: get('sensitive').checked, active: get('active').checked, updated_by: await me(), updated_at: new Date().toISOString() };
      if (!row.title || !row.body) return toast('Add a title and the details.', 'error');
      if (!row.sensitive && looksSecret(row.title + ' ' + row.body) && !confirm('This looks like it contains a code or password. Save it as NOT sensitive (visible to guests up to 48h before check-in)?\n\nClick Cancel, then tick “Sensitive”, to release it only on check-in day.')) return;
      if (S.scope === 'all' && looksSecret(row.title + ' ' + row.body) && !confirm('This applies to ALL homes. Are you sure it should include a code or password?')) return;
      var eid = f.getAttribute('data-edit'), res;
      if (eid) res = await db.from('guest_guide_items').update(row).eq('id', Number(eid));
      else { row.listing_id = S.scope === 'all' ? null : S.card.listing_id; row.sort = (S.items.length + 1) * 10; res = await db.from('guest_guide_items').insert(row); }
      if (res.error) return toast('Save failed: ' + res.error.message, 'error');
      toast('Saved — the AI uses this right away.', 'success'); await loadItems(); render(); decorate(); return;
    }
  }

  // ── open / close ──────────────────────────────────────────────────────
  function ensureDom() {
    if ($('ait-ov')) return;
    var st = document.createElement('style'); st.id = 'ait-css'; st.textContent = CSS; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.id = 'ait-ov'; document.body.appendChild(ov);
    ov.addEventListener('click', onClick);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
  }
  async function open(cardId) {
    ensureDom();
    var c = (window.propertyCards || []).find(function (x) { return String(x.id) === String(cardId); }); if (!c) return;
    S.card = { id: c.id, name: c.name, listing_id: c.listing_id || null }; S.scope = 'home'; S.items = [];
    $('ait-ov').innerHTML = '<div class="bx"><div class="sec">Loading…</div></div>'; $('ait-ov').classList.add('open');
    try { await loadListings(); if (S.card.listing_id) await loadItems(); } catch (e) { toast('Couldn’t load: ' + e.message, 'error'); }
    render();
  }
  function close() { var o = $('ait-ov'); if (o) o.classList.remove('open'); }

  // ── add the button to every staff property card ───────────────────────
  var counts = {}, countsAt = 0;
  async function refreshCounts() {
    if (Date.now() - countsAt < 15000) return; countsAt = Date.now();
    var r = await db.from('guest_guide_items').select('listing_id').eq('active', true);
    counts = {}; (r.data || []).forEach(function (x) { if (x.listing_id) counts[x.listing_id] = (counts[x.listing_id] || 0) + 1; });
  }
  function decorate() {
    var grid = $('propertyCardGrid'); if (!grid || typeof propertyCards === 'undefined') return;
    ensureDom();
    var cards = grid.querySelectorAll('.prop-cleaning-card');
    cards.forEach(function (el, i) {
      var c = window.propertyCards[i]; if (!c) return;
      var btn = el.querySelector('.ait-btn');
      if (!btn) { btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ait-btn'; el.appendChild(btn); }
      btn.setAttribute('data-card', c.id);
      var n = c.listing_id ? (counts[c.listing_id] || 0) : null;
      btn.innerHTML = '&#129302; AI Training <span class="n">' + (n == null ? '· not linked' : '· ' + n + ' item' + (n === 1 ? '' : 's')) + '</span>';
      btn.onclick = function (ev) { ev.stopPropagation(); open(c.id); };
    });
  }
  function boot() {
    if (typeof db === 'undefined') return;
    // propertyCards is a top-level `var` in index.html, so it's on window.
    var hook = function () {
      var grid = $('propertyCardGrid'); if (!grid || grid.__aitObserved) return !!grid;
      grid.__aitObserved = true;
      new MutationObserver(function (muts) { if (muts.some(function (m) { return m.addedNodes.length; })) { refreshCounts().then(decorate); decorate(); } }).observe(grid, { childList: true });
      refreshCounts().then(decorate);
      return true;
    };
    if (!hook()) { var t = 0, iv = setInterval(function () { if (hook() || ++t > 60) clearInterval(iv); }, 1000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.PropDeskAITraining = { open: open };
})();
