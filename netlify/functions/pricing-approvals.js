// netlify/functions/pricing-approvals.js
//
// Approvals for pricing / min-stay proposals on listings that are NOT tagged "Black Cabins"
// (those are applied automatically by autopilot-background). Staff only.
//   POST { action: 'approve', ids: [...] }  → pushes the overrides to PriceLabs, logs an undoable edit
//   POST { action: 'reject',  ids: [...] }
// A proposal can only be approved while its stay date is today or later, and never onto a date
// that has since received a manual override in PriceLabs.

const { requireTeam, SUPABASE_URL, PUBLISHABLE_KEY } = require('../lib/auth');
const I = require('../lib/intel');
const A = require('../lib/autopilot-apply');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function whoAmI(event) {
  try {
    const tok = String((event.headers.authorization || event.headers.Authorization || '')).replace(/^Bearer\s+/i, '');
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + tok } });
    const u = await r.json();
    return u.email || 'staff';
  } catch (e) { return 'staff'; }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!(await requireTeam(event, ['staff']))) return reply(401, { error: 'Not authorized' });
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Invalid JSON' }); }
  const ids = (b.ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return reply(400, { error: 'ids required' });
  const who = await whoAmI(event);
  const today = I.today();

  try {
    const rows = await I.sbSelect('pricing_proposals', `select=*&id=in.(${ids.join(',')})&status=eq.pending`);
    if (b.action === 'reject') {
      if (rows.length) await I.sbPatch('pricing_proposals', `id=in.(${rows.map((r) => r.id).join(',')})`, { status: 'rejected', decided_by: who, decided_at: new Date().toISOString() });
      return reply(200, { ok: true, rejected: rows.length });
    }
    if (b.action !== 'approve') return reply(400, { error: 'Unknown action' });

    const live = rows.filter((r) => r.stay_date >= today);
    const stale = rows.filter((r) => r.stay_date < today);
    if (stale.length) await I.sbPatch('pricing_proposals', `id=in.(${stale.map((r) => r.id).join(',')})`, { status: 'expired' });
    const plMap = await A.plListingMap();
    const out = { applied: 0, failed: 0, expired: stale.length, errors: [] };
    const byListing = {};
    live.forEach((r) => { (byListing[r.listing_id] = byListing[r.listing_id] || []).push(r); });

    for (const lid of Object.keys(byListing)) {
      const p = plMap[String(lid)];
      if (!p) { out.errors.push(`${lid}: not in PriceLabs`); continue; }
      const pms = p.pms || 'guesty';
      const oursRows = await I.sbSelect('autopilot_overrides', `select=*&listing_id=eq.${encodeURIComponent(lid)}&active=eq.true&stay_date=gte.${today}`).catch(() => []);
      const ours = {}; oursRows.forEach((o) => { ours[o.stay_date] = { ...o, price: num(o.price), original_price: num(o.original_price) }; });
      // Skip any date someone has since overridden by hand in PriceLabs.
      let list = byListing[lid];
      try {
        const foreign = new Set((await A.getOverrides(lid, pms)).filter((o) => !ours[o.date]).map((o) => o.date));
        const blocked = list.filter((r) => foreign.has(r.stay_date));
        if (blocked.length) {
          await I.sbPatch('pricing_proposals', `id=in.(${blocked.map((r) => r.id).join(',')})`, { status: 'failed', error: 'Date now has a manual PriceLabs override — left untouched.', decided_by: who, decided_at: new Date().toISOString() });
          out.failed += blocked.length;
          list = list.filter((r) => !foreign.has(r.stay_date));
        }
      } catch (e) { out.errors.push(`Couldn't check existing overrides for ${lid}: ${e.message.slice(0, 120)}`); }
      if (!list.length) continue;
      const r = await A.applyProposals(lid, list, { who, auto: false, pms, ours });
      out.applied += r.applied.length; out.failed += r.failed.length;
    }
    return reply(200, { ok: true, ...out });
  } catch (e) {
    console.error('pricing-approvals', e.message);
    return reply(500, { error: e.message });
  }
};
