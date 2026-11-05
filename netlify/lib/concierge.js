// netlify/lib/concierge.js
// Shared security logic for the public guest Concierge (concierge.bentonvillelodgingco.com).
//
// Threat model: anyone on the internet can call these endpoints. Nothing about a property beyond
// its public listing title may be returned unless the caller proves an ACTIVE reservation:
//   • confirmation code alone, or booking email + guest last name, matched live against Guesty
//   • reservation status 'confirmed', for the selected listing, and now is between
//     (check-in time − 48h) and the end of checkout day (America/Chicago)
// A match issues a random 256-bit session token; only its SHA-256 hash is stored. Every session
// use re-checks the reservation with Guesty at most every 20 minutes (cancellations / changed
// dates revoke it). Failed attempts are rate-limited per IP, per listing and globally.

const crypto = require('crypto');
const I = require('./intel');

const TZ = 'America/Chicago';
const UNLOCK_BEFORE_MS = 48 * 3600 * 1000;
const REVERIFY_MS = 20 * 60 * 1000;
const GRACE_MS = 6 * 3600 * 1000; // if Guesty is down, a recently verified session keeps working this long

const DEFAULT_ORIGINS = ['https://concierge.bentonvillelodgingco.com'];
function allowedOrigins() {
  return (process.env.CONCIERGE_ORIGINS ? process.env.CONCIERGE_ORIGINS.split(',') : DEFAULT_ORIGINS).map((s) => s.trim()).filter(Boolean);
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, body, extra) => ({ statusCode: status, headers: Object.assign({}, HEADERS, extra || {}), body: JSON.stringify(body) });

