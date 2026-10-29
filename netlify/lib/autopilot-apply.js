// netlify/lib/autopilot-apply.js
// Pushes approved / auto-approved pricing proposals to PriceLabs as date-specific overrides
// (DSOs), records them, and logs a listing_edits row so the change can be undone in one tap.
// Used by autopilot-background (Black Cabins, automatic) and pricing-approvals (everyone else,
// after a person approves).

const I = require('./intel');

const PL = 'https://api.pricelabs.co';

async function plRaw(method, path, body) {
  const res = await fetch(PL + path, {
    method,
    headers: { 'X-API-Key': process.env.PRICE_LABS_SECRET, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  if (!res.ok) { const e = new Error(`PriceLabs ${method} ${path.split('?')[0]} ${res.status}: ${raw.slice(0, 300)}`); e.status = res.status; throw e; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

const dsoPath = (lid) => `/v1/listings/${encodeURIComponent(lid)}/overrides`;

async function getOverrides(lid, pms) {
  const r = await plRaw('GET', `${dsoPath(lid)}?pms=${encodeURIComponent(pms)}`);
  const list = (r && (r.overrides || r.data || (Array.isArray(r) ? r : []))) || [];
  return list.map((o) => ({ ...o, date: String(o.date || o.override_date || '').slice(0, 10) })).filter((o) => o.date);
}

// One DSO object. Always a FIXED nightly price: when only the minimum stay changes, the date
// keeps the price it has right now (explicit and predictable — never a relative adjustment).
function toOverride(date, price, minStay) {
  if (price == null || !(Number(price) > 0)) throw new Error(`No price available for ${date}`);
  const o = { date, price: String(Math.round(Number(price))), price_type: 'fixed', currency: 'USD' };
  if (minStay != null) o.min_stay = Number(minStay);
  o.reason = 'PropDesk autopilot';
  return o;
}

async function postOverrides(lid, pms, overrides) { return plRaw('POST', dsoPath(lid), { pms, overrides, update_children: false }); }
async function deleteOverrides(lid, pms, dates) { return plRaw('DELETE', dsoPath(lid), { pms, overrides: dates.map((date) => ({ date })), update_children: false }); }

let _plMap = null;
async function plListingMap() {
  if (_plMap) return _plMap;
  const pl = await I.plGet('/v1/listings');
  const arr = pl.listings || pl.data || (Array.isArray(pl) ? pl : []);
  _plMap = {}; arr.forEach((p) => { _plMap[String(p.id)] = p; });
  return _plMap;
}

const money = (v) => (v == null ? '—' : '$' + Math.round(v));

// proposals: rows from pricing_proposals for ONE listing (status pending)
// ours: { [date]: autopilot_overrides row } currently active for this listing
async function applyProposals(lid, proposals, { who, auto, pms, ours, nickname, label }) {
  ours = ours || {};
  const sets = proposals.filter((p) => p.kind === 'set');
  const removes = proposals.filter((p) => p.kind === 'remove');
  const now = new Date().toISOString();
  const result = { applied: [], failed: [] };

  const fail = async (rows, err) => {
    result.failed.push(...rows.map((r) => r.id));
    if (rows.length) await I.sbPatch('pricing_proposals', `id=in.(${rows.map((r) => r.id).join(',')})`, { status: 'failed', error: String(err).slice(0, 500), decided_by: who, decided_at: now }).catch(() => {});
  };

  let okSets = [], okRemoves = [];
  if (sets.length) {
    try { await postOverrides(lid, pms, sets.map((p) => toOverride(p.stay_date, p.proposed_price != null ? p.proposed_price : p.current_price, p.proposed_min_stay))); okSets = sets; }
    catch (e) { await fail(sets, e.message); }
  }
  if (removes.length) {
    try { await deleteOverrides(lid, pms, removes.map((p) => p.stay_date)); okRemoves = removes; }
    catch (e) { await fail(removes, e.message); }
  }
  const done = okSets.concat(okRemoves);
  if (!done.length) return result;

  // Undo record: "before" holds what each date looked like, including any autopilot override.
  const before = done.map((p) => ({ date: p.stay_date, price: p.current_price, min_stay: p.current_min_stay, ours: ours[p.stay_date] ? { price: ours[p.stay_date].price, min_stay: ours[p.stay_date].min_stay, original_price: ours[p.stay_date].original_price, original_min_stay: ours[p.stay_date].original_min_stay, source: ours[p.stay_date].source || 'autopilot' } : null }));
  const after = done.map((p) => ({ date: p.stay_date, removed: p.kind === 'remove', price: p.proposed_price, min_stay: p.proposed_min_stay }));
  const priceN = okSets.filter((p) => p.proposed_price != null).length, msN = okSets.filter((p) => p.proposed_min_stay != null).length;
  const parts = [];
  if (priceN) parts.push(`${priceN} date price${priceN > 1 ? 's' : ''} (e.g. ${okSets.find((p) => p.proposed_price != null).stay_date.slice(5)} ${money(okSets.find((p) => p.proposed_price != null).current_price)}→${money(okSets.find((p) => p.proposed_price != null).proposed_price)})`);
  if (msN) parts.push(`${msN} min-stay change${msN > 1 ? 's' : ''}`);
  if (okRemoves.length) parts.push(`${okRemoves.length} override${okRemoves.length > 1 ? 's' : ''} removed`);
  const [edit] = await I.sbInsert('listing_edits', [{
    listing_id: lid, target: 'pricelabs_dso',
    summary: (label ? label + ': ' : auto ? 'Autopilot: ' : 'Approved pricing: ') + parts.join(', '),
    before: { dates: before }, after: { dates: after }, edited_by: auto ? (who || 'autopilot') : who,
  }]);

  await I.sbPatch('pricing_proposals', `id=in.(${done.map((r) => r.id).join(',')})`, { status: 'applied', applied_at: now, edit_id: edit.id, decided_by: auto ? (who || 'autopilot') : who, decided_at: now });
  const upserts = okSets.map((p) => ({
    listing_id: lid, stay_date: p.stay_date, active: true, proposal_id: p.id, updated_at: now,
    original_price: p.original_price, original_min_stay: p.original_min_stay, price: p.proposed_price, min_stay: p.proposed_min_stay, outcome: null,
    source: p.source || 'autopilot', // 'agent' overrides are left alone by the daily autopilot
  })).concat(okRemoves.map((p) => ({
    listing_id: lid, stay_date: p.stay_date, active: false, proposal_id: p.id, updated_at: now,
    original_price: p.original_price, original_min_stay: p.original_min_stay, price: null, min_stay: null, outcome: null,
    source: p.source || 'autopilot',
  })));
  await I.sbUpsert('autopilot_overrides', upserts, 'listing_id,stay_date');
  result.applied = done.map((r) => r.id);
  result.edit_id = edit.id;
  return result;
}

// Undo a 'pricelabs_dso' listing_edits row: restore each date to how it was before.
async function revertDsoEdit(e, pms) {
  const dates = (e.before && e.before.dates) || [];
  const restore = dates.filter((d) => d.ours);
  const drop = dates.filter((d) => !d.ours).map((d) => d.date);
  if (restore.length) await postOverrides(e.listing_id, pms, restore.map((d) => toOverride(d.date, d.ours.price != null ? d.ours.price : d.price, d.ours.min_stay)));
  if (drop.length) await deleteOverrides(e.listing_id, pms, drop);
  const now = new Date().toISOString();
  const rows = restore.map((d) => ({ listing_id: e.listing_id, stay_date: d.date, active: true, price: d.ours.price, min_stay: d.ours.min_stay, original_price: d.ours.original_price, original_min_stay: d.ours.original_min_stay, source: d.ours.source || 'autopilot', updated_at: now }))
    .concat(drop.map((date) => ({ listing_id: e.listing_id, stay_date: date, active: false, price: null, min_stay: null, source: 'autopilot', updated_at: now })));
  if (rows.length) await I.sbUpsert('autopilot_overrides', rows, 'listing_id,stay_date');
  await I.sbPatch('pricing_proposals', `edit_id=eq.${e.id}`, { status: 'reverted' }).catch(() => {});
}

module.exports = { getOverrides, postOverrides, deleteOverrides, toOverride, plListingMap, applyProposals, revertDsoEdit };
