// netlify/functions/concierge-properties.js
// PUBLIC. GET → [{ id, name }] for the Concierge property dropdown.
// Returns only each listing's Guesty id and its public listing title (already public on Airbnb/Vrbo).
const C = require('../lib/concierge');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return C.reply(405, { error: 'GET only' });
  if (!C.originOk(event, false)) return C.reply(403, { error: 'forbidden' });
  try {
    const list = await C.conciergeListings();
    return C.reply(200, { properties: list }, { 'Cache-Control': 'public, max-age=300' });
  } catch (e) {
    console.error('concierge-properties', e.message);
    return C.reply(503, { error: 'unavailable' });
  }
};
