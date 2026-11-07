// netlify/lib/concierge-quick.js
// Instant answers for the simple, common guest questions — straight from this home's guide, with
// NO Claude API call. Claude is only used when a message needs actual thinking.
//
// Rules (conservative on purpose — a wrong canned answer is worse than an API call):
//   • short messages only (≤ 160 characters), that clearly ask one or a few of the questions below
//   • anything that sounds like a problem ("not working", "no hot water", "locked out", "leak"…),
//     a request ("can we check in early", "can I bring my dog"), or an emergency → goes to Claude
//   • only answered when the home guide actually has the info; otherwise → Claude
//   • same release rule as everywhere else: door codes / Wi-Fi only from the start of check-in day
// Input: the guest's message + the knowledge object from concierge-knowledge.forSession().

const MAX_LEN = 160;

// Needs a person or real thinking → never canned.
const PROBLEM = /\b(not|isn'?t|aren'?t|won'?t|doesn'?t|don'?t|didn'?t|can'?t|cannot|couldn'?t|no longer|stopped|broken|broke|leak\w*|flood\w*|drip\w*|smell\w*|smoke|fire|gas|alarm|beep\w*|emergenc\w*|help|issue|problem|trouble|error|wrong|stuck|locked out|lockout|dead|outage|out of|ran out|run out|cold|no hot water|no power|no heat|no ac|bug|bugs|roach\w*|mice|mouse|pest\w*|dirty|stain\w*|damage\w*|noise|noisy|neighbor\w*|refund|charge\w*|cancel\w*|early|late|extend|extra night|another night|pets?|dogs?|cats?|visitors?|extra (guests?|people)|party|parties|why|how come|reset|fix|repair)\b/i;
// Questions about availability / permission are requests, not lookups.
const REQUEST = /\b(can (we|i)|could (we|i)|may (we|i)|is it (ok|okay|possible)|are we allowed|allowed to|would it be)\b/i;

const has = (re) => (t) => re.test(t);
const INTENTS = [
  { key: 'wifi', test: has(/\b(wi-?fi|wifi|internet|network|wireless|password|pass ?word)\b/i) },
  { key: 'door', test: has(/\b(door ?code|lock ?code|key ?code|entry code|access code|lockbox|key ?pad|the code|get in|let (us|me) in|key|keys)\b/i) },
  { key: 'checkin', test: (t) => /\bcheck[\s-]*in\b/i.test(t) && /\b(time|when|what time|how early|start)\b/i.test(t) },
  { key: 'checkin_how', test: (t) => /\b(how (do|can|should) (we|i) (check[\s-]*in|get in)|check[\s-]*in (instructions|process|steps|info))\b/i.test(t) },
  { key: 'checkout', test: (t) => /\bcheck[\s-]*out\b/i.test(t) && /\b(time|when|what time|by)\b/i.test(t) },
  { key: 'checkout_how', test: (t) => /\b(check[\s-]*out|leaving|depart\w*)\b/i.test(t) && /\b(instructions|steps|what (do|should) (we|i) do|before (we|i) leave|process|procedure|checklist|anything (we|i) need)\b/i.test(t) },
  { key: 'address', test: has(/\b(address|where is the (house|home|cabin|property)|location of the (house|home|cabin|property))\b/i) },
  { key: 'parking', test: has(/\b(park|parking|where (do|can|should) (we|i) park|garage|driveway)\b/i) },
  { key: 'trash', test: has(/\b(trash|garbage|recycl\w*|bins?|rubbish)\b/i) },
  // Things to Do picks (curated list) — only plain "where's good coffee / where should we eat" lookups
  { key: 'place', cat: 'Coffee', test: (t) => /\b(coffee|espresso|latte|cafe|café)\b/i.test(t) && /\b(where|good|best|recommend\w*|nearby|close|near|spot|shop|place|get)\b/i.test(t) && !/\b(maker|keurig|pods?|k-?cups?|filters?|machine)\b/i.test(t) },
  { key: 'place', cat: 'Eat', test: (t) => /\b(restaurants?|eat|dinner|lunch|breakfast|brunch|food)\b/i.test(t) && /\b(where|good|best|recommend\w*|nearby|close|near|spot|places?|grab)\b/i.test(t) },
  { key: 'place', cat: 'Drinks', test: (t) => /\b(brewery|breweries|beer|bars?|drinks?|cocktails?)\b/i.test(t) && /\b(where|good|best|recommend\w*|nearby|close|near|spot|places?|grab)\b/i.test(t) },
  // Things the team documents in the walkthrough — answered only as "where is / how do I use"
  { key: 'item', titles: [/breaker/i], test: has(/\b(breakers?|breaker box|electrical panel|fuse box)\b/i) },
  { key: 'item', titles: [/water heater/i], test: has(/\b(water heater|hot water heater)\b/i) },
  { key: 'item', titles: [/shut-?off/i], test: has(/\b(water shut-?off|shut off the water|main water)\b/i) },
  { key: 'item', titles: [/thermostat/i], test: (t) => /\b(thermostat|temperature|heat|heater|heating|a\/?c|air conditioning|ac)\b/i.test(t) && !/water heater/i.test(t) },
  { key: 'item', titles: [/fireplace/i], test: has(/\bfire ?place\b/i) },
  { key: 'item', titles: [/hot tub|pool/i], test: has(/\b(hot ?tub|jacuzzi|spa|pool)\b/i) },
  { key: 'item', titles: [/router/i], test: has(/\b(router|modem)\b/i) },
  { key: 'item', titles: [/tv|stream/i], test: has(/\b(tv|television|remote|netflix|streaming|roku|hulu|apple tv|youtube tv)\b/i) },
  { key: 'item', titles: [/coffee/i], test: has(/\b(coffee|keurig|k-?cups?|nespresso|pods?)\b/i) },
  { key: 'item', titles: [/dishwasher/i], test: has(/\bdish ?washer\b/i) },
  { key: 'item', titles: [/\bwasher\b|\bdryer\b|laundry/i], test: (t) => /\b(washer|dryer|laundry|washing machine|detergent)\b/i.test(t) && !/hair ?dryer/i.test(t) },
  { key: 'item', titles: [/linen|towel/i], test: has(/\b(towels?|linens?|sheets|blankets?|pillows?)\b/i) },
  { key: 'item', titles: [/supplies|paper/i], test: has(/\b(toilet paper|tp|paper towels?|trash bags?|cleaning supplies)\b/i) },
];

