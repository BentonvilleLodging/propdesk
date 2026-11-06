// netlify/functions/concierge-session.js
// PUBLIC (token-gated). GET with "Authorization: Bearer <token>" → the guest's session summary.
// The guidebook content endpoint will use the same check (C.loadSession).
const C = require('../lib/concierge');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return C.reply(405, { error: 'GET only' });
  if (!C.originOk(event, false)) return C.reply(403, { error: 'forbidden' });
  try {
    const res = await C.loadSession(event);
    if (res.error) return C.reply(res.status, { error: res.error });
    const listings = await C.conciergeListings().catch(() => []);
    const l = listings.find((x) => x.id === res.session.listing_id);
    return C.reply(200, { ok: true, session: C.publicSession(res.session, l || null) });
  } catch (e) {
    console.error('concierge-session', e.message);
    return C.reply(503, { error: 'unavailable' });
  }
};
