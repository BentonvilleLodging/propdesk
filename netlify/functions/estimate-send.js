// netlify/functions/estimate-send.js
//
// Emails a saved estimate to the client. Staff only.
// POST { estimate_id, message? }  → { ok, sent_to }
//
// The email is rendered HERE from the saved row (doc + business_profile) — the browser can't
// supply HTML, so our sending domain can't be used to mail arbitrary content. Internal costs,
// cost notes and margin are never included. Sending is refused if the estimate is below the
// 30% margin floor (see lib/estimate-pricing.js).

const { requireTeam, SUPABASE_URL, PUBLISHABLE_KEY } = require('../lib/auth');
const I = require('../lib/intel');
const P = require('../lib/estimate-pricing');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const money = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (v) => { const x = Number(v) || 0; return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); };
const fmtDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });

async function whoAmI(event) {
  try {
    const tok = String((event.headers.authorization || event.headers.Authorization || '')).replace(/^Bearer\s+/i, '');
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + tok } });
    const u = await r.json();
    return u.email || null;
  } catch (e) { return null; }
}

function renderEmail(est, doc, biz, t, message) {
  const issued = new Date(est.created_at || Date.now());
  const valid = new Date(issued.getTime() + (Number(doc.valid_days) || Number(biz.valid_days) || 30) * 86400000);
  const bizLines = [biz.address, [biz.phone, biz.email].filter(Boolean).join(' · '), biz.website, biz.license ? 'License: ' + biz.license : null].filter(Boolean);
  const rows = (doc.lines || []).map((l) => `
    <tr>
      <td style="padding:9px 8px;border-bottom:1px solid #e8e4dc;vertical-align:top;">${nl(l.description)}${l.category ? `<div style="font-size:11px;color:#8a857a;margin-top:2px;">${esc(l.category)}</div>` : ''}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #e8e4dc;text-align:right;white-space:nowrap;vertical-align:top;">${esc(qtyFmt(l.qty))} ${esc(l.unit || '')}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #e8e4dc;text-align:right;white-space:nowrap;vertical-align:top;">${money(l.unit_price)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #e8e4dc;text-align:right;white-space:nowrap;vertical-align:top;">${money(P.r2(P.n(l.qty) * P.n(l.unit_price)))}</td>
    </tr>`).join('');
  const list = (title, arr) => (arr && arr.length ? `<div style="margin-top:18px;"><div style="font-weight:700;font-size:13px;margin-bottom:6px;">${esc(title)}</div><ul style="margin:0;padding-left:18px;color:#444;font-size:13px;line-height:1.5;">${arr.filter(Boolean).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '');
  const logo = biz.logo_data_url && /^data:image\//.test(biz.logo_data_url) ? `<img src="${esc(biz.logo_data_url)}" alt="" style="max-height:56px;max-width:180px;margin-bottom:8px;">` : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f2ee;font-family:Helvetica,Arial,sans-serif;color:#1d1b18;">
<div style="max-width:720px;margin:0 auto;padding:24px 14px;">
  ${message ? `<div style="background:#fff;border-radius:10px;padding:18px 22px;margin-bottom:14px;font-size:14px;line-height:1.55;">${nl(message)}</div>` : ''}
  <div style="background:#fff;border-radius:10px;padding:28px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top;">${logo}<div style="font-size:20px;font-weight:700;">${esc(biz.name || 'Bentonville Lodging Co.')}</div>
        ${biz.tagline ? `<div style="font-size:12px;color:#8a857a;">${esc(biz.tagline)}</div>` : ''}
        <div style="font-size:12px;color:#555;line-height:1.5;margin-top:6px;">${bizLines.map(esc).join('<br>')}</div></td>
      <td style="vertical-align:top;text-align:right;">
        <div style="font-size:22px;font-weight:700;color:#a8893f;letter-spacing:1px;">ESTIMATE</div>
        <div style="font-size:12px;color:#555;line-height:1.6;margin-top:4px;">${esc(est.estimate_number)}<br>Date: ${esc(fmtDate(issued))}<br>Valid until: ${esc(fmtDate(valid))}</div></td>
    </tr></table>
    <div style="margin-top:20px;padding:12px 14px;background:#f8f6f2;border-radius:8px;font-size:13px;line-height:1.5;">
      <div style="font-size:11px;color:#8a857a;text-transform:uppercase;letter-spacing:1px;">Prepared for</div>
      <strong>${esc(est.client_name || '')}</strong>${est.client_address ? '<br>' + nl(est.client_address) : ''}${est.client_email ? '<br>' + esc(est.client_email) : ''}${est.client_phone ? '<br>' + esc(est.client_phone) : ''}
    </div>
    ${doc.project_title ? `<div style="font-size:17px;font-weight:700;margin-top:20px;">${esc(doc.project_title)}</div>` : ''}
    ${doc.scope_summary ? `<div style="font-size:13px;color:#444;line-height:1.55;margin-top:6px;">${nl(doc.scope_summary)}</div>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;font-size:13px;border-collapse:collapse;">
      <tr style="background:#1d1b18;color:#fff;"><th style="padding:9px 8px;text-align:left;">Description</th><th style="padding:9px 8px;text-align:right;">Qty</th><th style="padding:9px 8px;text-align:right;">Unit price</th><th style="padding:9px 8px;text-align:right;">Amount</th></tr>
      ${rows}
    </table>
    <table cellpadding="0" cellspacing="0" style="margin-top:12px;margin-left:auto;font-size:13px;min-width:260px;">
      <tr><td style="padding:4px 8px;color:#555;">Subtotal</td><td style="padding:4px 8px;text-align:right;">${money(t.subtotal)}</td></tr>
      <tr><td style="padding:4px 8px;color:#555;">Overhead (10%)</td><td style="padding:4px 8px;text-align:right;">${money(t.overhead)}</td></tr>
      <tr><td style="padding:4px 8px;color:#555;">Sales tax (7.2%)</td><td style="padding:4px 8px;text-align:right;">${money(t.tax)}</td></tr>
      <tr><td style="padding:8px;font-weight:700;font-size:15px;border-top:2px solid #1d1b18;">Total</td><td style="padding:8px;text-align:right;font-weight:700;font-size:15px;border-top:2px solid #1d1b18;">${money(t.total)}</td></tr>
    </table>
    ${doc.timeline ? `<div style="margin-top:18px;font-size:13px;"><strong>Estimated timeline:</strong> ${esc(doc.timeline)}</div>` : ''}
    ${list('Assumptions', doc.assumptions)}
    ${list('Not included', doc.exclusions)}
    ${doc.notes ? `<div style="margin-top:18px;font-size:13px;line-height:1.55;"><strong>Notes</strong><br>${nl(doc.notes)}</div>` : ''}
    ${biz.terms ? `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #e8e4dc;font-size:11px;color:#8a857a;line-height:1.5;">${nl(biz.terms)}</div>` : ''}
  </div>
  <div style="text-align:center;font-size:11px;color:#8a857a;margin-top:14px;">Questions or ready to approve? Just reply to this email.</div>
</div></body></html>`;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!(await requireTeam(event, ['staff']))) return reply(401, { error: 'Not authorized' });
  if (!process.env.RESEND_API_KEY) return reply(500, { error: 'RESEND_API_KEY not set' });

  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Invalid JSON' }); }
  const id = Number(b.estimate_id);
  if (!Number.isInteger(id) || id <= 0) return reply(400, { error: 'estimate_id required' });
  const message = String(b.message || '').slice(0, 3000);

  try {
    const [est] = await I.sbSelect('estimates', `id=eq.${id}&select=*`);
    if (!est) return reply(404, { error: 'Estimate not found' });
    const doc = est.doc || {};
    if (!doc.lines || !doc.lines.length) return reply(400, { error: 'This estimate has no line items yet.' });
    const to = String(est.client_email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return reply(400, { error: 'Add a valid client email before sending.' });
    const t = P.totals(doc.lines);
    if (!t.meets_floor) return reply(400, { error: `Margin is ${(t.margin * 100).toFixed(1)}% — below the 30% minimum. Raise prices before sending.` });

    const [biz] = await I.sbSelect('business_profile', 'id=eq.1&select=*').catch(() => [{}]);
    const sender = await whoAmI(event);
    const html = renderEmail(est, doc, biz || {}, t, message);
    const subject = `Estimate ${est.estimate_number}${doc.project_title ? ' — ' + doc.project_title : ''} from ${(biz && biz.name) || 'Bentonville Lodging Co.'}`.slice(0, 200);

    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${String((biz && biz.name) || 'Bentonville Lodging Co.').replace(/[<>"]/g, '')} <noreply@bentonvillelodgingcomanagement.com>`,
        to: [to],
        ...(sender ? { reply_to: sender, cc: [sender] } : {}),
        subject,
        html,
      }),
    });
    const data = await mail.json().catch(() => ({}));
    if (!mail.ok) return reply(502, { error: 'Email failed: ' + (data.message || data.name || mail.status) });

    await I.sbPatch('estimates', `id=eq.${id}`, { status: 'sent', sent_at: new Date().toISOString(), sent_to: to, totals: t, margin_pct: t.margin, updated_at: new Date().toISOString() });
    return reply(200, { ok: true, sent_to: to, id: data.id });
  } catch (e) {
    console.error('estimate-send', e.message);
    return reply(500, { error: e.message });
  }
};