// this home's own items win over company-wide ones
function find(k, pred) { const g = (k.guide || []).filter(pred); return g.find((x) => x.scope !== 'company') || g[0] || null; }
const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const photoNote = (x) => (x && x.photos && x.photos.length && !x.ai_only ? ' (There’s a photo in your Home Guide.)' : '');
function fmtDay(iso) {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric' });
}
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).replace(':00', ''); }
const lockedMsg = (k, what) => `Your ${what} will show up in your Home Guide on ${fmtDay(k.sensitive_from || k.stay.check_in)} (check-in day) — just ask me again then and I’ll send it right over.`;

// Each returns a reply string, or null when we don't have the info (→ let Claude handle it).
const ANSWER = {
  wifi(k) {
    if (!k.sensitive_unlocked) return k.has_locked_items ? lockedMsg(k, 'Wi-Fi details') : null;
    if (k.wifi && (k.wifi.name || k.wifi.password)) return [k.wifi.name && `The Wi-Fi network is ${k.wifi.name}`, k.wifi.password && `the password is ${k.wifi.password}`].filter(Boolean).join(' and ') + '.';
    const x = find(k, (g) => /wi-?fi/i.test(g.section + ' ' + g.title) && !/router/i.test(g.title));
    return x ? `Here’s the Wi-Fi info: ${clip(x.body, 400)}` : null;
  },
  door(k) {
    if (!k.sensitive_unlocked) return k.has_locked_items ? lockedMsg(k, 'door code') : null;
    const code = k.arrival && k.arrival.door_code;
    const x = !code && find(k, (g) => /door code|lock ?code|entry|keypad|lockbox/i.test(g.title));
    if (!code && !x) return null;
    return code ? `Your door code is ${code}.` + (k.arrival.instructions ? ' Your check-in instructions are at the top of your guide too.' : '') : `${x.title}: ${clip(x.body, 400)}`;
  },
  checkin(k) {
    const p = k.property || {};
    if (!k.stay.check_in && !p.check_in_time) return null;
    return `Check-in is ${k.stay.check_in ? fmtDay(k.stay.check_in) + ' at ' + fmtTime(k.stay.check_in) : 'at ' + p.check_in_time}.`;
  },
  checkin_how(k) {
    if (!k.sensitive_unlocked) return k.has_arrival_info ? lockedMsg(k, 'check-in instructions') : null;
    const ins = k.arrival && k.arrival.instructions;
    return ins ? `Here’s how to check in: ${clip(ins, 600)}` : null;
  },
  checkout(k) {
    const p = k.property || {};
    if (!k.stay.check_out_date) return null;
    return `Checkout is ${fmtDay(k.stay.check_out_date)}${p.check_out_time ? ' by ' + p.check_out_time : ''}.`;
  },
  checkout_how(k) {
    const x = find(k, (g) => g.section === 'Checkout');
    const p = k.property || {};
    return x ? `Before you head out${p.check_out_time ? ' (by ' + p.check_out_time + ')' : ''}: ${clip(x.body, 600)}` : null;
  },
  address(k) { const a = (k.property || {}).address; return a ? `The address is ${a}.` : null; },
  parking(k) { const x = find(k, (g) => g.section === 'Parking' || /parking/i.test(g.title)); return x ? `Parking: ${clip(x.body, 500)}${photoNote(x)}` : null; },
  trash(k) {
    const xs = (k.guide || []).filter((g) => g.section === 'Trash & recycling' || /trash|recycl/i.test(g.title));
    return xs.length ? xs.map((x) => clip(x.body, 400) + photoNote(x)).join(' ') : null;
  },
  place(k, intent) {
    const xs = (k.places || []).filter((p) => p.category === intent.cat);
    if (!xs.length) return null;
    const top = xs.slice(0, 3).map((p) => `${p.name}${p.miles != null ? ' (~' + Math.max(1, Math.round(p.miles)) + ' mi)' : ''} — ${p.blurb}`);
    const label = { Coffee: 'coffee spots', Eat: 'places to eat', Drinks: 'spots for a drink' }[intent.cat];
    return `A few ${label} we love:\n• ${top.join('\n• ')}\nThere’s more in the Things to Do tab of your Home Guide.`;
  },
  item(k, intent) {
    const x = find(k, (g) => !g.sensitive && intent.titles.some((re) => re.test(g.title)));
    return x ? `${x.title}: ${clip(x.body, 500)}${photoNote(x)}` : null;
  },
};

