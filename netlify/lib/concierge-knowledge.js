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
//   4. local_places — our curated Things to Do list (public places, same for every home).
// Never used: property_cards / properties (team codes, owner contacts, contracts, cleaning notes).
// Rule: secrets that aren't allowed yet are never put in front of the AI, so it can't leak them.

const I = require('./intel');
const C = require('./concierge');

const LISTING_FIELDS = '_id title address publicDescription amenities defaultCheckInTime defaultCheckOutTime accommodates bedrooms bathrooms propertyType customFields wifiName wifiPassword parkingInstructions houseManual trashCollectedOn';

// ── Guesty custom fields (check-in instructions + door code) ──────────────
// Matched by the field's display name in the account's custom-field list; override with
// GUESTY_CF_CHECKIN_ID / GUESTY_CF_DOORCODE_ID (Guesty custom field ids) if names ever change.
const RE_CHECKIN = /check[\s-]*in.*(instruction|info|direction|detail)|arrival.*(instruction|info)/i;
const RE_CHECKOUT = /check[\s-]*out.*(instruction|info|step|detail|procedure)|departure.*(instruction|info)/i;
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
  const out = { checkout: pick(process.env.GUESTY_CF_CHECKOUT_ID, RE_CHECKOUT), checkin: pick(process.env.GUESTY_CF_CHECKIN_ID, RE_CHECKIN), door: pick(process.env.GUESTY_CF_DOORCODE_ID, RE_DOOR, RE_CHECKIN), all: defs.map((d) => d.name + ' [' + d.id + ']') };
  defsCache = { at: Date.now(), defs: out };
  Object.assign(diag, { source, listing_fields: out.all, checkin_field: out.checkin && out.checkin.name, checkout_field: out.checkout && out.checkout.name, door_code_field: out.door && out.door.name });
  saveDiag();
  return out;
}
// A listing's own custom-field values. Some accounts only return them from the dedicated route.
async function listingCustomFields(listingId, fromListing) {
  if (Array.isArray(fromListing) && fromListing.length) return fromListing;
  try { return listOf(await I.guestyGet(`/v1/listings/${encodeURIComponent(listingId)}/custom-fields`)); }
  catch (e) { note('listing custom-fields', e); return []; }
}
function cfEntry(list, def) {
  if (!def || !Array.isArray(list)) return null;
  // match by field id, or by the entry's own name when the account list couldn't be read
  return list.find((x) => x && String(x.fieldId || x.customFieldId || x._id || x.id || '') === def.id) || null;
}
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
    lat: l.address && Number.isFinite(+l.address.lat) ? +l.address.lat : null,
    lng: l.address && Number.isFinite(+l.address.lng) ? +l.address.lng : null,
    parking: clip(l.parkingInstructions, 1500),
    trash_day: clip(l.trashCollectedOn, 200),
  };
  const [defs, cfs] = await Promise.all([customFieldDefs(), listingCustomFields(listingId, l.customFields)]);
  const ins = cfEntry(cfs, defs.checkin) || cfByName(cfs, RE_CHECKIN);
  const door = cfEntry(cfs, defs.door) || cfByName(cfs, RE_DOOR, RE_CHECKIN);
  const out = cfEntry(cfs, defs.checkout) || cfByName(cfs, RE_CHECKOUT);
  data.checkout_instructions = cfText(out);
  // Kept apart from `data` so these never ride along with the public listing details.
  // Released only from the start of check-in day (see forSession).
  const arrival = {
    instructions: cfText(ins), door_code: clip(cfText(door), 200),
    wifi_name: clip(l.wifiName, 120), wifi_password: clip(l.wifiPassword, 120), house_manual: clip(l.houseManual, 6000),
  };
  diag.last_listing = { at: new Date().toISOString(), custom_field_ids: cfs.map((x) => String((x && (x.fieldId || x.customFieldId || x._id || x.id)) || '?')).slice(0, 40), found_instructions: !!arrival.instructions, found_door_code: !!arrival.door_code };
  saveDiag();
  Object.defineProperty(data, 'arrival', { value: arrival, enumerable: false });
  cache.set(listingId, { at: Date.now(), data });
  return data;
}

