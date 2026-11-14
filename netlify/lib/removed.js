// netlify/lib/removed.js
// Listings BLC no longer manages (e.g. Old Campbell Cove, removed Nov 2026). They may still exist
// in the Guesty account, so every job that pulls the Guesty listing list drops them here —
// otherwise the next data sync would re-create them in PropDesk.
const { SUPABASE_URL, serverHeaders } = require('./auth');

async function removedListingIds() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/removed_listings?select=listing_id`, { headers: serverHeaders() });
    if (!res.ok) return new Set();
    return new Set((await res.json()).map((r) => r.listing_id));
  } catch (e) { return new Set(); }
}

module.exports = { removedListingIds };
