// netlify/functions/concierge-guide.js
// PUBLIC (token-gated). GET with "Authorization: Bearer <token>" → the Home Guide for the guest's
// own home only. Sensitive items (door codes, Wi-Fi…) are released from the start of check-in day.
// "AI only" items are left out (the AI chat still uses them). Team photos live in a PRIVATE storage
// bucket; each allowed photo is returned as a signed link that expires after an hour.
const C = require('../lib/concierge');
const K = require('../lib/concierge-knowledge');
const { SUPABASE_URL, serverHeaders } = require('../lib/auth');

const BUCKET = 'guide-photos';
const PATH_RE = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,80}\.(jpe?g|png|webp)$/;

async function signPhotos(paths) {
  const ok = Array.from(new Set(paths.filter((p) => PATH_RE.test(p)))).slice(0, 120);
  if (!ok.length) return {};
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
    method: 'POST', headers: serverHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 3600, paths: ok }),
  });
  if (!res.ok) { console.warn('guide photo sign', res.status); return {}; }
  const out = {};
  (await res.json()).forEach((r) => { if (r && r.signedURL && !r.error) out[r.path] = SUPABASE_URL + '/storage/v1' + r.signedURL; });
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return C.reply(405, { error: 'GET only' });
  if (!C.originOk(event, false)) return C.reply(403, { error: 'forbidden' });
  try {
    const res = await C.loadSession(event);
    if (res.error) return C.reply(res.status, { error: res.error });
    const listings = await C.conciergeListings().catch(() => []);
    const l = listings.find((x) => x.id === res.session.listing_id);
    const k = await K.forSession(res.session, l || null);
    k.guide = k.guide.filter((x) => !x.ai_only);
    const signed = await signPhotos([].concat(...k.guide.map((x) => x.photos || []))).catch(() => ({}));
    k.guide = k.guide.map((x) => { const o = Object.assign({}, x, { photos: (x.photos || []).map((p) => signed[p]).filter(Boolean) }); delete o.ai_only; return o; });
    return C.reply(200, { ok: true, guide: k });
  } catch (e) {
    console.error('concierge-guide', e.message);
    return C.reply(503, { error: 'unavailable' });
  }
};
