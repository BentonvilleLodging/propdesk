// netlify/lib/estimate-pricing.js
// Pricing rules for PropDesk estimates. js/estimator.js mirrors these exactly (keep in sync).
//
//   Client line price  = what the client sees per unit (cost is internal, never shown/emailed)
//   Subtotal           = Σ qty × unit_price
//   Overhead           = 10% of subtotal (shown to client)
//   Sales tax          = 7.2% of (subtotal + overhead) (shown to client)
//   Margin (internal)  = (subtotal − direct cost) ÷ (subtotal + overhead)
//                        i.e. overhead is treated as a real cost, so it never counts as profit.
//   Floor              = margin ≥ 30% on every estimate. With 10% overhead that means
//                        subtotal ≥ cost ÷ (1 − 0.30 × 1.10) = cost ÷ 0.67.

const OVERHEAD = 0.10;
const TAX = 0.072;
const MIN_MARGIN = 0.30;
const FLOOR_DIVISOR = 1 - MIN_MARGIN * (1 + OVERHEAD); // 0.67

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

// Default client unit price for a unit cost: the 30% floor, rounded UP (whole dollars at $20+).
function priceForCost(unitCost) {
  const c = n(unitCost);
  if (c <= 0) return 0;
  const p = c / FLOOR_DIVISOR;
  return p >= 20 ? Math.ceil(p) : Math.ceil(p * 100) / 100;
}

function totals(lines) {
  let subtotal = 0, cost = 0;
  (lines || []).forEach((l) => {
    const q = n(l.qty);
    subtotal += r2(q * n(l.unit_price));
    cost += q * n(l.unit_cost);
  });
  subtotal = r2(subtotal);
  cost = r2(cost);
  const overhead = r2(subtotal * OVERHEAD);
  const tax = r2((subtotal + overhead) * TAX);
  const total = r2(subtotal + overhead + tax);
  const revenue = subtotal + overhead;
  const margin = revenue > 0 ? (subtotal - cost) / revenue : 0;
  return { subtotal, overhead, tax, total, cost, margin: Math.round(margin * 10000) / 10000, meets_floor: revenue > 0 && margin >= MIN_MARGIN - 0.00005 };
}

module.exports = { OVERHEAD, TAX, MIN_MARGIN, FLOOR_DIVISOR, priceForCost, totals, r2, n };
