// netlify/lib/concierge-knowledge.js
// What a verified guest (and the AI concierge acting for them) is allowed to know about ONE home.
//
// Sources — and ONLY these:
//   1. Guesty's guest-facing listing content (title, address, description sections, house rules,
//      amenities, check-in/out times) — the same things guests already see when they book.
//   2. guest_guide_items that staff wrote on purpose for guests (this listing + company-wide).
//      Items marked `sensitive` (door codes, Wi-Fi…) are NOT loaded until the start of check-in day.
// Never used: property_cards / properties (team codes, owner contacts, contracts, cleaning notes).
// Rule: secrets that aren't allowed yet are never put in front of the AI, so it can't leak them.

const I = require('./intel');
const C = require('./concierge');

const LISTING_FIELDS = '_id title address publicDescription amenities defaultCheckInTime defaultCheckOutTime accommodates bedrooms bathrooms propertyType';
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
  cache.set(listingId, { at: Date.now(), data });
  return data;
}

// session: a concierge_sessions row (already validated by C.loadSession)
async function forSession(session, listingName, now) {
  now = now || new Date();
  const pub = C.publicSession(session, listingName, now);
  const [listing, items] = await Promise.all([
    guestyListing(session.listing_id).catch((e) => { console.warn('concierge listing fetch', e.message); return null; }),
    I.sbSelect('guest_guide_items', `select=id,listing_id,section,title,body,sensitive,sort&active=eq.true&or=(listing_id.is.null,listing_id.eq.${encodeURIComponent(session.listing_id)})&order=sort.asc,id.asc`).catch(() => []),
  ]);
  const allowed = items.filter((x) => !x.sensitive || pub.sensitive_unlocked); // ← the release rule
  return {
    property: { name: listingName || '', ...(listing || {}) },
    guest_first_name: pub.guest_first_name,
    stay: { check_in: session.check_in, check_out_date: session.check_out_date },
    sensitive_unlocked: pub.sensitive_unlocked,
    has_locked_items: items.some((x) => x.sensitive && !pub.sensitive_unlocked),
    guide: allowed.map((x) => ({ section: clip(x.section, 40) || 'General', title: clip(x.title, 120), body: clip(x.body, 4000), sensitive: !!x.sensitive, scope: x.listing_id ? 'home' : 'company' })),
  };
}

module.exports = { forSession, guestyListing };
