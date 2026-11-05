// netlify/functions/send-push.js
// Sends Web Push (VAPID) to all stored subscriptions.
// Uses the `web-push` npm package — install it with:
//   cd netlify/functions && npm init -y && npm install web-push
// OR use a package.json in the repo root (see instructions).

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const { serverKey, requireTeam, internalHeaders, isScheduledInvocation, DENIED } = require('../lib/auth');
const SUPABASE_KEY = serverKey(); // server-side key (SUPABASE_SERVICE_KEY env); tables are RLS-locked to the team

// SECURITY: notifications may only link inside PropDesk. Accept a same-site
// relative path ("/", "/?agent_run=12"); anything else (absolute URLs,
// protocol-relative "//evil.com", javascript:, backslashes) becomes "/".
function safePath(u) {
  const s = String(u || '/').trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\s<>"']/.test(s)) return '/';
  return s.slice(0, 300);
}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function getSubscriptions() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
  });
  if (!res.ok) {
    console.error('getSubscriptions failed:', res.status, await res.text());
    return [];
  }
  const rows = await res.json();
  // Reshape DB rows into the PushSubscription JSON format web-push expects
  return rows.map(r => ({
    id:       r.id,
    endpoint: r.endpoint,
    keys: {
      p256dh: r.keys_p256dh,
      auth:   r.keys_auth,
    },
  }));
}

async function removeSubscription(id) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
  });
  console.log('Removed stale subscription', id);
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!(await requireTeam(event))) return DENIED(CORS); // staff + cleaning team both trigger pushes
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:luke@above8capital.com';

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error('VAPID env vars not set');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY not configured in Netlify env vars' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { title, message, tag, url } = body || {};
  if (!title || !message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'title and message required' }) };

  let webpush;
  try {
    webpush = require('web-push');
  } catch(e) {
    console.error('web-push not installed:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'web-push package not installed. Run: cd netlify/functions && npm install web-push' }) };
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const subs = await getSubscriptions();
  console.log('Subscribers found:', subs.length, '| Title:', clip(title, 80));

  if (!subs.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0, failed: 0, removed: 0, note: 'No subscribers registered yet. Make sure notification permission is granted in the staff browser and a subscription is saved in push_subscriptions.' }) };
  }

  const payload = JSON.stringify({
    title: clip(title, 120),
    body:  clip(message, 500),
    tag:   clip(tag || 'propdesk', 100),
    url:   safePath(url),
    icon:  '/apple-touch-icon.png',
    badge: '/icon-192.png',
  });

  let sent = 0, failed = 0, removed = 0;

  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch(e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await removeSubscription(sub.id);
        removed++;
      } else {
        console.warn('Push failed sub', sub.id, e.statusCode, e.body ? e.body.slice(0,200) : e.message);
        failed++;
      }
    }
  }));

  console.log(`Push done: ${sent} sent, ${failed} failed, ${removed} removed`);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ sent, failed, removed }),
  };
};
