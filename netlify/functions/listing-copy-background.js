// netlify/functions/listing-copy-background.js
//
// Claude writes an SEO/conversion-optimized rewrite of a listing's title and description
// sections, suggests a target-guest persona, and flags high-value amenities that the
// evidence says the home has but that aren't ticked (missed Airbnb search filters).
// GET/POST ?listing_id=...  → listing_content_drafts row (pending → done | error).
// Nothing is published here — the team reviews/edits and publishes from the workspace.

const { requireTeam } = require('../lib/auth');
const I = require('../lib/intel');
const { getContent } = require('./listing-workspace');

const PROMPT = `You are an Airbnb listing copywriter and search-optimization specialist for Bentonville Lodging Co. (Bentonville / Northwest Arkansas: world-class mountain-bike trails, Razorback Greenway, Crystal Bridges & the Momentary, downtown Bentonville Square, Walmart Home Office business travel, Beaver Lake, Slaughter Pen, Coler Preserve).

Goal: more clicks from search (title + first lines) and more bookings (clear, specific, benefit-led description), and appearing in more searches (Airbnb's AI search and filters read the description and amenities).

Rules for the rewrite:
- TITLE: max 50 characters (hard limit). Lead with the single most compelling, TRUE differentiator for the target guest (e.g. "Hot Tub", "Walk to Square", "Trailside", "Lake Views", "Bike Storage"), plus a place cue. No ALL CAPS, no emoji spam, no claims you can't verify from the data.
- SUMMARY: the first ~2 lines show before "Show more" — make them a hook: who it's perfect for + top 2–3 benefits. Then short scannable paragraphs. 400–900 characters.
- SPACE: room-by-room, beds (be specific about bed sizes only if known), standout features, what makes stays easy (self check-in, parking, workspace, bike gear). Use short lines.
- NEIGHBORHOOD / TRANSIT ("getting around"): only use locations/distances that appear in the current text, the listing title, reviews, or the facts given. If a distance isn't in the data, describe proximity qualitatively ("a short ride to…") or leave it out. Never invent distances, amenities, or features.
- Keep ACCESS, INTERACTION, NOTES and HOUSE RULES factual; only tighten wording, never change rules or remove safety/legal content. If a section is empty and you have nothing factual to add, leave it as "".
- Weave in natural phrases guests actually search ("pet friendly" only if pets allowed, "hot tub", "king bed", "dedicated workspace", "walk to downtown", "bike storage", "fire pit", "family friendly", "EV charger") — only when true.
- Use what guests praise in reviews as proof points (paraphrase, don't quote names).
- Persona: suggest the primary target guest and secondary guests based on location, amenities, bedrooms/sleeps and who leaves reviews.
- Amenities: list high-value Airbnb filter amenities that the evidence (description text, reviews, photos captions) suggests the home HAS but that are not in the current amenities list — these are missed search filters. Also list amenities worth ADDING physically for this persona.

Return ONLY JSON:
{"persona": {"primary": "", "secondary": "", "selling_points": ["", ""], "search_phrases": ["", ""]},
 "title": "", "title_alternatives": ["", ""],
 "summary": "", "space": "", "access": "", "interactionWithGuests": "", "neighborhood": "", "transit": "", "notes": "", "houseRules": "",
 "rationale": "3-5 bullet-style sentences explaining the main changes and why they should lift CTR/conversion",
 "missing_amenities_to_tick": [{"amenity": "", "evidence": ""}],
 "amenities_to_add_physically": [{"amenity": "", "why": ""}]}`;

exports.handler = async function (event) {
  if (!(await requireTeam(event, ['staff']))) { console.warn('listing-copy: unauthorized'); return; }
  const qs = event.queryStringParameters || {};
  let lid = qs.listing_id;
  try { if (!lid && event.body) lid = JSON.parse(event.body).listing_id; } catch (e) {}
  if (!lid) return;
  const [row] = await I.sbInsert('listing_content_drafts', [{ listing_id: lid, status: 'pending', model: I.CLAUDE_MODEL }]);
  try {
    const live = await getContent(lid);
    const [profile, analysis, reviews, intel, reg, comp] = await Promise.all([
      I.sbSelect('listing_profile', `listing_id=eq.${lid}&select=*`).catch(() => []),
      I.sbSelect('listing_analyses', `listing_id=eq.${lid}&select=summary,review_themes,search_actions&order=created_at.desc&limit=1`).catch(() => []),
      I.sbSelect('guesty_reviews', `listing_id=eq.${lid}&select=rating_5,public_review,reviewed_at&public_review=not.is.null&order=reviewed_at.desc&limit=30`).catch(() => []),
      I.sbSelect('pricelabs_intel', `listing_id=eq.${lid}&select=optimizer,neighborhood&order=snapshot_date.desc&limit=1`).catch(() => []),
      I.sbSelect('listing_registry', `listing_id=eq.${lid}&select=nickname,bedrooms,accommodates`).catch(() => []),
      I.sbSelect('listing_completeness_snapshots', `listing_id=eq.${lid}&select=photo_count,raw&order=snapshot_date.desc&limit=1`).catch(() => []),
    ]);
    const out = await I.claude({
      system: PROMPT,
      maxTokens: 5000,
      user: {
        listing: reg[0] || {}, facts: live.facts,
        current_content: live.content,
        current_amenities: live.amenities.supported.concat(live.amenities.other),
        team_persona: profile[0] ? { primary: profile[0].target_guest, secondary: profile[0].secondary_guests, selling_points: profile[0].selling_points, keywords: profile[0].keywords } : null,
        listing_optimizer: intel[0] ? intel[0].optimizer : null,
        latest_analysis: analysis[0] || null,
        reviews: reviews.map((r) => ({ stars: r.rating_5, text: String(r.public_review).slice(0, 400) })),
        photo_count: comp[0] ? comp[0].photo_count : null,
      },
    });
    const j = out.json || {};
    if (j.title) j.title = String(j.title).slice(0, 50);
    await I.sbPatch('listing_content_drafts', `id=eq.${row.id}`, { status: 'done', proposal: j, completed_at: new Date().toISOString() });
    // Save Claude's persona as a suggestion (team-set values are never overwritten)
    if (j.persona) {
      const p = profile[0];
      await I.sbUpsert('listing_profile', [{
        listing_id: lid, suggested: j.persona,
        target_guest: p && p.target_guest ? p.target_guest : null,
        secondary_guests: p && p.secondary_guests ? p.secondary_guests : null,
        selling_points: p && p.selling_points ? p.selling_points : null,
        keywords: p && p.keywords ? p.keywords : null,
        updated_at: new Date().toISOString(), updated_by: p ? p.updated_by : 'claude',
      }], 'listing_id');
    }
  } catch (e) {
    console.error('listing-copy failed', e.message);
    await I.sbPatch('listing_content_drafts', `id=eq.${row.id}`, { status: 'error', error: e.message.slice(0, 500), completed_at: new Date().toISOString() }).catch(() => {});
  }
};
