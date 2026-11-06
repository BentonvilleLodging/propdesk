// netlify/functions/guide-guesty.js
// STAFF ONLY. GET ?listing_id=<Guesty listing id> → what the guest guide pulls from Guesty for that
// home (Wi-Fi, door code, check-in / checkout instructions, parking, trash day, house manual, times),
// so the PropDesk "Guest Guide & AI" tab can show it read-only. Requires a signed-in staff session.
const { requireTeam } = require('../lib/auth');
const K = require('../lib/concierge-knowledge');

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (s, b) => ({ statusCode: s, headers: H, body: JSON.stringify(b) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'GET only' });
  const who = await requireTeam(event, ['staff']);
  if (!who) return reply(401, { error: 'Not authorized — sign in to PropDesk.' });
  const id = String((event.queryStringParameters || {}).listing_id || '');
  if (!/^[A-Za-z0-9]{6,40}$/.test(id)) return reply(400, { error: 'listing_id required' });
  try {
    return reply(200, { ok: true, guesty: await K.staffView(id) });
  } catch (e) {
    console.error('guide-guesty', e.message);
    return reply(502, { error: 'Couldn’t reach Guesty: ' + String(e.message).slice(0, 160) });
  }
};