// ── Things to Do (local_places — staff-curated, same list for every home) ──
// Places from the bentonvillelodgingco.com Things to Do page are shown at every home. Extra places
// we added for where homes are (Bella Vista trails, Beaver Lake, Rogers…) only show within 15 miles
// of the guest's home. Distances are straight-line from the home and only shown as a rough guide.
const CAT_ORDER = ['Eat', 'Coffee', 'Drinks', 'Outdoors', 'Museums & Arts', 'Family', 'Explore'];
const NEAR_MI = 15;
function miles(a, b, c, d) {
  const R = 3958.8, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
let geoBudget = 0, geoAt = 0;
// Fill in missing coordinates, a couple per request, from OpenStreetMap — limited to NW Arkansas so a
// name like "Conifer" can't land in another state.
async function fillCoords(rows) {
  if (Date.now() - geoAt > 60000) { geoAt = Date.now(); geoBudget = 2; }
  for (const p of rows.filter((x) => x.lat == null && x.maps_q).slice(0, geoBudget)) {
    geoBudget--;
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&bounded=1&viewbox=-94.65,36.55,-93.6,35.95&q=' + encodeURIComponent(p.maps_q);
      const r = await fetch(u, { headers: { 'Accept-Language': 'en', 'User-Agent': 'PropDesk/1.0 (bentonvillelodgingco.com)' } });
      const j = r.ok ? await r.json() : [];
      if (j && j[0]) { p.lat = +j[0].lat; p.lng = +j[0].lon; await I.sbPatch('local_places', `id=eq.${p.id}`, { lat: p.lat, lng: p.lng }).catch(() => {}); }
    } catch (e) { /* try again another time */ }
  }
}
let placesCache = null;
async function localPlaces(home) {
  if (!placesCache || Date.now() - placesCache.at > 10 * 60 * 1000) {
    const rows = await I.sbSelect('local_places', 'select=id,name,category,blurb,url,maps_q,lat,lng,partner,source,sort&active=eq.true&order=sort.asc,id.asc&limit=300').catch(() => null);
    if (rows) { await fillCoords(rows); placesCache = { at: Date.now(), rows }; }
  }
  const rows = (placesCache && placesCache.rows) || [];
  const haveHome = home && home.lat != null && home.lng != null;
  return rows.map((p) => {
    const mi = haveHome && p.lat != null ? miles(home.lat, home.lng, p.lat, p.lng) : null;
    return { name: clip(p.name, 120), category: p.category, blurb: clip(p.blurb, 300), url: /^https:\/\//.test(p.url || '') ? p.url : null,
      maps: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.maps_q || p.name), partner: !!p.partner,
      miles: mi == null ? null : Math.round(mi * 10) / 10, sort: p.sort, source: p.source };
  }).filter((p) => p.source === 'website' || (p.miles != null && p.miles <= NEAR_MI))
    .sort((a, b) => (CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category)) || (b.partner - a.partner) || ((a.miles == null ? 999 : a.miles) - (b.miles == null ? 999 : b.miles)) || (a.sort - b.sort))
    .map(({ sort, source, ...p }) => p);
}

