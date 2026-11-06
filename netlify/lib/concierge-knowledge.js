// netlify/lib/concierge-knowledge.js
// What a verified guest (and the AI concierge acting for them) is allowed to know about ONE home.
//
// Sources — and ONLY these:
//   1. Guesty's guest-facing listing content (title, address, description sections, house rules,
//      amenities, check-in/out times) — the same things guests already see when they book.
//   2. guest_guide_items (PropDesk "AI Training" cards) staff wrote on purpose for guests (this
//      listing + company-wide). Items marked `sensitive` (door codes, Wi-Fi…) are NOT loaded until
//      the start of check-in day.
//   3. Each listing's Guesty custom fields for check-in instructions and door code — always treated
//      as sensitive (same release rule).
// Never used: property_cards / properties (team codes, owner contacts, contracts, cleaning notes).
// Rule: secrets that aren't allowed yet are never put in front of the AI, so it can't leak them.

const I = require('./intel');
const C = require('./concierge');

const LISTING_FIELDS = '_id title address publicDescription amenities defaultCheckInTime defaultCheckOutTime accommodates bedrooms bathrooms propertyType customFields';

// ── Guesty custom fields (check-in instructions + door code) ──────────────
// Matched by the field's display name in the account's custom-field list; override with
// GUESTY_CF_CHECKIN_ID / GUESTY_CF_DOORCODE_ID (Guesty custom field ids) if names ever change.
const RE_CHECKIN = /check[\s-]*in.*(instruction|info|direction|detail)|arrival.*(instruction|info)/i;
const RE_DOOR = /(door|entry|front|lock|keypad|access|gate|lockbox).*(code|pin|combo)|(code).*(door|entry|lock)/i;
let defsCache = null;
const diag = { errors: [] }; // field NAMES / ids / error codes only — never values
function note(where, e) { diag.errors.push(where + ': ' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 160)); diag.errors = diag.errors.slice(-6); }
function saveDiag() {
  if (!I.cacheSet) return;
  I.cacheSet('concierge_custom_fields', Object.assign({ at: new Date().toISOString() }, diag), 30 * 86400000).catch(() => {});
}
const listOf = (r) => (Array.isArray(r) ? r : (r && (r.data || r.results || r.customFields || r.fields)) || []);

// Guesty keeps the custom-field definitions on the account. Try the documented account route first,
// then the older top-level route; the first that answers wins.
async function customFieldDefs() {
  if (defsCache && Date.now() - defsCache.at < (defsCache.defs.all.length ? 60 : 5) * 60 * 1000) return defsCache.defs;
  let raw = [], source = null;
  try {
    const me = await I.guestyGet('/v1/accounts/me?fields=_id');
    const acc = me && (me._id || me.id || (me.data && me.data._id));
    if (acc) { raw = listOf(await I.guestyGet(`/v1/accounts/${encodeURIComponent(acc)}/custom-fields`)); source = 'accounts/{id}/custom-fields'; }
  } catch (e) { note('accounts custom-fields', e); }
  if (!raw.length) {
    try { raw = listOf(await I.guestyGet('/v1/custom-fields')); source = '/v1/custom-fields'; } catch (e) { note('/v1/custom-fields', e); }
  }
  const defs = raw.filter((d) => d && (!d.object || /listing/i.test(String(d.object))))
    .map((d) => ({ id: String(d._id || d.id || d.fieldId || ''), name: String(d.displayName || d.name || d.key || '') })).filter((d) => d.id);
  const pick = (envId, re, not) => (envId && defs.find((d) => d.id === envId)) || defs.find((d) => re.test(d.name) && !(not && not.test(d.name))) || (envId ? { id: envId, name: '(env)' } : null);
  const out = { checkin: pick(process.env.GUESTY_CF_CHECKIN_ID, RE_CHECKIN), door: pick(process.env.GUESTY_CF_DOORCODE_ID, RE_DOOR, RE_CHECKIN), all: defs.map((d) => d.name + ' [' + d.id + ']') };
  defsCache = { at: Date.now(), defs: out };
  Object.assign(diag, { source, listing_fields: out.all, checkin_field: out.checkin && out.checkin.name, door_code_field: out.door && out.door.name });
  saveDiag();
  return out;
}
// A listing's own custom-field values. Some accounts only return them from the dedicated route.
async function listingCustomFields(listingId, fromListing) {
  if (Array.isArray(fromListing) && fromListing.length) return fromListing;
  try { return listOf(await I.guestyGet(`/v1/listings/${encodeURIComponent(listingId)}/custom-fields`)); }
  catch (e) { note('listing custom-fields', e); return []; }
}
// match a listing's value entry to a field definition by id
function cfEntry(list, def) {
  if (!def || !Array.isArray(list)) return null;
  return list.find((x) => x && String(x.fieldId || x.customFieldId || x._id || x.id || '') === def.id) || null;
}
// fallback when the account field list couldn't be read: entries that carry their own name
function cfByName(list, re, not) {
  if (!Array.isArray(list)) return null;
  return list.find((x) => { const n = String((x && (x.displayName || x.name || x.key || (x.field && (x.field.displayName || x.field.name)))) || ''); return n && re.test(n) && !(not && not.test(n)); }) || null;
}
function cfText(f) {
  const v = f && (f.value != null ? f.value : f.fieldValue);
  return v == null ? '' : clip(Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v, 4000);
}
const cache = new Map(); // listingId -> { at, data }
const TTL = 10 * 60 * 1000;
const clip = (s, n) => (s == null ? '' : String(s).replace(/\s+\n/g, '\n').trim().slice(0, n));

