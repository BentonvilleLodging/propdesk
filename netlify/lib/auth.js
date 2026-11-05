// netlify/lib/auth.js
// Shared server-side helpers for PropDesk Netlify Functions.
//
// - serverHeaders(): Supabase headers using the SERVER key (SUPABASE_SERVICE_KEY
//   env var — a Supabase secret key / service_role key). All tables are locked
//   to signed-in team members via RLS, so functions must use this key.
// - requireTeam(event, roles): verifies the caller is a signed-in PropDesk team
//   member (Supabase Auth JWT in the Authorization header) or an internal
//   function-to-function call (x-internal-key header == SUPABASE_SERVICE_KEY).
//   Returns { role } on success, or null.

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_PERqMlyz5OndCT7wVSUgGQ_T4Tpy_OQ';

function serverKey() {
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!k) console.error('SUPABASE_SERVICE_KEY env var is not set — database calls will be denied by RLS');
  return k || PUBLISHABLE_KEY;
}

function serverHeaders(extra) {
  const k = serverKey();
  return Object.assign({ apikey: k, Authorization: 'Bearer ' + k }, extra || {});
}

function internalHeaders(extra) {
  return Object.assign({ 'x-internal-key': process.env.SUPABASE_SERVICE_KEY || '' }, extra || {});
}

function header(event, name) {
  const h = (event && event.headers) || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return '';
}

async function requireTeam(event, roles) {
  roles = roles || ['staff', 'cleaner'];
  const internal = header(event, 'x-internal-key');
  if (internal && process.env.SUPABASE_SERVICE_KEY && internal === process.env.SUPABASE_SERVICE_KEY) {
    return { role: 'internal' };
  }
  const token = String(header(event, 'authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token.startsWith('sb_')) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_team_role`, {
      method: 'POST',
      headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return null;
    const role = await res.json();
    if (!role || !roles.includes(role)) return null;
    return { role };
  } catch (e) {
    console.error('requireTeam check failed:', e.message);
    return null;
  }
}

// SECURITY: this used to return true when the request body contained `next_run`
// (the payload Netlify sends to *scheduled* functions). But the background
// functions that called it are URL-callable, so anyone on the internet could send
// {"next_run":1} and skip authentication. Scheduled work now always reaches those
// functions through the cron-* dispatchers (lib/dispatch.js), which send the
// internal key, so a request body is never trusted as proof of a scheduled call.
// Kept as a function so existing callers fall through to requireTeam().
function isScheduledInvocation(event) {
  return false;
}

const DENIED = (headers) => ({
  statusCode: 401,
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify({ error: 'Not authorized — sign in to PropDesk.' }),
});

module.exports = { SUPABASE_URL, PUBLISHABLE_KEY, serverKey, serverHeaders, internalHeaders, requireTeam, isScheduledInvocation, DENIED };
