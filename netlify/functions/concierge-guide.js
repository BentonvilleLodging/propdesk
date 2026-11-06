// netlify/functions/concierge-guide.js
// PUBLIC (token-gated). GET with "Authorization: Bearer <token>" → the Home Guide for the guest's
// own home only. Sensitive items (door codes, Wi-Fi…) are released from the start of check-in day.
const C = require('../lib/concierge');
const K = require('../lib/concierge-knowledge');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return C.reply(405, { error: 'GET only' });
  if (!C.originOk(event, false)) return C.reply(403, { error: 'forbidden' });
  try {
    const res = await C.loadSession(event);
    if (res.error) return C.reply(res.status, { error: res.error });
    const listings = await C.conciergeListings().catch(() => []);
    const l = listings.find((x) => x.id === res.session.listing_id);
    const k = await K.forSession(res.session, l ? l.name : '');
    return C.reply(200, { ok: true, guide: k });
  } catch (e) {
    console.error('concierge-guide', e.message);
    return C.reply(503, { error: 'unavailable' });
  }
};
