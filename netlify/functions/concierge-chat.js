// netlify/functions/concierge-chat.js
// PUBLIC (token-gated) guest chat with the Bentonville Lodging Co. AI teammate.
//   POST { message }        → stores the guest's message, starts the agent → { ok, id }
//   GET  ?after=<id>        → messages after <id> for this reservation + whether a reply is pending
// The AI runs in concierge-agent-background (internal key only — guests can't call it directly).
// Limits per reservation: 20 messages/hour, 40/day, 150/stay; 300/day across all guests
// (concierge_chat_limits). Staff get a push when all-homes chat volume hits 150 and 250 in a day.
const C = require('../lib/concierge');
const I = require('../lib/intel');
const T = require('../lib/trust');
const { internalHeaders } = require('../lib/auth');

const MAX_LEN = 800;
const ALERT_AT = [150, 250]; // all-homes guest messages in 24h

exports.handler = async function (event) {
  const isPost = event.httpMethod === 'POST';
  if (!isPost && event.httpMethod !== 'GET') return C.reply(405, { error: 'method' });
  if (!C.originOk(event, isPost)) return C.reply(403, { error: 'forbidden' });
  if ((event.body || '').length > 4000) return C.reply(413, { error: 'too large' });

  let res;
  try { res = await C.loadSession(event); } catch (e) { return C.reply(503, { error: 'unavailable' }); }
  if (res.error) return C.reply(res.status, { error: res.error });
  const s = res.session;

  if (!isPost) {
    const after = Math.max(0, parseInt((event.queryStringParameters || {}).after, 10) || 0);
    const rows = await I.sbSelect('concierge_messages', `select=id,role,content,created_at&reservation_id=eq.${encodeURIComponent(s.reservation_id)}&id=gt.${after}&order=id.asc&limit=60`).catch(() => null);
    if (!rows) return C.reply(503, { error: 'unavailable' });
    let pending = false;
    if (rows.length) pending = rows[rows.length - 1].role === 'user';
    else if (after) {
      const [last] = await I.sbSelect('concierge_messages', `select=role&reservation_id=eq.${encodeURIComponent(s.reservation_id)}&order=id.desc&limit=1`).catch(() => []);
      pending = !!(last && last.role === 'user');
    }
    return C.reply(200, { ok: true, messages: rows, pending });
  }

  let b = {};
  try { b = JSON.parse(event.body || '{}') || {}; } catch (e) { return C.reply(400, { error: 'Invalid request' }); }
  const text = typeof b.message === 'string' ? b.message.replace(/\u0000/g, '').trim() : '';
  if (!text) return C.reply(400, { error: 'Type a message first.' });
  if (text.length > MAX_LEN) return C.reply(400, { error: `Please keep messages under ${MAX_LEN} characters.` });

  try {
    const lim = await I.sbRpc('concierge_chat_limits', { p_reservation_id: s.reservation_id });
    if (lim && lim.blocked) return C.reply(429, { error: 'You’ve sent a lot of messages — please message us through your booking app and our team will jump in.' });
    if (lim && ALERT_AT.includes(lim.global_day)) {
      const base0 = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
      await fetch(`${base0}/.netlify/functions/send-push`, { method: 'POST', headers: internalHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: '💬 Concierge chat volume', message: `${lim.global_day} guest chat messages in the last 24 hours (daily cap is 300). Check for unusual use.`, tag: 'concierge-volume', url: '/' }) }).catch(() => {});
    }
    // Trust layer: card / SSN / bank numbers, emails and phone numbers are stripped BEFORE the
    // message is stored or reaches the AI — they never sit in our database or go to Claude.
    const clean = T.redact(text);
    const [msg] = await I.sbInsert('concierge_messages', [{ session_id: s.id, reservation_id: s.reservation_id, listing_id: s.listing_id, role: 'user', content: clean.text, ...(clean.found.length ? { meta: { redacted: clean.found } } : {}) }]);
    const base = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
    const r = await fetch(`${base}/.netlify/functions/concierge-agent-background`, {
      method: 'POST', headers: internalHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ message_id: msg.id }),
    });
    if (!r.ok && r.status !== 202) console.error('concierge agent dispatch', r.status);
    return C.reply(200, { ok: true, id: msg.id });
  } catch (e) {
    console.error('concierge-chat', e.message);
    return C.reply(503, { error: 'Chat is temporarily unavailable — please message us through your booking app.' });
  }
};
