// netlify/functions/push-diag.js
// GET /.netlify/functions/push-diag
// Returns: subscription count, VAPID key status, sends a test push if ?test=1

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PERqMlyz5OndCT7wVSUgGQ_T4Tpy_OQ';

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

  // Count subscriptions
  const res  = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,endpoint,created_at`, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
  });
  const subs = res.ok ? await res.json() : [];

  const diag = {
    vapid_public_set:  !!VAPID_PUBLIC,
    vapid_private_set: !!VAPID_PRIVATE,
    vapid_public_key:  VAPID_PUBLIC ? VAPID_PUBLIC.slice(0,20) + '...' : 'NOT SET',
    subscription_count: subs.length,
    subscriptions: subs.map(s => ({
      id: s.id,
      endpoint_prefix: s.endpoint ? s.endpoint.slice(0, 50) + '...' : '?',
      created_at: s.created_at,
    })),
  };

  // If ?test=1 send a real test push
  if (event.queryStringParameters && event.queryStringParameters.test === '1') {
    const siteUrl = process.env.URL || ('https://' + event.headers.host);
    const pushRes = await fetch(`${siteUrl}/.netlify/functions/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:   '🔔 PropDesk Test Push',
        message: 'Push notifications are working!',
        tag:     'test-push-' + Date.now(),
        url:     '/',
      }),
    });
    const pushData = await pushRes.json();
    diag.test_push_result = pushData;
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(diag, null, 2) };
};
