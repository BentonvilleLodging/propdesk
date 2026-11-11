// node tests/trust.test.js — PropDesk trust layer (no network). Fails if:
//   • sensitive numbers survive redaction, or ordinary data gets mangled
//   • a Guesty / PriceLabs write outside the allowlist is accepted
//   • any file other than lib/trust.js calls Claude directly, or writes to Guesty/PriceLabs
//     without going through assertWrite
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../netlify/lib/trust');

// ── redaction ──
const r = T.redact('my card is 4242 4242 4242 4242 exp 12/28, ssn 123-45-6789, routing 021000021 acct # 000123456789, email jo@x.com, call (479) 555-0100');
assert(!/4242/.test(r.text) && !/123-45-6789/.test(r.text) && !/021000021/.test(r.text) && !/000123456789/.test(r.text) && !/jo@x\.com/.test(r.text) && !/555-0100/.test(r.text), r.text);
assert.deepStrictEqual(r.found.sort(), ['bank', 'card', 'email', 'phone', 'ssn']);
assert(T.redact('Amex 3782-822463-10005').found.includes('card'));
// things that must NOT be touched
const keep = 'Check-in 2026-11-18, $189/night, door code 4821, wifi pass Trail2026!, Airbnb 1234567890123456789, listing 6ac0fabfe8219f001232d158, ts 1731320000000, 4 bedrooms';
assert.strictEqual(T.redact(keep).text, keep);
assert.strictEqual(T.redact('4111 1111 1111 1112').found.length, 0); // fails Luhn → left alone

// JSON payloads stay valid JSON after scrubbing; system + assistant turns untouched
const body = T.scrubBody({ system: 'door code 4821, owner phone 479-555-0100', messages: [
  { role: 'user', content: JSON.stringify({ reviews: [{ text: 'Host gave us his cell 479-555-0199' }], price: 189 }) },
  { role: 'assistant', content: 'Your door code is 4821' },
  { role: 'user', content: [{ type: 'text', text: 'here is my card 4242424242424242' }] },
] });
assert.strictEqual(body.system, 'door code 4821, owner phone 479-555-0100');
const j = JSON.parse(body.messages[0].content);
assert.strictEqual(j.price, 189); assert(/\[phone removed\]/.test(j.reviews[0].text));
assert.strictEqual(body.messages[1].content, 'Your door code is 4821');
assert(/\[card number removed\]/.test(body.messages[2].content[0].text));

// ── write allowlist ──
const ok = (s, m, p, b) => assert.doesNotThrow(() => T.assertWrite(s, m, p, b), `${s} ${m} ${p} should be allowed`);
const no = (s, m, p, b) => assert.throws(() => T.assertWrite(s, m, p, b), T.TrustError, `${s} ${m} ${p} should be blocked`);
ok('guesty', 'GET', '/v1/reservations?x=1');
ok('guesty', 'PUT', '/v1/listings/6ac0fabfe8219f001232d158', { title: 'Hot Tub Cabin', publicDescription: { summary: 'x' } });
ok('guesty', 'PUT', '/v1/properties-api/amenities/abc123', { amenities: ['Hot tub'] });
no('guesty', 'PUT', '/v1/listings/abc', { prices: { basePrice: 1 } });                        // financial field
no('guesty', 'PUT', '/v1/listings/abc', { publicDescription: { summary: 'x' }, terms: { minNights: 1 } });
no('guesty', 'PUT', '/v1/listings/abc', { title: 'x', owners: ['someone'] });
no('guesty', 'PUT', '/v1/listings/abc', { publicDescription: { summary: 'x', bankAccount: '1' } });
no('guesty', 'POST', '/v1/reservations', {});
no('guesty', 'PUT', '/v1/reservations/abc', { status: 'canceled' });
no('guesty', 'POST', '/v1/guests-crud', {});
no('guesty', 'POST', '/v1/payments', {});
no('guesty', 'PUT', '/v1/owners/abc', {});
no('guesty', 'PUT', '/v1/accounts/me', {});
no('guesty', 'DELETE', '/v1/listings/abc', {});
no('guesty', 'PUT', '/v1/listings/abc/../../accounts/me', { title: 'x' });
ok('pricelabs', 'POST', '/v1/listings/L1/overrides', { pms: 'guesty', update_children: false, overrides: [{ date: '2026-11-18', price: '189', price_type: 'fixed', currency: 'USD', min_stay: 2, reason: 'PropDesk autopilot' }] });
ok('pricelabs', 'DELETE', '/v1/listings/L1/overrides', { pms: 'guesty', overrides: [{ date: '2026-11-18' }] });
ok('pricelabs', 'POST', '/v1/listings', { listings: [{ id: 'L1', pms: 'guesty', base: 200 }] });
ok('pricelabs', 'POST', '/v1/listing_prices', { listings: [] });
no('pricelabs', 'POST', '/v1/listings', { listings: [{ id: 'L1', pms: 'guesty', push_enabled: false }] });
no('pricelabs', 'POST', '/v1/listings/L1/overrides', { pms: 'guesty', overrides: [{ date: '2026-11-18', price: '1', check_in: false }] });
no('pricelabs', 'POST', '/v1/add_listing_data', {});

// ── static scan: nothing bypasses the trust layer ──
const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { if (f === 'node_modules' || f.startsWith('.')) continue; const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs|html)$/.test(f) && !p.includes(`${path.sep}tests${path.sep}`)) files.push(p); } })(ROOT);
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8'); const rel = path.relative(ROOT, f);
  if (rel !== path.join('netlify', 'lib', 'trust.js')) assert(!/api\.anthropic\.com/.test(src), `${rel} calls Claude directly — use T.anthropicFetch (lib/trust.js)`);
  if (/assertWrite\(/.test(src)) continue;
  // Files without the gate may only READ Guesty / PriceLabs (token requests excepted).
  const re = /(open-api\.guesty\.com|api\.pricelabs\.co)([^\n]*)/g; let m;
  while ((m = re.exec(src))) {
    if (/oauth2\/token/.test(m[2])) continue;
    const after = src.slice(m.index, m.index + 400);
    assert(!/method:\s*['"`]?(PUT|POST|PATCH|DELETE)/i.test(after) && !/method,/.test(after), `${rel} writes to ${m[1]} without T.assertWrite`);
  }
}

console.log('trust tests passed');