function fmtTime(t) {
  if (!t) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  if (!m) return String(t);
  let h = parseInt(m[1], 10); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return h + (m[2] !== '00' ? ':' + m[2] : '') + ' ' + ap;
}

async function guestyListing(listingId) {
  const hit = cache.get(listingId);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const l = await I.guestyGet(`/v1/listings/${encodeURIComponent(listingId)}?fields=${encodeURIComponent(LISTING_FIELDS)}`);
  const pd = l.publicDescription || {};
  const data = {
    address: clip(l.address && (l.address.full || [l.address.street, l.address.city, l.address.state].filter(Boolean).join(', ')), 200),
    type: clip(l.propertyType, 40), bedrooms: l.bedrooms, bathrooms: l.bathrooms, sleeps: l.accommodates,
    check_in_time: fmtTime(l.defaultCheckInTime), check_out_time: fmtTime(l.defaultCheckOutTime),
    description: {
      summary: clip(pd.summary, 2500), space: clip(pd.space, 3500), guest_access: clip(pd.access, 2000),
      neighborhood: clip(pd.neighborhood, 2000), getting_around: clip(pd.transit, 1500),
      other_notes: clip(pd.notes, 2000), house_rules: clip(pd.houseRules, 2500),
    },
    amenities: (Array.isArray(l.amenities) ? l.amenities : []).map(String).slice(0, 150),
  };
  const [defs, cfs] = await Promise.all([customFieldDefs(), listingCustomFields(listingId, l.customFields)]);
  const ins = cfEntry(cfs, defs.checkin) || cfByName(cfs, RE_CHECKIN);
  const door = cfEntry(cfs, defs.door) || cfByName(cfs, RE_DOOR, RE_CHECKIN);
  // Kept apart from `data` so these never ride along with the public listing details.
  const arrival = { instructions: cfText(ins), door_code: clip(cfText(door), 200) };
  diag.last_listing = { at: new Date().toISOString(), custom_field_ids: cfs.map((x) => String((x && (x.fieldId || x.customFieldId || x._id || x.id)) || '?')).slice(0, 40), found_instructions: !!arrival.instructions, found_door_code: !!arrival.door_code };
  saveDiag();
  Object.defineProperty(data, 'arrival', { value: arrival, enumerable: false });
  cache.set(listingId, { at: Date.now(), data });
  return data;
}

// session: a concierge_sessions row (already validated by C.loadSession)
// listingInfo: { name, photo } from C.conciergeListings() (or just the name)
async function forSession(session, listingInfo, now) {
  now = now || new Date();
  const info = typeof listingInfo === 'string' ? { name: listingInfo } : (listingInfo || {});
  const pub = C.publicSession(session, info, now);
  const [listing, items] = await Promise.all([
    guestyListing(session.listing_id).catch((e) => { console.warn('concierge listing fetch', e.message); return null; }),
    I.sbSelect('guest_guide_items', `select=id,listing_id,section,title,body,sensitive,sort&active=eq.true&or=(listing_id.is.null,listing_id.eq.${encodeURIComponent(session.listing_id)})&order=sort.asc,id.asc`).catch(() => []),
  ]);
  const allowed = items.filter((x) => !x.sensitive || pub.sensitive_unlocked); // ← the release rule
  const arr = (listing && listing.arrival) || {};
  const hasArrival = !!(arr.instructions || arr.door_code);
  const guide = allowed.map((x) => ({ section: clip(x.section, 40) || 'General', title: clip(x.title, 120), body: clip(x.body, 4000), sensitive: !!x.sensitive, scope: x.listing_id ? 'home' : 'company' }));
  // Guesty check-in instructions + door code: same release rule as Sensitive items. Added to the
  // guide list too, so the AI can answer "what's the door code?" on check-in day — and only then.
  if (pub.sensitive_unlocked) {
    if (arr.door_code) guide.unshift({ section: 'Check-in', title: 'Door code', body: arr.door_code, sensitive: true, scope: 'home' });
    if (arr.instructions) guide.unshift({ section: 'Check-in', title: 'Check-in instructions', body: arr.instructions, sensitive: true, scope: 'home' });
  }
  return {
    property: { ...(listing || {}), name: info.name || '', photo: info.photo || null },
    guest_first_name: pub.guest_first_name,
    stay: { check_in: session.check_in, check_out_date: session.check_out_date },
    sensitive_unlocked: pub.sensitive_unlocked,
    sensitive_from: pub.sensitive_from,
    arrival: pub.sensitive_unlocked ? { instructions: arr.instructions || '', door_code: arr.door_code || '' } : null,
    has_arrival_info: hasArrival,
    has_locked_items: !pub.sensitive_unlocked && (hasArrival || items.some((x) => x.sensitive)),
    guide,
  };
}

module.exports = { forSession, guestyListing };