// session: a concierge_sessions row (already validated by C.loadSession)
// listingInfo: { name, photo } from C.conciergeListings() (or just the name)
async function forSession(session, listingInfo, now) {
  now = now || new Date();
  const info = typeof listingInfo === 'string' ? { name: listingInfo } : (listingInfo || {});
  const pub = C.publicSession(session, info, now);
  const [listing, items] = await Promise.all([
    guestyListing(session.listing_id).catch((e) => { console.warn('concierge listing fetch', e.message); return null; }),
    I.sbSelect('guest_guide_items', `select=id,listing_id,section,title,body,sensitive,sort,photos,ai_only&active=eq.true&or=(listing_id.is.null,listing_id.eq.${encodeURIComponent(session.listing_id)})&order=sort.asc,id.asc`).catch(() => []),
  ]);
  const allowed = items.filter((x) => !x.sensitive || pub.sensitive_unlocked); // ← the release rule
  const arr = (listing && listing.arrival) || {};
  const hasArrival = !!(arr.instructions || arr.door_code);
  const guide = allowed.map((x) => ({
    section: clip(x.section, 40) || 'General', title: clip(x.title, 120), body: clip(x.body, 4000), sensitive: !!x.sensitive,
    scope: x.listing_id ? 'home' : 'company', source: 'team', ai_only: !!x.ai_only,
    photos: (Array.isArray(x.photos) ? x.photos : []).filter((p) => typeof p === 'string').slice(0, 8),
  }));
  const L = listing || {};
  const gx = (section, title, body, sensitive) => ({ section, title, body, sensitive: !!sensitive, scope: 'home', source: 'guesty', ai_only: false, photos: [] });
  // From Guesty, always allowed (guest-facing, no secrets): parking, checkout steps, trash day.
  if (L.parking) guide.push(gx('Parking', 'Parking', L.parking));
  if (L.checkout_instructions) guide.push(gx('Checkout', 'Checkout instructions', L.checkout_instructions));
  if (L.trash_day) guide.push(gx('Trash & recycling', 'Trash pickup', 'Pickup: ' + L.trash_day));
  // From Guesty, sensitive: same release rule as Sensitive items. Added to the guide list too, so
  // the AI can answer "what's the door code / Wi-Fi?" on check-in day — and only then.
  if (pub.sensitive_unlocked) {
    if (arr.wifi_name || arr.wifi_password) guide.unshift(gx('Wi-Fi', 'Wi-Fi', [arr.wifi_name && 'Network: ' + arr.wifi_name, arr.wifi_password && 'Password: ' + arr.wifi_password].filter(Boolean).join('\n'), true));
    if (arr.door_code) guide.unshift(gx('Check-in', 'Door code', arr.door_code, true));
    if (arr.instructions) guide.unshift(gx('Check-in', 'Check-in instructions', arr.instructions, true));
    if (arr.house_manual) guide.push(gx('House manual', 'House manual', arr.house_manual, true));
  }
  const places = await localPlaces(listing).catch(() => []);
  return {
    property: { ...(listing || {}), name: info.name || '', photo: info.photo || null },
    places,
    guest_first_name: pub.guest_first_name,
    stay: { check_in: session.check_in, check_out_date: session.check_out_date },
    sensitive_unlocked: pub.sensitive_unlocked,
    sensitive_from: pub.sensitive_from,
    arrival: pub.sensitive_unlocked ? { instructions: arr.instructions || '', door_code: arr.door_code || '' } : null,
    wifi: pub.sensitive_unlocked && (arr.wifi_name || arr.wifi_password) ? { name: arr.wifi_name || '', password: arr.wifi_password || '' } : null,
    has_arrival_info: hasArrival,
    has_locked_items: !pub.sensitive_unlocked && (hasArrival || !!(arr.wifi_name || arr.wifi_password || arr.house_manual) || items.some((x) => x.sensitive)),
    guide,
  };
}

// STAFF ONLY (PropDesk Guest Guide tab): everything the guide pulls from Guesty for one listing,
// including the sensitive values, so the team can check them. Never call this from a guest endpoint.
async function staffView(listingId) {
  cache.delete(listingId);
  const d = await guestyListing(listingId);
  const a = d.arrival || {};
  return {
    check_in_time: d.check_in_time, check_out_time: d.check_out_time, address: d.address,
    wifi_name: a.wifi_name, wifi_password: a.wifi_password, door_code: a.door_code, checkin_instructions: a.instructions,
    checkout_instructions: d.checkout_instructions, parking: d.parking, trash_day: d.trash_day, house_manual: a.house_manual,
    house_rules: d.description.house_rules,
    detected: { checkin_field: diag.checkin_field || null, checkout_field: diag.checkout_field || null, door_code_field: diag.door_code_field || null, errors: diag.errors.slice(-3) },
  };
}

module.exports = { forSession, guestyListing, staffView };
