// netlify/functions/listing-workspace.js
//
// Property Workspace API (staff only). POST JSON { action, listing_id, ... }
//
//   get                → live Guesty content (title + publicDescription sections) and amenities
//   update_content     → { fields: { title?, summary?, space?, access?, interactionWithGuests?,
//                          neighborhood?, transit?, notes?, houseRules? } }  PUT /v1/listings/{id}
//   update_amenities   → { add: [..], remove: [..] }  PUT /v1/properties-api/amenities/{id}
//   update_pricelabs   → { base?, min?, max? }  POST PriceLabs /v1/listings
//   revert             → { edit_id }  re-applies the logged "before" values
//   rank_now           → live PriceLabs Listing Optimizer ranking + per-date diagnosis
//
// Every change goes live immediately (Guesty syncs to Airbnb/Vrbo) and is written to
// listing_edits with before/after so it can be undone in one click.

const { requireTeam, SUPABASE_URL, PUBLISHABLE_KEY } = require('../lib/auth');
const I = require('../lib/intel');
const { diagnose } = require('../lib/rankdiag');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const SECTIONS = ['summary', 'space', 'access', 'interactionWithGuests', 'neighborhood', 'transit', 'notes', 'houseRules'];

async function whoAmI(event) {
  try {
    const tok = String((event.headers.authorization || event.headers.Authorization || '')).replace(/^Bearer\s+/i, '');
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + tok } });
    const u = await r.json();
    return u.email || 'staff';
  } catch (e) { return 'staff'; }
}