// ── Generic lookup: "where are the plates?", "do you have a toaster?", "what are the quiet hours?" ──
// Matches the question against THIS home's own guide items (titles count most), so every item the team
// writes in PropDesk automatically becomes an instant answer — no per-question setup.
const STOP = new Set('a an the is are was be do does did you we i me my our us your there here any some of in on at to for and or with it its this that these those where what which how can could would should have has had get find located location kept keep need want please thanks thank hi hey hello house home unit cabin place stay room one extra use used using put go more other whats wheres theres got see'.split(' '));
// Same-thing words (first word is the shared key). Exact words still score higher than synonyms.
const SYN = [
  ['silverware', 'fork', 'forks', 'spoon', 'spoons', 'knife', 'knives', 'utensil', 'utensils', 'cutlery', 'flatware'],
  ['plate', 'plates', 'bowl', 'bowls'],
  ['glass', 'glasses', 'cup', 'cups', 'mug', 'mugs', 'tumbler', 'tumblers', 'wineglass'],
  ['pot', 'pots', 'pan', 'pans', 'skillet', 'skillets', 'cookware'],
  ['oven', 'stove', 'burner', 'burners', 'range', 'cooktop', 'stovetop'],
  ['colander', 'colanders', 'strainer', 'strainers'],
  ['spice', 'spices', 'salt', 'pepper', 'oil', 'oils', 'seasoning', 'seasonings'],
  ['kettle', 'teapot'], ['frenchpress'], ['pourover'],
  ['tupperware', 'container', 'containers'],
  ['towel', 'towels', 'washcloth', 'washcloths'], ['blanket', 'blankets', 'throw', 'throws'], ['pillow', 'pillows'],
  ['quiethours'], ['occupancy'], ['smoking', 'smoke', 'vape', 'vaping'], ['firework', 'fireworks'],
  ['iron', 'ironing'], ['hairdryer'], ['vacuum', 'broom', 'mop'], ['grill', 'bbq', 'charcoal', 'propane'],
  ['soap', 'dishsoap', 'detergent', 'sponge', 'sponges'], ['remote', 'remotes'], ['shower', 'bathtub'],
  ['papertowel'], ['toiletpaper', 'tp'],
];
const SYN_OF = {}; SYN.forEach((g) => g.forEach((w) => { SYN_OF[w] = g[0]; }));
const PHRASES = [[/hair ?dryers?/g, 'hairdryer'], [/wine ?glass(es)?/g, 'wineglass'], [/french ?press(es)?/g, 'frenchpress'], [/pour ?-?overs?/g, 'pourover'],
  [/dish ?soap/g, 'dishsoap'], [/paper ?towels?/g, 'papertowel'], [/toilet ?paper/g, 'toiletpaper'], [/quiet ?hours?/g, 'quiethours'], [/(max(imum)? )?occupancy|how many (guests|people)/g, 'occupancy']];
