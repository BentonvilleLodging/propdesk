// netlify/lib/rankdiag.js
// Airbnb search-rank diagnosis: for every date/search PriceLabs tracks, explain WHY the
// listing is (or isn't) on page 1, using our own calendar (price, min stay, booked nights)
// and the market's price percentiles for that exact date.
//
// PriceLabs rank conventions (observed): rank null + page null = date booked/blocked;
// rank 999 = listing did not appear in that search at all.

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0));
const avg = (a) => { const x = a.filter((v) => v != null && Number.isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
const money = (v) => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Per-date market price percentiles from PriceLabs neighborhood_data
function datePercentiles(nd, bedrooms) {
  const d = (nd && nd.data) || nd || {};
  const block = d['Future Percentile Prices'];
  const out = {};
  if (!block || !block.Category) return out;
  const cats = block.Category;
  const key = bedrooms != null && cats[String(bedrooms)] ? String(bedrooms) : (cats.All ? 'All' : Object.keys(cats)[0]);
  const cat = cats[key];
  if (!cat || !Array.isArray(cat.X_values) || !Array.isArray(cat.Y_values)) return out;
  const labels = block.Labels || cat.Labels || ['25th', '50th', '75th', 'Median Booked', '90th'];
  const idx = {};
  labels.forEach((l, i) => {
    const k = /booked/i.test(l) ? 'booked' : /25/.test(l) ? 'p25' : /50/.test(l) ? 'p50' : /75/.test(l) ? 'p75' : /90/.test(l) ? 'p90' : null;
    if (k && idx[k] == null) idx[k] = i;
  });
  cat.X_values.forEach((date, j) => {
    const g = (k) => (idx[k] != null && Array.isArray(cat.Y_values[idx[k]]) ? num(cat.Y_values[idx[k]][j]) : null);
    out[date] = { p25: g('p25'), p50: g('p50'), p75: g('p75'), booked: g('booked') };
  });
  return out;
}

function calendarMap(entry) {
  const m = {};
  ((entry && entry.data) || []).forEach((d) => {
    const st = String(d.booking_status || '');
    const status = /booked/i.test(st) ? 'booked' : (/block|unavail/i.test(st) || /unavail/i.test(d.demand_desc || '') || d.unbookable === 1 || d.unbookable === true) ? 'blocked' : 'open';
    m[d.date] = { price: num(d.price) != null && num(d.price) > 0 ? num(d.price) : null, min_stay: num(d.min_stay), status, demand: d.demand_desc || null };
  });
  return m;
}

function addDays(iso, n) { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

/**
 * diagnose({ ranking, calendar, neighborhood, bedrooms, optimizer, today })
 * ranking: raw PriceLabs /listing_optimizer/ranking response
 * calendar: raw PriceLabs listing_prices entry for this listing ({data:[...]})
 * neighborhood: raw PriceLabs neighborhood_data response
 * Returns { rows: [...per date/segment], summary: {...} }
 */
function diagnose({ ranking, calendar, neighborhood, bedrooms, optimizer, today }) {
  const d = (ranking && ranking.data) || ranking || {};
  const cur = d.current_rankings || {};
  const cal = calendarMap(calendar);
  const pct = datePercentiles(neighborhood, bedrooms);
  const t0 = today || new Date().toISOString().slice(0, 10);
  const weakGrades = optimizer && optimizer.categories
    ? Object.keys(optimizer.categories).filter((k) => /^[CDF]/i.test(String(optimizer.categories[k].score || ''))).map((k) => k.replace(/_score$/, '').replace(/_/g, ' ') + ' ' + optimizer.categories[k].score)
    : [];

  const rows = [];
  (cur.segments || []).forEach((seg) => {
    const gc = num(seg.guest_count) || 0, los = String(seg.los == null ? '' : seg.los);
    Object.keys(seg.dates || {}).sort().forEach((date) => {
      const x = seg.dates[date] || {};
      const c = cal[date] || {};
      const p = pct[date] || {};
      const rank = num(x.rank), page = num(x.page);
      const price = num(x.price) || c.price;
      const row = { stay_date: date, guest_count: gc, los, rank: rank === 999 ? null : rank, page, rank_price: num(x.price), our_price: c.price, min_stay: c.min_stay, status: c.status || null, demand: c.demand,
        mkt_p25: p.p25, mkt_p50: p.p50, mkt_p75: p.p75, mkt_median_booked: p.booked, verdict: null, reasons: [] };
      if (rank == null && page == null) { row.verdict = c.status === 'open' ? 'no_data' : 'booked'; rows.push(row); return; }
      row.verdict = rank === 999 ? 'not_shown' : page === 1 ? 'page1' : 'off_page1';
      if (row.verdict === 'page1') { rows.push(row); return; }

      const R = (code, weight, text) => row.reasons.push({ code, weight, text });
      const n = los === 'min_stay' ? (c.min_stay || 1) : (num(los) || 1);
      // 1. Stay length runs into a booked/blocked night
      let blockedAt = null;
      for (let i = 1; i < n; i++) { const nx = cal[addDays(date, i)]; if (nx && nx.status !== 'open') { blockedAt = i; break; } }
      if (blockedAt) R('stay_blocked', 5, `A ${n}-night stay from this date hits a ${cal[addDays(date, blockedAt)].status} night ${blockedAt} day${blockedAt > 1 ? 's' : ''} later, so you can't be shown for this search.`);
      // 2. Minimum stay longer than the search
      if (los !== 'min_stay' && c.min_stay && c.min_stay > n) R('min_stay', 5, `Minimum stay is ${c.min_stay} nights but this search is for ${n} night${n > 1 ? 's' : ''} — Airbnb hides you.`);
      // 3. Price vs comparable homes that date
      if (price != null && p.p50 != null) {
        if (p.p75 != null && price > p.p75) R('price_high', 4, `Priced ${money(price)} — above 75% of comparable ${bedrooms || ''}${bedrooms ? '-BR ' : ''}homes for this date (75th pct ${money(p.p75)}, median ${money(p.p50)}).`);
        else if (price > p.p50 * 1.1) R('price_above_median', 3, `Priced ${money(price)} vs market median ${money(p.p50)} (+${Math.round((price / p.p50 - 1) * 100)}%) for this date.`);
        if (p.booked != null && price > p.booked * 1.25 && !row.reasons.some((r) => /^price/.test(r.code))) R('price_vs_booked', 2, `Comparable homes are actually booking at ~${money(p.booked)} for this date; you're at ${money(price)}.`);
      }
      // 4. Low-demand weekday
      const dow = new Date(date + 'T12:00:00Z').getUTCDay();
      if (/low/i.test(c.demand || '') && dow >= 0 && dow <= 4) R('low_demand', 1, `Low-demand ${DOW[dow]} — fewer searches, so Airbnb weights price and conversion even more.`);
      // 5. Far-out date
      const lead = Math.round((new Date(date + 'T12:00:00Z') - new Date(t0 + 'T12:00:00Z')) / 86400000);
      if (lead > 45 && row.verdict === 'off_page1') R('far_out', 1, `${lead} days out — rankings this far ahead are volatile and improve as booking activity builds.`);
      // 6. Nothing structural → quality / conversion
      if (!row.reasons.some((r) => r.weight >= 3)) {
        R('quality', 3, 'Price and availability look competitive for this date, so placement is likely held back by listing quality / conversion signals' + (weakGrades.length ? ` (PriceLabs grades: ${weakGrades.join(', ')})` : ' (reviews, photos, click-through)') + '.');
      }
      if (row.verdict === 'not_shown' && !row.reasons.some((r) => r.code === 'stay_blocked' || r.code === 'min_stay')) {
        row.reasons.unshift({ code: 'not_shown', weight: 4, text: 'Did not appear in this search at all — usually a stay-length/availability rule or a price above the search filter.' });
      }
      row.reasons.sort((a, b) => b.weight - a.weight);
      rows.push(row);
    });
  });

  // ── Summary across all segments, judged per date by the BEST page found
  const byDate = {};
  rows.forEach((r) => { (byDate[r.stay_date] = byDate[r.stay_date] || []).push(r); });
  const dates = Object.keys(byDate).sort();
  let page1 = 0, off = 0, notShown = 0, booked = 0;
  const reasonCount = {}, worst = [], p1Prices = [], offPrices = [];
  dates.forEach((date) => {
    const rs = byDate[date];
    const ranked = rs.filter((r) => r.verdict === 'page1' || r.verdict === 'off_page1');
    if (rs.every((r) => r.verdict === 'booked' || r.verdict === 'no_data')) { booked++; return; }
    const best = ranked.length ? Math.min(...ranked.map((r) => r.page)) : null;
    const price = avg(rs.map((r) => r.rank_price || r.our_price));
    if (best === 1) { page1++; if (price != null) p1Prices.push(price); return; }
    if (best == null) notShown++; else off++;
    if (price != null) offPrices.push(price);
    const seen = new Set();
    rs.forEach((r) => (r.reasons || []).forEach((x) => { if (!seen.has(x.code)) { seen.add(x.code); reasonCount[x.code] = (reasonCount[x.code] || 0) + 1; } }));
    const top = rs.filter((r) => r.verdict !== 'page1').sort((a, b) => ((b.page || 99) - (a.page || 99)))[0];
    worst.push({ date, best_page: best, worst_page: top && top.page, rank: top && top.rank, price: round(price, 0), mkt_p50: top && top.mkt_p50, reasons: top ? top.reasons.map((x) => x.text).slice(0, 3) : [] });
  });
  const checked = page1 + off + notShown;
  const LABEL = { stay_blocked: 'stay length runs into a booked night', min_stay: 'minimum stay longer than the search', price_high: 'priced above 75% of comparable homes', price_above_median: 'priced >10% above the market median', price_vs_booked: 'priced well above what comparables are booking at', low_demand: 'low-demand weekday', far_out: 'far-out date', quality: 'competitive price — quality/conversion signals', not_shown: 'not shown in search' };
  const reasons = Object.keys(reasonCount).sort((a, b) => reasonCount[b] - reasonCount[a]).map((k) => ({ code: k, label: LABEL[k] || k, dates: reasonCount[k] }));
  const ap1 = avg(p1Prices), aoff = avg(offPrices);
  let headline = null;
  if (checked) {
    headline = `On page 1 for ${page1} of ${checked} open dates (${Math.round((page1 / checked) * 100)}%).`;
    if (off + notShown) headline += ` Off page 1 on ${off + notShown}` + (reasons[0] ? ` — most often: ${reasons[0].label} (${reasons[0].dates} date${reasons[0].dates === 1 ? "" : "s"}).` : '.');
    if (ap1 && aoff && aoff > ap1 * 1.05) headline += ` Your page-1 dates average ${money(ap1)} vs ${money(aoff)} on off-page dates (+${Math.round((aoff / ap1 - 1) * 100)}%).`;
  }
  const summary = {
    updated_at: cur.updated_at || null, dates_checked: checked, page1_dates: page1, off_page1_dates: off, not_shown_dates: notShown, booked_dates: booked,
    pct_page1: checked ? Math.round((page1 / checked) * 100) : null,
    avg_price_page1: round(ap1, 0), avg_price_off: round(aoff, 0), reasons, headline,
    worst_dates: worst.sort((a, b) => (b.worst_page || 99) - (a.worst_page || 99)).slice(0, 12).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
  return { rows, summary };
}

module.exports = { diagnose, datePercentiles, calendarMap };
