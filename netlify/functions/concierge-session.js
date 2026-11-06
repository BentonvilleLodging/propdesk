// netlify/functions/concierge-session.js
// PUBLIC (token-gated). GET with "Authorization: Bearer <token>" → the guest's session summary.
// DELETE with the same header → log out: the session is revoked on the server, so the token can't
// be used again even if it was copied somewhere.
const C = require('../lib/concierge');
const I = require('../lib/intel');

exports.handler = async function (event) {
  if (event.httpMethod === 'DELETE') {
    if (!C.originOk(event, true)) return C.reply(403, { error: 'forbidden' });
    const tok = String(C.header(event, 'authorization')).replace(/^Bearer\s+/i, '').trim();
    if (tok && tok.length >= 40 && tok.length <= 60 && /^[A-Za-z0-9_-]+$/.test(tok)) {
      await I.sbPatch('concierge_sessions', `token_hash=eq.${C.tokenHash(tok)}&revoked=eq.false`, { revoked: true, revoked_reason: 'guest logged out' }).catch(() => {});
    }
    return C.reply(200, { ok: true });
  }
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
