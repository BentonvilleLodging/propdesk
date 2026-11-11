// netlify/lib/trust.js — PropDesk trust layer.
//
// Two jobs, enforced in code (not just by prompts):
//
// 1. ONE gateway to Claude. anthropicFetch() is the only code allowed to call api.anthropic.com
//    (tests/trust.test.js fails the build otherwise). Before anything leaves, every guest/user-
//    supplied message is scrubbed: payment card numbers, SSNs, bank account/routing numbers,
//    email addresses and phone numbers are replaced with [… removed]. Claude never receives an
//    API key, a Guesty/PriceLabs token, or a tool that can call our systems — it only returns
//    text/JSON, and our code decides what (if anything) to do with it.
//
// 2. A WRITE ALLOWLIST for Guesty and PriceLabs. assertWrite() is called before every
//    non-read request. Anything not listed here is refused — reservations, guests, payments,
//    payouts, owners, accounting, fees/taxes, users, integrations, account settings. So even a
//    bug or a manipulated AI output can't change the business model or banking details.
//
// Allowed writes (Luke, Nov 2026):
//   Guesty     PUT /v1/listings/{id}                  title + public description text only (staff)
//              PUT /v1/properties-api/amenities/{id}  amenities list only (staff)
//   PriceLabs  POST/DELETE /v1/listings/{id}/overrides  date price + min stay only
//              POST /v1/listings                      base / min / max price only (staff)
//              POST /v1/listing_prices                read-only lookup (PriceLabs uses POST)

// ── 1. Redaction ────────────────────────────────────────────────────────
function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

const RULES = [
  // Card: 13–16 digits starting 3–6 (Amex/Visa/MC/Discover ranges), optional spaces/dashes, Luhn-valid.
  { type: 'card', re: /\b[3-6](?:[ -]?\d){12,15}\b/g, ok: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 16 && luhn(d); }, label: '[card number removed]' },
  { type: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, label: '[SSN removed]' },
  // "routing 123456789", "acct # 000123456789", "account number: 12345678"
  { type: 'bank', re: /\b(?:routing|aba|acct|account)(?:\s*(?:no\.?|number|num|#))?\s*[:#]?\s*\d{6,17}\b/gi, label: '[bank number removed]' },
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: '[email removed]' },
  { type: 'phone', re: /(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/g, label: '[phone removed]' },
];

// redact('text') → { text, found: ['card', ...] }
function redact(input) {
  if (typeof input !== 'string' || !input) return { text: input, found: [] };
  let text = input; const found = new Set();
  for (const r of RULES) {
    text = text.replace(r.re, (m) => { if (r.ok && !r.ok(m)) return m; found.add(r.type); return r.label; });
  }
  return { text, found: Array.from(found) };
}

// Redact every string inside a JSON value (objects/arrays walked; keys left alone).
function redactDeep(v) {
  if (typeof v === 'string') return redact(v).text;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = redactDeep(v[k]); }); return o; }
  return v;
}

// Scrub the user-side turns of a Messages API body. System prompts (our own instructions and
// the home guide — which intentionally includes door codes on check-in day) and assistant turns
// are ours and pass through unchanged.
function scrubBody(body) {
  const messages = (body.messages || []).map((m) => {
    if (m.role !== 'user') return m;
    if (typeof m.content === 'string') return { ...m, content: redactJsonString(m.content) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map((b) => (b && b.type === 'text' ? { ...b, text: redactJsonString(b.text) } : b)) };
    return m;
  });
  return { ...body, messages };
}
// A JSON payload is redacted value-by-value so the JSON stays valid; plain text is redacted directly.
function redactJsonString(s) {
  const t = String(s).trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.stringify(redactDeep(JSON.parse(t))); } catch (e) { /* not JSON */ } }
  return redact(s).text;
}

// The ONLY function in PropDesk that talks to Anthropic.
async function anthropicFetch(body, { signal } = {}) {
  const apiKey = process.env.CLAUDE_SECRET;
  if (!apiKey) throw new Error('CLAUDE_SECRET env var not set');
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
    },
    body: JSON.stringify(scrubBody(body)),
  });
}

// ── 2. Write allowlist ──────────────────────────────────────────────────
const ID = '[A-Za-z0-9_-]+';
const onlyKeys = (obj, allowed) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => allowed.includes(k));
const DESC_KEYS = ['summary', 'space', 'access', 'interactionWithGuests', 'neighborhood', 'transit', 'notes', 'houseRules'];
const OVERRIDE_KEYS = ['date', 'price', 'price_type', 'currency', 'min_stay', 'reason'];

const ALLOW = {
  guesty: [
    { method: 'PUT', path: new RegExp(`^/v1/listings/${ID}$`), body: (b) => onlyKeys(b, ['title', 'publicDescription']) && (b.publicDescription == null || onlyKeys(b.publicDescription, DESC_KEYS)) },
    { method: 'PUT', path: new RegExp(`^/v1/properties-api/amenities/${ID}$`), body: (b) => onlyKeys(b, ['amenities']) && Array.isArray(b.amenities) },
  ],
  pricelabs: [
    { method: 'POST', path: new RegExp(`^/v1/listings/${ID}/overrides$`), body: (b) => onlyKeys(b, ['pms', 'overrides', 'update_children']) && Array.isArray(b.overrides) && b.overrides.every((o) => onlyKeys(o, OVERRIDE_KEYS)) },
    { method: 'DELETE', path: new RegExp(`^/v1/listings/${ID}/overrides$`), body: (b) => onlyKeys(b, ['pms', 'overrides', 'update_children']) && Array.isArray(b.overrides) && b.overrides.every((o) => onlyKeys(o, ['date'])) },
    { method: 'POST', path: /^\/v1\/listings$/, body: (b) => onlyKeys(b, ['listings']) && Array.isArray(b.listings) && b.listings.every((l) => onlyKeys(l, ['id', 'pms', 'base', 'min', 'max'])) },
    { method: 'POST', path: /^\/v1\/listing_prices$/, body: (b) => onlyKeys(b, ['listings']) },
  ],
};

class TrustError extends Error {}

// Throws unless (service, method, path, body) is on the allowlist. GETs are always allowed.
function assertWrite(service, method, path, body) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET') return true;
  const p = String(path || '').split('?')[0];
  const rules = ALLOW[service] || [];
  const rule = rules.find((r) => r.method === m && r.path.test(p));
  if (!rule) throw new TrustError(`Blocked by PropDesk trust layer: ${service} ${m} ${p} is not an allowed write.`);
  if (!rule.body(body || {})) throw new TrustError(`Blocked by PropDesk trust layer: ${service} ${m} ${p} tried to change fields outside the allowlist.`);
  return true;
}

module.exports = { redact, redactDeep, scrubBody, anthropicFetch, assertWrite, TrustError, ALLOW };