async function guestyWrite(method, path, body) {
  const token = await I.guestyToken();
  const res = await fetch('https://open-api.guesty.com' + path, {
    method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) { const e = new Error(`Guesty ${res.status}: ${raw.slice(0, 300)}`); e.status = res.status; e.raw = raw; throw e; }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

async function getContent(lid) {
  const l = await I.guestyGet(`/v1/listings/${lid}?fields=${encodeURIComponent('_id title nickname publicDescription accommodates bedrooms bathrooms propertyType roomType defaultCheckInTime defaultCheckOutTime amenities terms')}`);
  const pd = l.publicDescription || {};
  const content = { title: l.title || '' };
  SECTIONS.forEach((k) => { content[k] = pd[k] || ''; });
  let amenities = null;
  try { amenities = await I.guestyGet(`/v1/properties-api/amenities/${lid}`); }
  catch (e) { amenities = { amenities: l.amenities || [], otherAmenities: [], note: 'from listing object: ' + e.message.slice(0, 120) }; }
  return {
    content, amenities: { supported: amenities.amenities || [], other: amenities.otherAmenities || [] },
    facts: { nickname: l.nickname, accommodates: l.accommodates, bedrooms: l.bedrooms, bathrooms: l.bathrooms, propertyType: l.propertyType, roomType: l.roomType, checkIn: l.defaultCheckInTime, checkOut: l.defaultCheckOutTime, minNights: l.terms && l.terms.minNights },
  };
}

async function applyContent(lid, fields) {
  const body = {};
  if (fields.title != null) body.title = String(fields.title).slice(0, 50);
  const pd = {};
  SECTIONS.forEach((k) => { if (fields[k] != null) pd[k] = String(fields[k]); });
  if (Object.keys(pd).length) body.publicDescription = pd;
  if (!Object.keys(body).length) throw new Error('Nothing to update');
  try { return await guestyWrite('PUT', `/v1/listings/${lid}`, body); }
  catch (e) {
    // Some accounts reject `title` on this endpoint — retry without it and say so.
    if (body.title != null && e.status === 400 && /title/i.test(e.raw || '')) {
      delete body.title;
      if (!body.publicDescription) throw new Error('Guesty would not accept a title change through the API for this listing. Update the title in Guesty directly.');
      await guestyWrite('PUT', `/v1/listings/${lid}`, body);
      const w = new Error('Description saved, but Guesty rejected the title change via API — update the title in Guesty.'); w.partial = true; throw w;
    }
    throw e;
  }
}

async function plCurrent(lid) {
  const pl = await I.plGet('/v1/listings');
  const arr = pl.listings || pl.data || (Array.isArray(pl) ? pl : []);
  const p = arr.find((x) => String(x.id) === String(lid));
  if (!p) throw new Error('Listing not found in PriceLabs');
  return p;
}

async function logEdit(row) { const [r] = await I.sbInsert('listing_edits', [row]); return r; }

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!(await requireTeam(event, ['staff']))) return reply(401, { error: 'Not authorized' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Invalid JSON' }); }
  const lid = b.listing_id;
  if (!lid) return reply(400, { error: 'listing_id required' });
  const who = await whoAmI(event);

  try {
    if (b.action === 'get') {
      const data = await getContent(lid);
      return reply(200, data);
    }

    if (b.action === 'update_content') {
      const before = await getContent(lid);
      const fields = {};
      Object.keys(b.fields || {}).forEach((k) => { if ((k === 'title' || SECTIONS.includes(k)) && String(b.fields[k]) !== String(before.content[k] || '')) fields[k] = b.fields[k]; });
      if (!Object.keys(fields).length) return reply(200, { ok: true, unchanged: true });
      const beforeVals = {}; Object.keys(fields).forEach((k) => { beforeVals[k] = before.content[k] || ''; });
      try {
        await applyContent(lid, fields);
        const edit = await logEdit({ listing_id: lid, target: 'guesty_content', summary: 'Updated ' + Object.keys(fields).join(', '), before: beforeVals, after: fields, edited_by: who });
        return reply(200, { ok: true, edit });
      } catch (e) {
        await logEdit({ listing_id: lid, target: 'guesty_content', summary: 'Failed update ' + Object.keys(fields).join(', '), before: beforeVals, after: fields, status: e.partial ? 'applied' : 'failed', error: e.message.slice(0, 500), edited_by: who });
        return reply(e.partial ? 200 : 502, { ok: !!e.partial, warning: e.partial ? e.message : undefined, error: e.partial ? undefined : e.message });
      }
    }

    if (b.action === 'update_amenities') {
      const cur = await getContent(lid);
      const before = cur.amenities.supported.concat(cur.amenities.other);
      const add = (b.add || []).map(String).filter(Boolean);
      const remove = new Set((b.remove || []).map((x) => String(x).toLowerCase()));
      const next = Array.from(new Set(before.filter((a) => !remove.has(a.toLowerCase())).concat(add)));
      const res = await guestyWrite('PUT', `/v1/properties-api/amenities/${lid}`, { amenities: next });
      const notMapped = add.filter((a) => (res.otherAmenities || []).some((o) => o.toLowerCase() === a.toLowerCase()));
      const edit = await logEdit({ listing_id: lid, target: 'guesty_amenities', summary: (add.length ? 'Added ' + add.join(', ') : '') + (remove.size ? ' Removed ' + Array.from(remove).join(', ') : ''), before: { amenities: before }, after: { amenities: next }, edited_by: who });
      return reply(200, { ok: true, edit, result: res, not_standard: notMapped });
    }

    if (b.action === 'update_pricelabs') {
      const p = await plCurrent(lid);
      const upd = { id: String(p.id), pms: p.pms || 'guesty' };
      const before = {}, after = {};
      ['base', 'min', 'max'].forEach((k) => { if (b[k] != null && b[k] !== '') { const v = Math.round(Number(b[k])); if (!isFinite(v) || v <= 0) throw new Error(`Invalid ${k}`); upd[k] = v; before[k] = Number(p[k]); after[k] = v; } });
      if (!Object.keys(after).length) return reply(400, { error: 'Nothing to update' });
      const mn = after.min != null ? after.min : Number(p.min), mx = after.max != null ? after.max : Number(p.max), bs = after.base != null ? after.base : Number(p.base);
      if (mn && bs && mn > bs) throw new Error('Minimum price cannot be above base price');
      if (mx && bs && mx < bs) throw new Error('Maximum price cannot be below base price');
      const res = await I.plPost('/v1/listings', { listings: [upd] });
      const edit = await logEdit({ listing_id: lid, target: 'pricelabs', summary: 'PriceLabs ' + Object.keys(after).map((k) => `${k} ${before[k]}→${after[k]}`).join(', '), before, after, edited_by: who });
      return reply(200, { ok: true, edit, result: res });
    }

    if (b.action === 'revert') {
      const rows = await I.sbSelect('listing_edits', `id=eq.${Number(b.edit_id)}&listing_id=eq.${encodeURIComponent(lid)}&select=*`);
      const e = rows[0];
      if (!e) return reply(404, { error: 'Edit not found' });
      if (e.status !== 'applied') return reply(400, { error: 'Only applied edits can be undone' });
      if (e.target === 'guesty_content') await applyContent(lid, e.before || {});
      else if (e.target === 'guesty_amenities') await guestyWrite('PUT', `/v1/properties-api/amenities/${lid}`, { amenities: (e.before && e.before.amenities) || [] });
      else if (e.target === 'pricelabs_dso') { const p = await plCurrent(lid); await require('../lib/autopilot-apply').revertDsoEdit(e, p.pms || 'guesty'); }
      else if (e.target === 'pricelabs') { const p = await plCurrent(lid); await I.plPost('/v1/listings', { listings: [{ id: String(p.id), pms: p.pms || 'guesty', ...e.before }] }); }
      await I.sbPatch('listing_edits', `id=eq.${e.id}`, { status: 'reverted', reverted_at: new Date().toISOString() });
      const undo = await logEdit({ listing_id: lid, target: e.target === 'pricelabs_dso' ? 'pricelabs_dso_undo' : e.target, summary: 'Undid: ' + (e.summary || ''), before: e.after, after: e.before, revert_of: e.id, edited_by: who, ...(e.target === 'pricelabs_dso' ? { status: 'reverted' } : {}) });
      return reply(200, { ok: true, edit: undo });
    }

    if (b.action === 'rank_now') {
      const reg = await I.sbSelect('listing_registry', `listing_id=eq.${encodeURIComponent(lid)}&select=airbnb_listing_id,bedrooms`);
      let airbnbId = reg[0] && reg[0].airbnb_listing_id;
      let p = null;
      try { p = await plCurrent(lid); } catch (e) { /* not in PriceLabs */ }
      if (!airbnbId && p) airbnbId = ((p.channel_listing_details || []).find((c) => c.channel_name === 'airbnb') || {}).channel_listing_id;
      if (!airbnbId) return reply(400, { error: 'No Airbnb listing ID found for this listing' });
      const r = await I.plGet(`/v1/listing_optimizer/ranking?listing_id=${encodeURIComponent(airbnbId)}${b.guest_count ? '&guest_count=' + Number(b.guest_count) : ''}`);
      const d = r.data || r;
      // live diagnosis: our calendar + market percentiles for each date
      let cal = null, nd = null, diag = null, optimizer = null;
      const day = I.today();
      if (p) {
        const pms = p.pms || 'guesty';
        try { const lp = await I.plPost('/v1/listing_prices', { listings: [{ id: String(p.id), pms, dateFrom: day, dateTo: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) }] }); cal = (Array.isArray(lp) ? lp : (lp.data || []))[0] || null; } catch (e) { /* optional */ }
        try { nd = await I.plGet(`/v1/neighborhood_data?listing_id=${encodeURIComponent(lid)}&pms=${encodeURIComponent(pms)}`); } catch (e) { /* optional */ }
      }
      try { const oi = await I.sbSelect('pricelabs_intel', `listing_id=eq.${encodeURIComponent(lid)}&select=optimizer&order=snapshot_date.desc&limit=1`); optimizer = oi[0] && oi[0].optimizer; } catch (e) { /* optional */ }
      try {
        diag = diagnose({ ranking: r, calendar: cal, neighborhood: nd, bedrooms: reg[0] && reg[0].bedrooms, optimizer, today: day });
        if (diag.rows.length) await I.sbUpsert('listing_rank_dates', diag.rows.map((x) => ({ listing_id: lid, snapshot_date: day, ...x })), 'listing_id,snapshot_date,stay_date,guest_count,los');
      } catch (e) { console.warn('rank diagnosis', e.message); }
      const segs = ((d.current_rankings || {}).segments || []).map((s) => ({
        guest_count: s.guest_count, los: s.los,
        dates: Object.keys(s.dates || {}).sort().slice(0, 60).map((k) => ({ date: k, rank: s.dates[k].rank === 999 ? null : s.dates[k].rank, not_shown: s.dates[k].rank === 999, page: s.dates[k].page, price: s.dates[k].price })),
      }));
      return reply(200, { airbnb_id: airbnbId, updated_at: (d.current_rankings || {}).updated_at, best_rank: (d.current_rankings || {}).current_rank_min, neighborhood_count: d.neighborhood_count, segments: segs, history: (d.ranking_history || []).slice(0, 4), diagnosis: diag && diag.summary, rows: diag ? diag.rows : [] });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('listing-workspace', b.action, e.message);
    return reply(500, { error: e.message });
  }
};

exports.getContent = getContent;