function header(event, name) {
  const h = (event && event.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? String(h[k]) : '';
}

// Browsers always send Origin on POST. Requiring it blocks other websites from driving these
// endpoints from a visitor's browser. (Scripts can forge it — rate limits are the real control.)
function originOk(event, requireOrigin) {
  const o = header(event, 'origin');
  if (!o) return !requireOrigin;
  return allowedOrigins().includes(o);
}

function pepper() { return process.env.CONCIERGE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'concierge'; }
function clientIp(event) {
  return header(event, 'x-nf-client-connection-ip') || (header(event, 'x-forwarded-for').split(',')[0] || '').trim() || 'unknown';
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ipHash = (event) => sha256(pepper() + '|ip|' + clientIp(event));
const tokenHash = (t) => sha256(pepper() + '|tok|' + t);
function newToken() { return crypto.randomBytes(32).toString('base64url'); }

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length > 0;
}

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const normEmail = (s) => String(s || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// ── time helpers (America/Chicago) ──────────────────────────────────────
function ctDateStr(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); }
function tzOffsetMinutes(date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(date).find((x) => x.type === 'timeZoneName');
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(p ? p.value : '');
  if (!m) return -360;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
}
// Instant for YYYY-MM-DD hh:mm:ss in Chicago local time
function ctInstant(dateStr, hh, mm, ss) {
  const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const off = tzOffsetMinutes(new Date(guess));
  return new Date(guess - off * 60000);
}
const endOfDayCT = (dateStr) => ctInstant(dateStr, 23, 59, 59);
const startOfDayCT = (dateStr) => ctInstant(dateStr, 0, 0, 0);

function stayWindow(r) {
  const checkIn = new Date(r.checkIn);
  const outDate = (r.checkOutDateLocalized || (r.checkOut ? ctDateStr(new Date(r.checkOut)) : '')).slice(0, 10);
  const inDate = (r.checkInDateLocalized || ctDateStr(checkIn)).slice(0, 10);
  return {
    checkIn, inDate, outDate,
    unlockAt: new Date(checkIn.getTime() - UNLOCK_BEFORE_MS),
    lockAt: endOfDayCT(outDate),
    sensitiveAt: startOfDayCT(inDate), // door codes / Wi-Fi: from the start of check-in day
  };
}
function isActive(r, now) {
  if (!r || r.status !== 'confirmed' || !r.checkIn || !(r.checkOut || r.checkOutDateLocalized)) return false;
  const w = stayWindow(r);
  if (isNaN(w.checkIn.getTime()) || !w.outDate) return false;
  return now >= w.unlockAt && now <= w.lockAt;
}

// ── Guesty ──────────────────────────────────────────────────────────────
const RES_FIELDS = '_id listingId status confirmationCode checkIn checkOut checkInDateLocalized checkOutDateLocalized guest source';

async function candidateReservations(listingId, now) {
  const filters = JSON.stringify([
    { field: 'listingId', operator: '$eq', value: listingId },
    { field: 'status', operator: '$in', value: ['confirmed'] },
    { field: 'checkIn', operator: '$lte', value: new Date(now.getTime() + UNLOCK_BEFORE_MS + 3600000).toISOString() },
    { field: 'checkOut', operator: '$gte', value: new Date(now.getTime() - 36 * 3600000).toISOString() },
  ]);
  const r = await I.guestyGet(`/v1/reservations?limit=50&fields=${encodeURIComponent(RES_FIELDS)}&filters=${encodeURIComponent(filters)}`);
  const list = r.results || r.data || (Array.isArray(r) ? r : []);
  // Never trust the filter alone: re-check listing + status + window in code.
  return list.filter((x) => x && String(x.listingId) === String(listingId) && isActive(x, now));
}

async function reservationById(id) {
  const r = await I.guestyGet(`/v1/reservations/${encodeURIComponent(id)}?fields=${encodeURIComponent(RES_FIELDS)}`);
  return r && (r._id ? r : (r.data || r.result || null));
}

function guestEmails(r) {
  const g = r.guest || {};
  return [g.email].concat(Array.isArray(g.emails) ? g.emails : []).filter(Boolean).map(normEmail);
}
function guestLastNames(r) {
  const g = r.guest || {};
  const out = [];
  if (g.lastName) out.push(normName(g.lastName));
  if (g.fullName) { const parts = String(g.fullName).trim().split(/\s+/); if (parts.length > 1) out.push(normName(parts[parts.length - 1])); }
  return out.filter(Boolean);
}
function firstName(r) {
  const g = r.guest || {};
  return String(g.firstName || (g.fullName ? String(g.fullName).trim().split(/\s+/)[0] : '') || '').slice(0, 40);
}

// Match one reservation. Code: exact normalized match. Email: email AND last name must match.
function matches(r, input) {
  if (input.kind === 'code') {
    const c = normCode(r.confirmationCode);
    return c.length >= 5 && safeEqual(c, input.code);
  }
  const emailOk = guestEmails(r).some((e) => safeEqual(e, input.email));
  const nameOk = guestLastNames(r).some((n) => safeEqual(n, input.lastName));
  return emailOk && nameOk;
}

// Parse what the guest typed into the single field (+ last name when it's an email)
function parseInput(identifier, lastName) {
  const raw = String(identifier || '').trim();
  if (!raw || raw.length > 160) return null;
  if (raw.includes('@')) {
    const email = normEmail(raw), ln = normName(lastName);
    if (!EMAIL_RE.test(email) || ln.length < 2) return null;
    return { kind: 'email', email, lastName: ln };
  }
  const code = normCode(raw);
  if (code.length < 5 || code.length > 24) return null;
  return { kind: 'code', code };
}

// ── listings shown in the dropdown ──────────────────────────────────────
async function conciergeListings() {
  const rows = await I.sbSelect('listing_registry', 'select=listing_id,title,nickname,concierge_name&is_listed=eq.true&tracked=eq.true&concierge_enabled=eq.true');
  return rows.map((r) => ({ id: r.listing_id, name: String(r.concierge_name || r.title || r.nickname || '').trim() }))
    .filter((r) => r.id && r.name).sort((a, b) => a.name.localeCompare(b.name));
}

// ── sessions ────────────────────────────────────────────────────────────
function bearer(event) { return String(header(event, 'authorization')).replace(/^Bearer\s+/i, '').trim(); }

// Returns { session, reservation? } or { error, status }
async function loadSession(event, now) {
  now = now || new Date();
  const tok = bearer(event);
  if (!tok || tok.length < 40 || tok.length > 60 || !/^[A-Za-z0-9_-]+$/.test(tok)) return { status: 401, error: 'expired' };
  const [s] = await I.sbSelect('concierge_sessions', `token_hash=eq.${tokenHash(tok)}&select=*`);
  if (!s || s.revoked) return { status: 401, error: 'expired' };
  if (new Date(s.expires_at) <= now) return { status: 401, error: 'expired' };

  if (now - new Date(s.last_verified_at) > REVERIFY_MS) {
    let r = null;
    try { r = await reservationById(s.reservation_id); }
    catch (e) {
      if (now - new Date(s.last_verified_at) <= GRACE_MS) return { session: s, degraded: true };
      return { status: 503, error: 'unavailable' };
    }
    if (!r || String(r.listingId) !== String(s.listing_id) || !isActive(r, now)) {
      await I.sbPatch('concierge_sessions', `id=eq.${s.id}`, { revoked: true, revoked_reason: !r ? 'not found' : r.status !== 'confirmed' ? 'status ' + r.status : 'outside stay window' }).catch(() => {});
      return { status: 401, error: 'expired' };
    }
    const w = stayWindow(r);
    const patch = { last_verified_at: now.toISOString(), expires_at: w.lockAt.toISOString(), check_in: w.checkIn.toISOString(), check_out_date: w.outDate };
    await I.sbPatch('concierge_sessions', `id=eq.${s.id}`, patch).catch(() => {});
    Object.assign(s, patch);
    return { session: s, reservation: r };
  }
  return { session: s };
}

function publicSession(s, listingName, now) {
  now = now || new Date();
  const sensitiveAt = s.check_in ? startOfDayCT(ctDateStr(new Date(s.check_in))) : null;
  return {
    property: { id: s.listing_id, name: listingName || '' },
    guest_first_name: s.guest_first_name || '',
    check_in: s.check_in, check_out_date: s.check_out_date, expires_at: s.expires_at,
    sensitive_unlocked: !!(sensitiveAt && now >= sensitiveAt),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  reply, header, originOk, ipHash, tokenHash, newToken, safeEqual, normCode, normName, normEmail, EMAIL_RE,
  parseInput, matches, candidateReservations, reservationById, stayWindow, isActive, firstName,
  conciergeListings, loadSession, publicSession, ctDateStr, endOfDayCT, startOfDayCT, sleep,
};
