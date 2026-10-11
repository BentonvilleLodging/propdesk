// netlify/lib/intel.js
// Shared helpers for the Listing Intelligence pipeline (collect → analyze → owner reports).
// Server-side only. Requires SUPABASE_SERVICE_KEY (RLS-locked tables), GUESTY_CLIENT_ID/SECRET,
// PRICE_LABS_SECRET, CLAUDE_SECRET.

const { SUPABASE_URL, serverHeaders } = require('./auth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// ── Supabase REST ───────────────────────────────────────────────────────
async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: serverHeaders() });
  if (!res.ok) throw new Error(`select ${table} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function sbUpsert(table, rows, onConflict) {
  if (!rows || !rows.length) return 0;
  // PostgREST bulk writes require every object to have the same keys — fill gaps with null.
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  rows = rows.map((r) => { const o = {}; keys.forEach((k) => { o[k] = r[k] === undefined ? null : r[k]; }); return o; });
  for (let i = 0; i < rows.length; i += 200) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : ''}`, {
      method: 'POST',
      headers: serverHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
    if (!res.ok) throw new Error(`upsert ${table} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return rows.length;
}

async function sbInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: serverHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function sbPatch(table, filter, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: serverHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch ${table} (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

async function cacheSet(key, value, ttlMs) {
  await sbUpsert('app_cache', [{ key, value: typeof value === 'string' ? value : JSON.stringify(value), expires_at: new Date(Date.now() + (ttlMs || 7 * 86400000)).toISOString() }], 'key');
}

async function cacheGet(key) {
  const rows = await sbSelect('app_cache', `key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`);
  return rows[0] || null;
}

// ── Guesty Open API (token cached in app_cache; 5 token requests/day limit) ─
let _gTok = null;
async function guestyToken() {
  const now = Date.now();
  if (_gTok && now < _gTok.exp - 30 * 60000) return _gTok.token;
  const row = await cacheGet('guesty_token').catch(() => null);
  if (row && row.value && row.expires_at && now < new Date(row.expires_at).getTime() - 30 * 60000) {
    _gTok = { token: row.value, exp: new Date(row.expires_at).getTime() };
    return row.value;
  }
  const res = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: process.env.GUESTY_CLIENT_ID, client_secret: process.env.GUESTY_CLIENT_SECRET }),
  });
  const raw = await res.text();
  if (res.status === 429) throw new Error('Guesty token rate limit hit (5/day max).');
  if (!res.ok) throw new Error(`Guesty token failed (${res.status}): ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const exp = now + Math.min((data.expires_in || 86400) - 3600, 82800) * 1000;
  _gTok = { token: data.access_token, exp };
  await sbUpsert('app_cache', [{ key: 'guesty_token', value: data.access_token, expires_at: new Date(exp).toISOString() }], 'key').catch(() => {});
  return data.access_token;
}

// GET with gentle pacing + retry on 429 (Guesty allows ~120 req/min)
async function guestyGet(path, attempt) {
  attempt = attempt || 0;
  const token = await guestyToken();
  const res = await fetch('https://open-api.guesty.com' + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (res.status === 429 && attempt < 4) { await sleep(2000 * (attempt + 1)); return guestyGet(path, attempt + 1); }
  const raw = await res.text();
  if (!res.ok) throw new Error(`Guesty ${res.status} on ${path.slice(0, 90)}: ${raw.slice(0, 250)}`);
  await sleep(350);
  return JSON.parse(raw);
}

// ── PriceLabs Customer API ──────────────────────────────────────────────
async function plFetch(method, path, body, attempt) {
  attempt = attempt || 0;
  const res = await fetch('https://api.pricelabs.co' + path, {
    method,
    headers: { 'X-API-Key': process.env.PRICE_LABS_SECRET, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 3) { await sleep(3000 * (attempt + 1)); return plFetch(method, path, body, attempt + 1); }
  const raw = await res.text();
  if (!res.ok) { const e = new Error(`PriceLabs ${res.status} on ${path.slice(0, 80)}: ${raw.slice(0, 250)}`); e.status = res.status; throw e; }
  await sleep(250);
  try { return JSON.parse(raw); } catch (e) { throw new Error('PriceLabs non-JSON on ' + path.slice(0, 60)); }
}
const plGet = (path) => plFetch('GET', path);
const plPost = (path, body) => plFetch('POST', path, body);

// ── Claude ──────────────────────────────────────────────────────────────
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

function extractJson(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {
    const s = t.indexOf('{'), e2 = t.lastIndexOf('}');
    if (s === -1 || e2 === -1) throw e;
    return JSON.parse(t.slice(s, e2 + 1));
  }
}

// Returns { json, text, usage, stop_reason }. `tools` optional (e.g. web search).
async function claude({ system, user, maxTokens, tools, model }) {
  const apiKey = process.env.CLAUDE_SECRET;
  if (!apiKey) throw new Error('CLAUDE_SECRET env var not set');
  const call = async (noThinkingParam) => {
    const body = {
      model: model || CLAUDE_MODEL,
      // Generous ceiling: newer models may spend output tokens on reasoning before the JSON.
      max_tokens: Math.max(maxTokens || 0, 16000),
      system,
      messages: [{ role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }],
      ...(tools ? { tools } : {}),
      ...(noThinkingParam ? {} : { thinking: { type: 'disabled' } }),
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify(body),
    });
    return { res, raw: await res.text() };
  };
  let { res, raw } = await call(false);
  // If this model rejects the thinking parameter, retry without it.
  if (res.status === 400 && /thinking/i.test(raw)) ({ res, raw } = await call(true));
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${raw.slice(0, 400)}`);
  const data = JSON.parse(raw);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let json = null;
  try { json = extractJson(text); } catch (e) {
    const types = (data.content || []).map((b) => b.type).join(',');
    throw new Error(`Claude output not JSON (stop_reason=${data.stop_reason}, blocks=${types}, out_tokens=${data.usage && data.usage.output_tokens}): ${text.slice(0, 160)}`);
  }
  return { json, text, usage: data.usage, stop_reason: data.stop_reason, content: data.content };
}

// Run async fn over items with limited concurrency
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { __error: e.message }; } }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { sleep, today, sbSelect, sbUpsert, sbInsert, sbPatch, cacheSet, cacheGet, guestyToken, guestyGet, plGet, plPost, claude, CLAUDE_MODEL, pool, extractJson };
