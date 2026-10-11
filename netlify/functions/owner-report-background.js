// netlify/functions/owner-report-background.js
//
// Generates an OWNER-FACING property improvement report for one listing
// (POST/GET ?listing_id=...). Background Function: writes a row to owner_reports
// (status pending → done | error); the Search Health page polls for it.
//
// The report is written in clean, factual language for the property owner:
// performance vs the local market, what guests love, recurring guest feedback,
// and ranked property improvements (with rough cost and expected benefit) that
// would help bookings. Private guest feedback informs themes but is never quoted.

const { requireTeam } = require('../lib/auth');
const I = require('../lib/intel');
const { buildPacks } = require('./listing-intel-analyze-background');

const PROMPT = `You write property performance and improvement reports that Bentonville Lodging Co. (a professional short-term-rental manager in Northwest Arkansas) sends to the OWNERS of homes it manages. Tone: clear, factual, professional, constructive — no hype, no internal jargon, no blame. The owner should finish reading knowing how their home is performing versus the local market, what guests love, and which improvements would most help bookings and reviews.

Rules:
- Base every statement on the data provided. Quote guests only from PUBLIC reviews (short quotes, no guest names). Private feedback may inform themes but must never be quoted or attributed.
- Improvement opportunities must be physical/property items or purchases the owner controls (furniture, mattresses, linens, appliances, amenities like hot tub/fire pit/EV charger/game room/workspace, repairs, exterior, photography refresh, safety items). Tie each to evidence: recurring review mentions, below-5 category ratings, amenities that comparable listings offer, or listing-optimizer scores. Rank by expected impact on bookings/reviews. Give a realistic cost range in USD and the expected benefit.
- Do not mention management fees, BLC's internal settings, or PriceLabs by name; refer to "our pricing strategy" if needed.
- If data is thin (few reviews), say so plainly and keep recommendations modest.

Return ONLY JSON:
{"title": "", "headline": "1-2 sentence takeaway", "performance": {"summary": "3-4 sentences", "stats": [{"label": "", "value": "", "context": ""}]}, "guest_highlights": [{"theme": "", "quote": ""}], "feedback_to_address": [{"theme": "", "detail": ""}], "improvement_opportunities": [{"item": "", "why": "", "priority": "high|medium|low", "est_cost": "", "expected_benefit": ""}], "management_actions": ["things Bentonville Lodging Co. is doing on its side"], "next_steps": ""}`;

exports.handler = async function (event) {
  if (!(await requireTeam(event, ['staff']))) { console.warn('owner-report: unauthorized'); return; }
  const qs = event.queryStringParameters || {};
  let lid = qs.listing_id;
  try { if (!lid && event.body) lid = JSON.parse(event.body).listing_id; } catch (e) {}
  if (!lid) return;
  const [row] = await I.sbInsert('owner_reports', [{ listing_id: lid, status: 'pending', model: I.CLAUDE_MODEL }]);
  try {
    const packs = await buildPacks(lid);
    if (!packs.length) throw new Error('Listing not found or not tracked.');
    const p = packs[0];
    const pack = JSON.parse(JSON.stringify(p.pack));
    // owner-safe: strip internal-only fields
    if (pack.reviews) delete pack.reviews.private_feedback_internal;
    delete pack.pricelabs_current_settings; delete pack.data_errors; delete pack.portfolio_avg_occ30;
    const latest = await I.sbSelect('listing_analyses', `select=review_themes,owner_items,summary&listing_id=eq.${lid}&order=created_at.desc&limit=1`).catch(() => []);
    const out = await I.claude({
      system: PROMPT,
      user: { today: I.today(), property: p.name, data: pack, internal_analysis_hints: latest[0] ? { review_themes: latest[0].review_themes, suggested_owner_items: latest[0].owner_items } : null },
      maxTokens: 4000,
    });
    await I.sbPatch('owner_reports', `id=eq.${row.id}`, { status: 'done', report: { ...out.json, property: p.name, generated: I.today() }, completed_at: new Date().toISOString() });
  } catch (e) {
    console.error('owner-report failed:', e.message);
    await I.sbPatch('owner_reports', `id=eq.${row.id}`, { status: 'error', error: e.message.slice(0, 500), completed_at: new Date().toISOString() }).catch(() => {});
  }
};
