// node tests/apply.test.js — PriceLabs "enable min stay customization" fallback in autopilot-apply (no network)
const assert = require('assert');
const I = require('../netlify/lib/intel');
const A = require('../netlify/lib/autopilot-apply');

const patches = [], inserts = [], upserts = [], posts = [];
I.sbPatch = async (t, f, b) => { patches.push({ t, f, b }); };
I.sbInsert = async (t, rows) => { inserts.push({ t, rows }); return rows.map((r, i) => ({ id: 900 + i, ...r })); };
I.sbUpsert = async (t, rows) => { upserts.push({ t, rows }); };
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  posts.push(body.overrides);
  const bad = body.overrides.find((o) => o.min_stay != null);
  if (bad) return { ok: false, status: 400, text: async () => JSON.stringify({ date: bad.date, error: 'Min stay cannot be set for this listing on this date. Enable min stay customization first.' }) };
  return { ok: true, status: 200, text: async () => '{}' };
};

(async () => {
  // Mirrors Hummingbird on 2026-11-09: price + min stay 1 on every date, plus one min-stay-only date.
  const props = [
    { id: 1, kind: 'set', stay_date: '2026-11-18', current_price: 210, proposed_price: 189, proposed_min_stay: 1, current_min_stay: 2 },
    { id: 2, kind: 'set', stay_date: '2026-11-19', current_price: 210, proposed_price: 195, proposed_min_stay: null, current_min_stay: 2 },
    { id: 3, kind: 'set', stay_date: '2026-11-20', current_price: 210, proposed_price: null, proposed_min_stay: 1, current_min_stay: 2 },
  ];
  const r = await A.applyProposals('L1', props, { who: 'agent', auto: true, pms: 'guesty', ours: {} });
  assert.deepStrictEqual(r.applied.sort(), [1, 2]);          // both price changes landed
  assert.deepStrictEqual(r.failed, [3]);                     // min-stay-only date failed cleanly
  assert.strictEqual(posts.length, 2);                        // original batch, then price-only retry
  assert(posts[1].every((o) => o.min_stay === undefined));
  assert.deepStrictEqual(posts[1].map((o) => o.date), ['2026-11-18', '2026-11-19']);
  const failPatch = patches.find((p) => p.b.status === 'failed');
  assert(/Min-stay customization is off/.test(failPatch.b.error));
  assert(patches.some((p) => p.f === 'id=in.(1)' && p.b.proposed_min_stay === null));
  assert(upserts[0].rows.every((x) => x.min_stay === null));  // records reflect what PriceLabs actually has
  assert(A.isMinStayLocked(new Error('PriceLabs POST ... 400: {"error":"... Enable min stay customization first."}')));
  assert(!A.isMinStayLocked(new Error('PriceLabs POST 500: boom')));

  // Any other error still fails the whole batch (no silent retry).
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  const r2 = await A.applyProposals('L1', [{ id: 7, kind: 'set', stay_date: '2026-11-21', current_price: 200, proposed_price: 180 }], { who: 'agent', auto: true, pms: 'guesty', ours: {} });
  assert.deepStrictEqual(r2.failed, [7]);
  console.log('apply tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
