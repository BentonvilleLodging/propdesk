// netlify/functions/concierge-subscribe.js
// PUBLIC (token-gated). POST { email, consent: true } with "Authorization: Bearer <token>".
// Saves a verified guest's email for Bentonville Lodging Co. updates ONLY with explicit opt-in.
// Requiring a live session means the list can't be spammed with arbitrary addresses.
const C = require('../lib/concierge');
const I = require('../lib/intel');

const CONSENT_TEXT = 'Yes, email me Bentonville tips, events and return-guest offers from Bentonville Lodging Co. I can unsubscribe anytime.';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return C.reply(405, { error: 'POST only' });
  if (!C.originOk(event, true)) return C.reply(403, { error: 'forbidden' });
  if ((event.body || '').length > 1000) return C.reply(413, { error: 'too large' });
  let b = {};
  try { b = JSON.parse(event.body || '{}') || {}; } catch (e) { return C.reply(400, { error: 'Invalid request' }); }
  const email = C.normEmail(b.email);
  if (b.consent !== true) return C.reply(400, { error: 'Please tick the box to subscribe.' });
  if (!C.EMAIL_RE.test(email) || email.length > 160) return C.reply(400, { error: 'Enter a valid email address.' });
  if (/@(guest\.)?airbnb\.com$|@messages\.homeaway\.com$|@guest\.booking\.com$/i.test(email)) return C.reply(400, { error: 'That looks like a booking-site relay address — please use your personal email.' });
  try {
    const res = await C.loadSession(event);
    if (res.error) return C.reply(res.status, { error: res.error });
    const s = res.session, now = new Date().toISOString();
    await I.sbUpsert('guest_contacts', [{
      email, first_name: s.guest_first_name || null, listing_id: s.listing_id, reservation_id: s.reservation_id,
      marketing_consent: true, consent_text: CONSENT_TEXT, consent_at: now, source: 'concierge', updated_at: now,
    }], 'email');
    return C.reply(200, { ok: true });
  } catch (e) {
    console.error('concierge-subscribe', e.message);
    return C.reply(503, { error: 'unavailable' });
  }
};
module.exports.CONSENT_TEXT = CONSENT_TEXT;
