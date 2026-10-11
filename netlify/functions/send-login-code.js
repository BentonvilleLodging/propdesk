// netlify/functions/send-login-code.js
//
// Staff sign-in step 1: emails a 6-digit PropDesk sign-in code.
// Instead of relying on Supabase's built-in email (link-style template, limited
// sender), this function:
//   1. checks the email belongs to an authorized staff member (public.is_staff_email)
//   2. throttles requests (60s between codes, max 8/hour per email)
//   3. asks Supabase Auth to generate a one-time code WITHOUT sending anything
//      (admin generate_link → properties.email_otp)
//   4. emails that code via Resend from noreply@bentonvillelodgingcomanagement.com
// The browser then verifies the code with supabase.auth.verifyOtp({ type: 'email' }).
//
// Env: SUPABASE_SERVICE_KEY, RESEND_API_KEY

const { SUPABASE_URL, serverHeaders } = require('../lib/auth');

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (status, body) => ({ statusCode: status, headers: HEADERS, body: JSON.stringify(body) });

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: serverHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${fn} failed (${res.status}): ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

function emailHtml(code) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0f0f0e;font-family:Helvetica,Arial,sans-serif;color:#f0ede6;">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px;">
    <div style="font-size:22px;font-weight:700;color:#c8a96e;margin-bottom:4px;">PropDesk</div>
    <div style="font-size:12px;color:#888;margin-bottom:28px;">Bentonville Lodging Co.</div>
    <div style="background:#1a1a18;border:1px solid #333;border-radius:10px;padding:28px;text-align:center;">
      <div style="font-size:14px;color:#bbb;margin-bottom:14px;">Your sign-in code</div>
      <div style="font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#f0ede6;">${code}</div>
      <div style="font-size:12px;color:#888;margin-top:16px;">Enter this code on the PropDesk sign-in screen. It expires in 1 hour.</div>
    </div>
    <div style="font-size:11px;color:#666;margin-top:20px;line-height:1.5;">If you didn't try to sign in to PropDesk, you can ignore this email.</div>
  </div></body></html>`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!process.env.SUPABASE_SERVICE_KEY) return reply(500, { error: 'Server is missing SUPABASE_SERVICE_KEY.' });
  if (!process.env.RESEND_API_KEY) return reply(500, { error: 'Server is missing RESEND_API_KEY.' });

  let email = '';
  try { email = String(JSON.parse(event.body || '{}').email || '').trim().toLowerCase(); } catch (e) {}
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'Enter a valid email address.' });

  try {
    const allowed = await rpc('is_staff_email', { p_email: email });
    if (!allowed) return reply(403, { error: 'not_authorized' });

    const wait = await rpc('login_code_throttle', { p_email: email });
    if (wait > 0) return reply(429, { error: 'rate_limited', retryAfter: wait });

    // Generate a one-time code without Supabase sending any email
    const gl = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: serverHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ type: 'magiclink', email }),
    });
    const glData = await gl.json().catch(() => ({}));
    const code = glData.email_otp || (glData.properties && glData.properties.email_otp);
    if (!gl.ok || !code) {
      console.error('generate_link failed', gl.status, JSON.stringify(glData).slice(0, 300));
      return reply(502, { error: 'Could not create a sign-in code. Try again in a minute.' });
    }

    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'PropDesk <noreply@bentonvillelodgingcomanagement.com>',
        to: [email],
        subject: `${code} is your PropDesk sign-in code`,
        html: emailHtml(code),
        text: `Your PropDesk sign-in code is ${code}. It expires in 1 hour. If you didn't try to sign in, ignore this email.`,
      }),
    });
    if (!mail.ok) {
      const m = await mail.text();
      console.error('Resend error', mail.status, m.slice(0, 300));
      return reply(502, { error: 'Could not send the email. Try again in a minute.' });
    }
    return reply(200, { sent: true });
  } catch (e) {
    console.error('send-login-code error:', e.message);
    return reply(500, { error: 'Something went wrong sending the code.' });
  }
};
