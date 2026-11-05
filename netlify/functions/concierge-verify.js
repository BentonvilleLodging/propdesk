// netlify/functions/concierge-verify.js
// PUBLIC. POST { listing_id, identifier, last_name?, website? }  → { ok, token, session } | generic failure
//
// Unlocks a guest's Concierge only when Guesty has an ACTIVE reservation for THAT listing whose
// confirmation code matches, or whose booking email AND guest last name both match.
// Active = status confirmed and now is within (check-in − 48h) … end of checkout day (Central).
// Every response for a non-match is identical (same message, same minimum response time), so the
// endpoint never reveals whether a code, email or reservation exists. Failed attempts are
// rate-limited per IP (5 / 15 min, 20 / day), per listing (30 / hour) and globally (300 / hour).
const C = require('../lib/concierge');
const I = require('../lib/intel');

const MIN_MS = 900;
const NO_MATCH = "We couldn't find an active reservation for that property. Check the property and your confirmation code, or use the email on your booking plus your last name. The guide opens 48 hours before check-in.";

async function logAttempt(ipHash, listingId, ok, reason) {
  await I.sbInsert('concierge_attempts', [{ ip_hash: ipHash, listing_id: listingId || null, ok, reason }]).catch(() => {});
}

exports.handler = async function (event) {
  const started = Date.now();
  const finish = async (status, body) => { const wait = MIN_MS - (Date.now() - started); if (wait > 0) await C.sleep(wait + Math.floor(Math.random() * 150)); return C.reply(status, body); };

  if (event.httpMethod !== 'POST') return C.reply(405, { error: 'POST only' });
  if (!C.originOk(event, true)) return C.reply(403, { error: 'forbidden' });
  if ((event.body || '').length > 2000) return C.reply(413, { error: 'too large' });

  let b = {};
  try { b = JSON.parse(event.body || '{}') || {}; } catch (e) { return finish(400, { ok: false, error: NO_MATCH }); }
  const ipHash = C.ipHash(event);
  const listingId = typeof b.listing_id === 'string' && /^[A-Za-z0-9]{6,40}$/.test(b.listing_id) ? b.listing_id : null;

  // Honeypot: real guests never fill the hidden "website" field.
  if (b.website) { await logAttempt(ipHash, listingId, false, 'honeypot'); return finish(200, { ok: false, error: NO_MATCH }); }

  try {
    const rl = await I.sbRpc('concierge_rate_check', { p_ip_hash: ipHash, p_listing_id: listingId || '' });
    if (rl && rl.blocked) return finish(429, { ok: false, error: 'Too many attempts. Please wait 15 minutes and try again, or contact us for help.' });
  } catch (e) {
    console.error('concierge rate check failed', e.message);
    return finish(503, { ok: false, error: 'The concierge is temporarily unavailable. Please try again shortly.' });
  }

  const input = C.parseInput(b.identifier, b.last_name);
  if (!listingId || !input) { await logAttempt(ipHash, listingId, false, 'bad input'); return finish(200, { ok: false, error: NO_MATCH }); }

  let listings;
  try { listings = await C.conciergeListings(); } catch (e) { return finish(503, { ok: false, error: 'The concierge is temporarily unavailable. Please try again shortly.' }); }
  const listing = listings.find((l) => l.id === listingId);
  if (!listing) { await logAttempt(ipHash, listingId, false, 'unknown listing'); return finish(200, { ok: false, error: NO_MATCH }); }

  const now = new Date();
  let cands;
  try { cands = await C.candidateReservations(listingId, now); }
  catch (e) {
    console.error('concierge guesty lookup failed', e.message); // not counted against the guest
    return finish(503, { ok: false, error: 'We couldn’t reach our reservation system. Please try again in a minute.' });
  }
  const r = cands.find((x) => C.matches(x, input));
  if (!r) { await logAttempt(ipHash, listingId, false, 'no match (' + input.kind + ')'); return finish(200, { ok: false, error: NO_MATCH }); }

  const w = C.stayWindow(r);
  const token = C.newToken();
  const row = {
    token_hash: C.tokenHash(token), reservation_id: String(r._id), listing_id: listingId,
    guest_first_name: C.firstName(r), check_in: w.checkIn.toISOString(), check_out_date: w.outDate,
    expires_at: w.lockAt.toISOString(), method: input.kind, ip_hash: ipHash,
    user_agent: String(C.header(event, 'user-agent')).slice(0, 200), last_verified_at: now.toISOString(),
  };
  try { await I.sbInsert('concierge_sessions', [row]); }
  catch (e) { console.error('concierge session insert', e.message); return finish(503, { ok: false, error: 'The concierge is temporarily unavailable. Please try again shortly.' }); }
  await logAttempt(ipHash, listingId, true, 'ok (' + input.kind + ')');

  return finish(200, { ok: true, token, session: C.publicSession(row, listing.name, now), used_email: input.kind === 'email' ? input.email : null });
};
