// netlify/functions/estimate-ai-background.js
//
// AI estimate generator (Background Function, staff only).
// POST { estimate_id }  — the browser first inserts an `estimates` row (status 'generating')
// with client details + request_text, then calls this. The result is written back to the
// row (status 'ready' | 'error'); the estimator polls the row.
//
// Claude is called ONLY from here, and only when a person clicks "Generate Estimate".
// Budget: 10 calls per day (America/Chicago) via estimate_budget_reserve — completely
// separate from the 2/week claude_api_calls budget used by the Listing Intelligence agent.
//
// Claude estimates BLC's internal COST for each line (materials, labor, equipment, subs...).
// Client prices are computed in code (lib/estimate-pricing.js) so every estimate clears the
// 30% margin floor after 10% overhead. Margin is never shown to the client.

const { requireTeam } = require('../lib/auth');
const I = require('../lib/intel');
const P = require('../lib/estimate-pricing');

const CATEGORIES = ['Labor', 'Materials', 'Equipment', 'Subcontractor', 'Disposal', 'Permits & Fees', 'Other'];

const SYSTEM = `You are the senior estimator for Bentonville Lodging Co. (BLC), a property-management and property-services company in Bentonville / Northwest Arkansas (Benton & Washington counties). BLC does repair, maintenance, renovation, turnover, landscaping/exterior, furnishing/setup and general contracting-style projects for property owners. Build a realistic, complete first-draft estimate for the project described.

You estimate BLC's INTERNAL COST for each line — NOT the client price. The system adds markup, 10% overhead and 7.2% sales tax itself, so never include profit, markup, overhead or tax in any number.

Cost guidance (Northwest Arkansas, current year):
- Materials: current big-box retail (Lowe's / Home Depot / local supply) for the quality level implied; add normal waste (about 10% for flooring/tile/drywall/paint/lumber). Use realistic quantities derived from the dimensions given; if dimensions are missing, assume typical sizes and state the assumption.
- Labor: BLC in-house crew at loaded cost per hour — general handyman/maintenance about $35–45/hr, skilled carpentry/tile/finish about $45–60/hr, helpers about $25–30/hr. Estimate hours per task realistically (include setup, protection, cleanup). Use separate labor lines by task or trade when that makes the estimate clearer.
- Licensed trades (electrical, plumbing, HVAC, roofing, structural) normally go as Subcontractor lines at typical NWA sub pricing.
- Include where relevant: equipment/tool rental, dumpster or haul-off & disposal fees, permits/inspection fees, delivery, trip/mobilization charge.
- Round quantities sensibly. Every line must have qty > 0 and unit_cost ≥ 0.

Line descriptions are CLIENT-FACING: clear, professional, specific (e.g. "Remove and dispose of existing carpet and pad — living room & hall"). Don't mention BLC's costs, wages, markup or suppliers in descriptions. Put internal reasoning in cost_basis.

Do not invent facts about the property or client. If important information is missing, make a reasonable, typical assumption, list it under assumptions, and add what should be verified on site to internal_questions.

Return ONLY a JSON object, no markdown:
{"project_title":"short client-facing title","scope_summary":"2-4 sentences, client-facing","line_items":[{"category":"${CATEGORIES.join('|')}","description":"","qty":0,"unit":"hr|ea|sq ft|ln ft|sq|day|gal|lot|trip","unit_cost":0,"cost_basis":"internal: how you got the cost/qty"}],"assumptions":["client-facing"],"exclusions":["client-facing"],"timeline":"e.g. 2–3 working days","internal_questions":["things BLC should verify before sending"]}`;

const clip = (s, n) => (s == null ? '' : String(s).slice(0, n));

async function callClaude(user) {
  const apiKey = process.env.CLAUDE_SECRET;
  if (!apiKey) throw new Error('CLAUDE_SECRET env var not set');
  const model = process.env.ESTIMATE_MODEL || I.CLAUDE_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8 * 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({ model, max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(user) }] }),
    });
    const raw = await res.text();
    if (!res.ok) { const e = new Error(`Claude API ${res.status}: ${raw.slice(0, 300)}`); e.http = true; throw e; }
    const msg = JSON.parse(raw);
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { json: I.extractJson(text), usage: { ...(msg.usage || {}), stop_reason: msg.stop_reason, model } };
  } finally { clearTimeout(timer); }
}