const stem = (w) => (w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('s') && !w.endsWith('ss') && w.length > 3 ? w.slice(0, -1) : w);
function toks(text) {
  let t = String(text || '').toLowerCase().replace(/[’']/g, '');
  PHRASES.forEach(([re, r]) => { t = t.replace(re, ' ' + r + ' '); });
  const out = [];
  t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach((w) => { if (w && w.length >= 3 && !STOP.has(w)) out.push({ raw: stem(w), canon: SYN_OF[w] || stem(w) }); });
  return out;
}
function index(text) { const ts = toks(text); return { raw: new Set(ts.map((x) => x.raw)), canon: new Set(ts.map((x) => x.canon)) }; }
const LOOKUP_Q = /^(where|do (you|we|they) have|does (it|the \w+) have|is there|are there|any |have you got|what kind|what are the|what is the|what's the|whats the|how (do|does) (i|we|you) (use|turn on|work|run|start))\b|\bwhere\b/i;
function lookup(t, k) {
  if (!LOOKUP_Q.test(t)) return null;
  const want = toks(t); if (!want.length) return null;
  const items = (k.guide || []).filter((g) => g.source === 'team' && g.body && g.section !== 'About the home'); // the overview repeats everything — match the specific items
  const scored = items.map((g) => {
    const ti = index(g.title), bi = index(g.body); let sc = 0, titleHit = false;
    want.forEach((w) => {
      if (ti.raw.has(w.raw)) { sc += 4; titleHit = true; } else if (ti.canon.has(w.canon)) { sc += 3; titleHit = true; }
      else if (bi.raw.has(w.raw)) sc += 2; else if (bi.canon.has(w.canon)) sc += 1;
    });
    return { g, sc, titleHit, home: g.scope !== 'company' };
  }).filter((x) => x.sc >= 2).sort((a, b) => b.sc - a.sc || (b.home - a.home));
  if (!scored.length) return null;
  const best = scored[0].sc, tied = scored.filter((x) => x.sc === best);
  let top;
  if (tied.length === 1) top = tied;
  else if (tied.length === 2 && tied.every((x) => x.titleHit)) top = tied; // e.g. "glasses and plates?"
  else return null; // too ambiguous → let Claude sort it out
  const yes = /^(do (you|we|they) have|does|is there|are there|any |have you got)/i.test(t) ? 'Yes! ' : '';
  return { reply: yes + top.map((x) => `${x.g.title}: ${clip(x.g.body, 700)}${photoNote(x.g)}`).join('\n\n'), intents: ['lookup:' + top.map((x) => x.g.title).join('|')] };
}

// → { reply, intents } or null (null = send to Claude)
function quickAnswer(message, k) {
  const t = String(message || '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_LEN || !k) return null;
  if (PROBLEM.test(t)) return null;
  if (REQUEST.test(t) && !/^(when|what time|where)\b/i.test(t)) return null; // "when can we check in?" / "where can we get coffee?" are still lookups
  let hits = INTENTS.filter((i) => i.test(t));
  // the more specific check-in / checkout intents win over the time questions
  if (hits.some((h) => h.key === 'checkin_how')) hits = hits.filter((h) => h.key !== 'checkin');
  if (hits.some((h) => h.key === 'checkout_how')) hits = hits.filter((h) => h.key !== 'checkout');
  if (hits.some((h) => h.key === 'wifi')) hits = hits.filter((h) => !(h.key === 'item' && /router/.test(String(h.titles))) || /router|modem/i.test(t));
  // "where's good coffee" is about coffee shops, not the coffee maker
  if (hits.some((h) => h.key === 'place' && h.cat === 'Coffee')) hits = hits.filter((h) => !(h.key === 'item' && /coffee/.test(String(h.titles))));
  // If the message has lots of words the intents didn't explain, it's probably not a simple lookup.
  if (t.split(' ').length > 18) return null;
  if (!hits.length) return lookup(t, k); // not one of the common questions → try this home's own guide items
  if (hits.length > 3) return null;
  const parts = [];
  for (const h of hits) {
    const a = ANSWER[h.key](k, h);
    if (!a) return null; // missing info for any part → let Claude handle the whole message
    if (!parts.includes(a)) parts.push(a);
  }
  return { reply: parts.join('\n\n'), intents: hits.map((h) => h.key === 'item' ? 'item:' + String(h.titles[0]).replace(/[/\\i]/g, '') : h.key === 'place' ? 'place:' + h.cat : h.key) };
}

module.exports = { quickAnswer, PROBLEM, REQUEST };