function buildDoc(ai, profileValidDays) {
  const lines = (Array.isArray(ai.line_items) ? ai.line_items : []).slice(0, 80).map((l, i) => {
    const cost = Math.max(0, P.n(l.unit_cost));
    const qty = P.n(l.qty) > 0 ? P.r2(P.n(l.qty)) : 1;
    return {
      id: 'l' + (i + 1),
      category: CATEGORIES.includes(l.category) ? l.category : 'Other',
      description: clip(l.description, 500),
      qty,
      unit: clip(l.unit || 'ea', 20),
      unit_cost: P.r2(cost),
      unit_price: P.priceForCost(cost),
      cost_basis: clip(l.cost_basis, 400),
    };
  }).filter((l) => l.description);
  return {
    project_title: clip(ai.project_title, 140),
    scope_summary: clip(ai.scope_summary, 1500),
    lines,
    assumptions: (Array.isArray(ai.assumptions) ? ai.assumptions : []).slice(0, 15).map((s) => clip(s, 300)),
    exclusions: (Array.isArray(ai.exclusions) ? ai.exclusions : []).slice(0, 15).map((s) => clip(s, 300)),
    timeline: clip(ai.timeline, 200),
    internal_questions: (Array.isArray(ai.internal_questions) ? ai.internal_questions : []).slice(0, 12).map((s) => clip(s, 300)),
    notes: '',
    valid_days: profileValidDays || 30,
    generated_at: new Date().toISOString(),
  };
}

exports.handler = async function (event) {
  if (!(await requireTeam(event, ['staff']))) { console.warn('estimate-ai: unauthorized'); return; }
  let id = null;
  try { id = Number(JSON.parse(event.body || '{}').estimate_id); } catch (e) {}
  if (!Number.isInteger(id) || id <= 0) return;

  const [row] = await I.sbSelect('estimates', `id=eq.${id}&select=*`).catch(() => []);
  if (!row) return;
  const fail = (msg) => I.sbPatch('estimates', `id=eq.${id}`, { status: 'error', error: clip(msg, 500), updated_at: new Date().toISOString() }).catch(() => {});
  if (!row.request_text || String(row.request_text).trim().length < 10) return fail('Describe the project in a bit more detail, then try again.');

  let slot;
  try {
    slot = await I.sbRpc('estimate_budget_reserve', { p_estimate_id: id });
    if (!slot || !slot.ok) return fail((slot && slot.reason) || 'Daily estimate limit reached.');
  } catch (e) { return fail('Could not check the estimate budget: ' + e.message); }

  try {
    const [profile] = await I.sbSelect('business_profile', 'id=eq.1&select=valid_days').catch(() => []);
    const out = await callClaude({
      today: I.today(),
      project_description: clip(row.request_text, 6000),
      client: { name: row.client_name || null, property_address: row.client_address || null },
      location: 'Northwest Arkansas (Bentonville area) unless the address says otherwise',
    });
    const doc = buildDoc(out.json || {}, profile && profile.valid_days);
    if (!doc.lines.length) throw new Error('Claude did not return any line items.');
    const t = P.totals(doc.lines);
    await I.sbPatch('estimates', `id=eq.${id}`, { status: 'ready', doc, totals: t, margin_pct: t.margin, error: null, updated_at: new Date().toISOString() });
    await I.sbRpc('estimate_budget_settle', { p_id: slot.id, p_status: 'ok', p_usage: out.usage, p_error: null }).catch(() => {});
  } catch (e) {
    console.error('estimate-ai failed', e.message);
    // HTTP errors from the API mean nothing was generated → refund the slot.
    await I.sbRpc('estimate_budget_settle', { p_id: slot.id, p_status: e.http ? 'refunded' : 'error', p_usage: null, p_error: e.message }).catch(() => {});
    await fail('Estimate generation failed: ' + e.message);
  }
};
