// update.mjs: checks Rightmove for new houses and updates listings.json.
// GitHub runs this twice a day (see the "Update listings" workflow). It needs Node 18+ and nothing else.
// Run it yourself with:  node update.mjs

// ---------- What to search for ----------
const BASE = "locationIdentifier=REGION%5E131&radius=5.0&minBedrooms=3" +
  "&propertyTypes=bungalow%2Cdetached%2Csemi-detached%2Cterraced&keywords=garage" +
  "&dontShow=retirement%2CsharedOwnership&sortType=6";
export const SETTINGS = {
  // Bedworth + 5 miles, split into two price bands so each search stays under Rightmove's 1,000-result limit
  searches: [BASE + "&maxPrice=210000", BASE + "&minPrice=210000&maxPrice=270000"],
  // postcode areas to keep; everything else (Hinckley, south Coventry, etc.) is skipped
  outcodes: ["CV2", "CV6", "CV7", "CV10", "CV11", "CV12"],
  sectors: ["CV1 5", "CV5 8", "CV5 9", "CV13 6"],
  centre: [52.4790, -1.4700],
  maxMiles: 6,
  delayMs: [1200, 2400],     // pause between page loads, to keep the load on Rightmove light
  maxDetailFetches: 150,     // new listings opened per run
  maxMissingChecks: 60,      // vanished listings checked per run (sold / removed?)
  maxSoldChecks: 12,         // sold STC listings re-checked per run (still there?)
  maxRereads: 260,           // older listings re-read per run for the detailed check (bedroom sizes, condition, EPC...)
  log: console.log
};

// ===== CORE (no Node-only code below this line until NODE MAIN) =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 864e5;
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const dmy = t => { const [y, m, d] = isoDay(t).split("-"); return `${d}/${m}/${y}`; };
const milesBetween = (a, b) => { const R = 3958.8, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// ---------- Reading Rightmove pages ----------
export function parseSearchPage(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  const sr = m && JSON.parse(m[1]).props?.pageProps?.searchResults;
  if (!sr || !Array.isArray(sr.properties)) throw new Error("Rightmove's search page has changed format");
  return {
    total: parseInt(String(sr.resultCount).replace(/,/g, ""), 10) || 0,
    pages: Math.max(1, parseInt(sr.pagination?.total, 10) || 1),
    properties: sr.properties
  };
}

// Listing pages hold their data in window.__PAGE_MODEL: {"data": "<JSON array where numbers point at other entries>"}
function readPageModel(html) {
  const i0 = html.search(/window\.(__)?PAGE_MODEL\s*=/);
  if (i0 < 0) return null;
  const s = html.indexOf("{", i0);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = s; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) return null;
  const outer = JSON.parse(html.slice(s, end));
  if (outer.propertyData) return outer; // older plain format
  if (typeof outer.data !== "string") return null;
  const arr = JSON.parse(outer.data);
  const memo = new Map();
  const hyd = i => {
    if (typeof i !== "number") return i;
    if (i < 0) return i === -1 ? undefined : null;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") { memo.set(i, null); return null; } // typed values (dates etc.) aren't needed
      const out = []; memo.set(i, out); v.forEach(x => out.push(hyd(x))); return out;
    }
    if (v && typeof v === "object") { const out = {}; memo.set(i, out); for (const k in v) out[k] = hyd(v[k]); return out; }
    memo.set(i, v); return v;
  };
  return hyd(0);
}

const ENT = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", pound: "£", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", frac12: "½", sup2: "²" };
const plain = s => String(s || "")
  .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1].toLowerCase() === "x" ? 2 : 1), e[1].toLowerCase() === "x" ? 16 : 10)) : (ENT[e.toLowerCase()] ?? m))
  .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

export function parseListingPage(html) {
  const model = readPageModel(html);
  const pd = model && model.propertyData;
  if (!pd) return null;
  const sqft = (pd.sizings || []).find(z => z && z.unit === "sqft");
  return {
    id: pd.id,
    published: pd.status ? pd.status.published !== false && !pd.status.archived : true,
    tags: pd.tags || [],
    lat: pd.location?.latitude, lng: pd.location?.longitude,
    addr: pd.address?.displayAddress || "",
    pc: [pd.address?.outcode, pd.address?.incode].filter(Boolean).join(" "),
    qual: pd.prices?.displayPriceQualifier || "",
    price: parseInt(String(pd.prices?.primaryPrice || "").replace(/[^\d]/g, ""), 10) || 0,
    beds: pd.bedrooms || 0, baths: pd.bathrooms || 0,
    subType: pd.propertySubType || "",
    tenure: pd.tenure?.tenureType || "", leaseYears: pd.tenure?.yearsRemainingOnLease || 0,
    ctax: pd.livingCosts?.councilTaxBand || "",
    sqft: sqft ? Math.round(sqft.minimumSize || sqft.maximumSize || 0) : 0,
    desc: plain(pd.text?.description),
    keyFeatures: (pd.keyFeatures || []).map(plain),
    rooms: (pd.rooms || []).filter(Boolean).map(r => plain([r.name, r.dimension, r.description].filter(Boolean).join(" "))),
    img: pd.images?.[0]?.url || "",
    agent: pd.customer?.branchDisplayName || "",
    auction: !!pd.text?.auctionFeesDisclaimer,
    shared: !!pd.sharedOwnership?.sharedOwnershipFlag,
    feesApply: !!pd.feesApply,
    history: pd.listingHistory?.listingUpdateReason || ""
  };
}

// ---------- Working out the garage, garden and other features from the listing text ----------
const NOT_A_GARAGE = /garage (has been |was |now |since been |been )*(converted|conversion|turned into|made into)|(converted|former(ly)?( a)?|previous|old|integral garage now|part of the) (the )?(former )?garage|garage conversion|(space|potential|room|scope|plans?|permission|planning|option|ample room|plenty of room|plot) (for|to (build|erect|add)) (a )?(single |double )?garage|no garage|without (a )?garage|garages? (is |are )?(also )?(available )?(to rent|for rent|rented|by separate negotiation|separately|available for rent)|(rented|rental|council|nearby) garages?|garage (is )?(currently )?used as (a |an )?(gym|office|study|bedroom|living|playroom|play room|utility|home office|room|bar|cinema)|garage sale/gi;
const UNSURE = /garage\s*\/\s*(store|storage|utility|workshop|gym|office)|(store|storage|utility)\s*\/\s*garage|part[- ]garage|partly converted|storage garage|garage store|half garage|(reduced|restricted|limited)[- ]height garage/i;

export function classifyGarage(text) {
  const cleaned = text.replace(NOT_A_GARAGE, " ");
  const has = /\bgarag(e|es|ing)\b/i.test(cleaned);
  const t = cleaned.toLowerCase();
  const block = /garage (situated |located |set |is )?(in|within) (a |an |the )?(nearby |adjacent |separate |communal |small )?(block|compound|courtyard|row)|block of garages|garage block|en[- ]bloc/.test(t);
  const double = /double (length |width |detached |integral |brick )?garag|garage (for|accommodating|holding|housing) (two|2) (cars|vehicles)|two garages|twin garage/.test(t);
  const integral = /integral (single |double )?garage|integrated garage|garage[^.]{0,40}(internal|integral|interconnecting|connecting) (access|door)|internal (access|door)( leading)? (in)?to (the )?garage|access (in)?to (the )?garage (from|via) (the )?(hall|kitchen|utility|house|lobby)/.test(t);
  const detached = /detached (single |double |brick |brick[- ]built )?garag|garage (to|at|in) the (rear|bottom|end|back|foot)|rear garage|garage to rear|separate (single |double )?garage|garage (located|situated|positioned|set|sits) (to|at) the rear|(brick|brick[- ]built|timber|sectional|concrete|prefab) garage|garage (at|to) (the )?(foot|end|bottom) of the garden|garden[^.]{0,40}leads? to (a |the )?garage/.test(t);
  const attached = /(?<!de)attached (single |double )?garage|adjoining garage|garage (attached|adjoining)|(side|adjacent) garage|garage (to|at) (the )?side|link(ed)? garage/.test(t);
  let type = "Unstated";
  if (block) type = "Block";
  else if (double) type = integral ? "Double-Integral" : detached ? "Double-Detached" : "Double-Unstated";
  else if (integral) type = "Integral";
  else if (detached) type = "Detached";
  else if (attached) type = "Attached";
  if (UNSURE.test(text) && !type.startsWith("Double")) type += "?";
  // a quote for the detail panel: the most informative sentence that mentions the garage
  const sentences = text.split(/(?<=[.!?])\s+|\n+|\*{2,}|•/).map(s => s.trim()).filter(s => s.length > 8);
  const garS = sentences.filter(s => /garag/i.test(s) && !s.replace(NOT_A_GARAGE, " ").match(/^\W*$/));
  const informative = garS.filter(s => /detached|integral|double|rear|side|block|attached|power|light|door/i.test(s)).sort((a, b) => Math.min(b.length, 220) - Math.min(a.length, 220));
  const quote = (informative[0] || garS[0] || "").slice(0, 220);
  // garden quote: skip room descriptions that only mention a window or doors onto the garden
  const gdnS = sentences.filter(s => /garden/i.test(s) && !/bedroom|lounge|living room|kitchen|reception|dining|window|french doors|bi-?fold|patio doors|overlook|views? (over|of|onto)|doors? (to|leading|opening)/i.test(s));
  const gdq = (gdnS.find(s => /rear|lawn|large|south|patio|enclosed|long|generous|mature/i.test(s)) || gdnS[0] || "").slice(0, 220);
  return { has, type, quote, gdq };
}

function featureTags(text, d) {
  const t = text.toLowerCase(), P = [], N = [];
  const on = (cond, arr, tag) => { if (cond) arr.push(tag); };
  on(/no (onward |upward )?chain|chain[- ]free/.test(t), P, "nochain");
  const drive2 = /(driveway|parking)[^.]{0,40}(two|2|three|3|four|several|multiple|numerous) (cars|vehicles)|(two|2|three|3)[- ]car (driveway|parking)|double (width )?driveway|ample (off[- ]road )?parking/.test(t);
  on(drive2, P, "drive2");
  on(!drive2 && /driveway|off[- ](road|street) parking/.test(t), P, "drive");
  on(/utility/.test(t), P, "util");
  on(/(downstairs|ground floor|guest) (wc|w\.c|w\/c|cloakroom|toilet)|cloakroom/.test(t), P, "wc");
  on(/en[- ]?suite/.test(t), P, "ensuite");
  on(/\bextended\b|extension/.test(t), P, "ext");
  on(/(modern|refitted|re-fitted|newly fitted|new|contemporary|recently fitted|stylish) (fitted )?(kitchen|bathroom|shower room)/.test(t), P, "modern");
  on(/well[- ]presented|immaculate|beautifully presented|move[- ]in ready|ready to move (straight )?in|tastefully|excellent condition|pristine|stunning/.test(t), P, "wellpres");
  on(/garage[^.]{0,80}\b(power|electric|electricity|lighting|light)\b/.test(t), P, "garpower");
  on(/(large|generous|long|substantial|sizeable|sizable|extensive|good[- ]sized|enormous|huge|massive|impressive|deep|expansive|spacious|larger than average|wonderful|fantastic) ((well[- ]maintained|landscaped|enclosed|private|mature|lawned|south[- ]facing|rear|westerly|east|west|facing) ){0,3}(rear )?gardens?\b/.test(t), P, "biggdn");
  on(/lawn/.test(t), P, "lawn");
  on(/(large|larger than average|oversized|over[- ]sized|extra[- ](long|large|wide)|long|spacious|substantial|generous|good[- ]sized|tandem) (single |double |detached |brick )?garage|garage\s*\/\s*workshop|workshop/.test(t), P, "largegar");
  on(/conservatory|sun ?room|orangery|garden room/.test(t), P, "cons");
  on(/south[- ]?(west |east |westerly |easterly )?facing/.test(t), P, "south");
  on(/(open|field|countryside|woodland|park|canal|green) views?|not overlooked|back(s|ing)? on ?to (fields|woodland|open|countryside|park|the canal|a brook|allotments|playing fields)/.test(t), P, "views");
  on(/corner plot|corner position/.test(t), P, "corner");
  on(/solar (panels?|pv)|pv panels?/.test(t), P, "solar");
  // negatives
  const poor = /(full|complete|extensive|total|major) (refurbishment|renovation|modernisation|modernization)|(very )?poor (condition|state)|uninhabitable|derelict/.test(t);
  on(poor, N, "poor");
  on(!poor && /(in need of|requires?|requiring|needs?) (some |general |cosmetic |full )?(modernisation|modernization|updating|refurbishment|improvement|renovation|tlc)|scope (to|for) (update|modernise|improve|add value)|(refurbishment|renovation|modernisation) project|potential to (update|modernise)|\btlc\b/.test(t), N, "reno");
  const hasBath = /\bbath\b|\bbath(tub| with| suite)|panel(l)?ed bath|corner bath|roll[- ]top|p[- ]shaped bath|freestanding bath/.test(t);
  on(/shower room/.test(t) && !hasBath && !/bathroom/.test(t), N, "showeronly");
  on(/low[- ]maintenance|artificial (grass|lawn|turf)|astro ?turf|courtyard garden|paved (rear )?garden|gravelled (rear )?garden/.test(t), N, "lowmaint");
  on(/cash buyers? only|non[- ]standard construction|not mortgageable|unmortgageable|cash purchasers? only/.test(t), N, "cash");
  on(/garage[^.]{0,40}(limited (access|use|height)|used (as|for) storage)|restricted access to (the )?garage/.test(t), N, "limited");
  const mmoa = /modern method of auction|\bmmoa\b|reservation fee|iam sold/.test(t);
  on(mmoa, N, "mmoa");
  on(!mmoa && (d.auction || /\bauction\b/.test(t)), N, "auction");
  on(d.feesApply || /buyer'?s? (premium|fee)|buyers? (will )?(be )?(required to )?pay[^.]{0,40}fee/.test(t), N, "buyerfee");
  on(d.shared || /shared ownership/.test(t), N, "shared");
  on(/leasehold/i.test(d.tenure) || /\bleasehold\b/.test(t), N, "lease");
  on(/tandem/.test(t), N, "tandem");
  on(/over[- ](55|60|50)s|age restricted|retirement/.test(t), N, "age");
  return { P, N };
}

// ---------- Detailed facts a buyer's agent would look at ----------
export const FACTS_VERSION = 2;
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
// floor area of a room from "3.61m x 2.84m" or "12' 4\" x 10' 2\"" (returns m², 0 if not found)
function roomArea(s) {
  let m = s.match(/(\d{1,2}(?:\.\d{1,2})?)\s*m?\s*(?:max\.?\s*)?[x×]\s*(\d{1,2}(?:\.\d{1,2})?)\s*m(?![a-z])/i);
  if (m) { const a = +m[1] * +m[2]; if (a >= 3 && a <= 45) return a; }
  m = s.match(/(\d{1,2})\s*(?:'|ft|’)\s*(\d{1,2})?\s*(?:"|''|in|”)?\s*(?:max\.?\s*)?[x×]\s*(\d{1,2})\s*(?:'|ft|’)\s*(\d{1,2})?/i);
  if (m) { const ft = (f, i) => (+f + (+(i || 0)) / 12) * 0.3048; const a = ft(m[1], m[2]) * ft(m[3], m[4]); if (a >= 3 && a <= 45) return a; }
  return 0;
}
function bedroomSizes(text) {
  const found = new Map();
  for (const m of text.matchAll(/\b(?:principal |master |main )?bed ?room\s*(one|two|three|four|five|1|2|3|4|5)\b([^\n]{0,90})/gi)) {
    const n = NUM[m[1].toLowerCase()] || +m[1];
    if (found.has(n)) continue;
    const a = roomArea(m[2].split(/\bbed ?room\b/i)[0]);
    if (a) found.set(n, Math.round(a * 10) / 10);
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}
export function extractFacts(d, text, g, P, N) {
  const t = text.toLowerCase();
  const sizes = bedroomSizes(text);
  const beds = d.beds || 0;
  let allDoubles = false, smallBed = false;
  if (sizes.length && sizes.length >= beds) { allDoubles = Math.min(...sizes) >= 9.5; smallBed = Math.min(...sizes) < 7.5; }
  else {
    const dbl = t.match(/\b(one|two|three|four|five|1|2|3|4|5|all)\s+(?:good[- ]sized |generous |spacious |well[- ]proportioned |large )?double bedrooms|all (?:three |four |five |of the )?bedrooms (?:are )?(?:good[- ]sized )?doubles?/);
    if (dbl) { const n = dbl[1] ? (dbl[1] === "all" ? 99 : NUM[dbl[1]] || +dbl[1]) : 99; allDoubles = n >= beds; }
    smallBed = /box ?room|single bedroom|bedroom (three|3|four|4)[^.\n]{0,40}\b(single|small|compact|box)\b|(small|compact|single) (third|fourth) bedroom|(third|fourth) bedroom (is )?(a )?(small|single|compact)|study\s*\/\s*bedroom|bedroom (three|3)\s*\/\s*study|\bnursery\b/.test(t);
    if (smallBed) allDoubles = false;
  }
  let receptions = 1;
  const rc = t.match(/\b(two|three|four|2|3|4) (?:separate |good[- ]sized |spacious |generous |versatile )?reception (?:rooms|areas|spaces)/);
  if (rc) receptions = NUM[rc[1]] || +rc[1];
  else {
    const dining = /\bdining room\b/.test(t.replace(/(kitchen|lounge|living|sitting)[\s\/&-]*(and )?(\/ ?)?dining room/g, ""));
    const second = /\b(sitting room|family room|snug|second reception|playroom|garden room|drawing room)\b/.test(t) && /\b(lounge|living room)\b/.test(t);
    receptions = 1 + (dining ? 1 : 0) + (second ? 1 : 0);
  }
  const epcM = text.replace(/\(EPC\)/gi, "").match(/\b(?:EPC|E\.P\.C\.?|[Ee]nergy [Pp]erformance [Cc]ertificate|[Ee]nergy [Ee]fficiency|[Ee]nergy [Rr]ating)\b[^.\n]{0,40}?(?:[Rr]ating|[Bb]and|[Gg]rade)?\s*(?:is\s*|of\s*)?[:\-–]?\s*\(?([A-G])\b(?![a-z'’])/);
  const epc = epcM && /^[A-G]$/.test(epcM[1]) ? epcM[1] : "";
  const excellent = /(fully|recently|extensively|completely|newly|tastefully|sympathetically|beautifully) (renovated|refurbished|modernised|modernized|updated|remodelled|upgraded)|renovated (to a high standard|throughout)|refurbished throughout|high[- ]specification|finished to a high standard/.test(t);
  const good = /well[- ]presented|well[- ]maintained|beautifully presented|immaculate|move[- ]in ready|ready to move (straight )?in|tastefully|excellent condition|pristine|turn[- ]key|nothing to do|good decorative order/.test(t);
  const major = N.includes("poor") || /structural (issues|movement|problems)|subsidence|in need of (complete|total|full) /.test(t);
  const needs = N.includes("reno") || /would benefit from (some |general |cosmetic )?(modernisation|updating|refurbishment|improvement|redecoration)|blank canvas|put your own stamp|scope to (improve|update|modernise|personalise)|investment opportunity|ideal for investors|\bdated\b/.test(t);
  const cond = Math.max(-2, Math.min(2, (excellent ? 2 : good ? 1 : 0) + (major ? -3 : needs ? -1 : 0) - (major && !excellent && !good ? 1 : 0)));
  const upgrades = [];
  if (/(new|newly (fitted|installed)|recently (fitted|installed|replaced)|replacement|brand new) (combi(nation)? |gas |worcester |vaillant |baxi |ideal )?boiler|boiler (was )?(installed|fitted|replaced|renewed) (in )?(20[12]\d|recently|last year)|boiler (is )?(only )?(one|two|three|four|five|\d) years? old/.test(t)) upgrades.push("new boiler");
  if (/\bre-?wired\b|rewire (in|completed|carried out)|new (electrics|consumer unit|fuse ?board)/.test(t)) upgrades.push("rewired");
  if (/new roof|roof (was |has been )?(replaced|renewed|re-?covered)|re-?roofed/.test(t)) upgrades.push("new roof");
  if (/new (upvc |double[- ]glazed |triple[- ]glazed )?windows|windows (were |have been )?(replaced|renewed)/.test(t)) upgrades.push("new windows");
  if (/(brand new|newly fitted|newly installed|recently (fitted|installed|refitted|replaced)|new|refitted|re-fitted) (fitted |modern |contemporary |shaker |high[- ]gloss )?kitchen/.test(t)) upgrades.push("new kitchen");
  if (/(brand new|newly fitted|newly installed|recently (fitted|installed|refitted|replaced)|new|refitted|re-fitted) (family |modern |contemporary |luxury )?(bathroom|shower room)/.test(t)) upgrades.push("new bathroom");
  if (/solar (panels?|pv)|pv panels?/.test(t)) upgrades.push("solar panels");
  const nonStd = N.includes("cash") || /non[- ]standard construction|concrete construction|no[- ]fines|cornish unit|\bairey\b|steel[- ]framed construction|prefabricated|\bprc\b/.test(t);
  return {
    v: FACTS_VERSION,
    sqft: d.sqft || (() => { const a = t.match(/(\d{1,2},?\d{3}|\d{3})\s?(?:sq\.?\s?ft|sqft|square f(ee|oo)t)/); if (a) return +a[1].replace(",", ""); const b = t.match(/(\d{2,3}(?:\.\d+)?)\s?(?:sq\.?\s?m\b|sqm|square met)/); return b ? Math.round(+b[1] * 10.764) : 0; })(),
    baths: d.baths || 0, ensuite: P.includes("ensuite"), wc: P.includes("wc"), showerOnly: N.includes("showeronly"),
    receptions, bedSizes: sizes, allDoubles, smallBed, epc, ctax: d.ctax || "",
    tenure: d.tenure || (N.includes("lease") ? "LEASEHOLD" : ""), leaseYears: d.leaseYears || 0,
    chainFree: P.includes("nochain"), cond, upgrades,
    parking: P.includes("drive2") ? 2 : P.includes("drive") ? 1 : 0,
    garDouble: g.type.startsWith("Double"), garLarge: P.includes("largegar"), garPower: P.includes("garpower"), garUnclear: g.type.endsWith("?"), garLimited: N.includes("limited"),
    ext: P.includes("ext"), cons: P.includes("cons"), nonStd,
    auction: N.includes("auction"), mmoa: N.includes("mmoa"), buyerFee: N.includes("buyerfee"), shared: N.includes("shared"), age: N.includes("age")
  };
}
const listingText = d => [d.keyFeatures.join(".\n"), d.desc, d.rooms.join(".\n")].join("\n");

function typeCode(sub) {
  const s = (sub || "").toLowerCase();
  if (s.includes("bungalow")) return "B";
  if (s.includes("semi")) return "S";
  if (/end[- ]of[- ]terrace|end terrace/.test(s)) return "E";
  if (s.includes("link")) return "L";
  if (s.includes("town")) return "M";
  if (s.includes("terrace") || s.includes("mews")) return "T";
  if (s.includes("detached")) return "D";
  return "H";
}
const QUAL = { "guide price": "Guide", "offers in region of": "OIRO", "offers in the region of": "OIRO", "offers in excess of": "OIEO", "offers over": "Offers over", "fixed price": "Fixed price", "from": "From", "price on application": "POA", "offers invited": "Offers invited", "coming soon": "Coming soon" };
const qualShort = q => QUAL[String(q || "").trim().toLowerCase()] ?? String(q || "").trim();
const imgPath = u => { const m = String(u || "").match(/property-photo\/(.+?\.(jpe?g|png|webp|gif))/i); return m ? m[1].replace(/_max_\d+x\d+(?=\.)/, "") : ""; };
const outcodeOf = s => { const m = String(s || "").toUpperCase().match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)(?:\s*(\d)[A-Z]{2})?\s*$/); return m ? { out: m[1], sector: m[2] || "" } : null; };

function areaVerdict(pcOrAddr, S) {
  const o = outcodeOf(pcOrAddr);
  if (!o) return null; // can't tell
  if (S.outcodes.includes(o.out)) return true;
  const partly = S.sectors.filter(x => x.startsWith(o.out + " "));
  if (!partly.length) return false;
  if (!o.sector) return null; // e.g. "CV5" without the sector: open the listing to find out
  return partly.includes(`${o.out} ${o.sector}`);
}
const looksLikeGarage = p => (p.keywordMatchType && p.keywordMatchType !== "no_match") ||
  /garag/i.test([p.summary, ...(p.keyFeatures || []).map(k => k.description)].join(" "));
const histFrom = p => {
  const u = p.listingUpdate || {};
  if (/reduc/i.test(u.listingUpdateReason || "") && u.listingUpdateDate) return "R" + dmy(u.listingUpdateDate);
  return p.firstVisibleDate ? "A" + dmy(p.firstVisibleDate) : "";
};

function buildHouse(p, d, day) {
  const text = listingText(d);
  const g = classifyGarage(text);
  if (!g.has && !d.rooms.some(r => /^parking - garage|^garage\b/i.test(r))) return { skip: "no real garage (converted, rented or only space for one)" };
  const { P, N } = featureTags(text, d);
  const flags = [];
  if (N.includes("reno") || N.includes("poor")) flags.push("reno");
  if (N.includes("mmoa")) flags.push("MMoA"); else if (N.includes("auction")) flags.push("auction");
  if (N.includes("buyerfee")) flags.push("buyerfee");
  if (N.includes("shared")) flags.push("shared");
  if (N.includes("cash")) flags.push("cash/nonstd");
  if (N.includes("age")) flags.push("age");
  if (N.includes("lease") && d.leaseYears && d.leaseYears < 85) flags.push("shortlease");
  const status = d.tags.includes("SOLD_STC") ? 1 : d.tags.includes("UNDER_OFFER") ? 2 : 0;
  const price = p.price?.amount || d.price;
  return {
    house: {
      id: p.id, lat: d.lat ?? p.location?.latitude, lng: d.lng ?? p.location?.longitude, price,
      qual: qualShort(d.qual || p.price?.displayPrices?.[0]?.displayPriceQualifier), beds: d.beds || p.bedrooms,
      type: typeCode(d.subType || p.propertySubType), addr: d.addr || p.displayAddress, pc: d.pc,
      garage: g.has ? g.type : "Unstated", gq: g.quote, gdq: g.gdq, flags: flags.join(","), status,
      agent: d.agent || p.customer?.branchDisplayName || "", img: imgPath(d.img || p.propertyImages?.images?.[0]?.url),
      pos: P.join(","), neg: N.join(","), sqft: d.sqft || 0, ctax: d.ctax || "", baths: d.baths || p.bathrooms || 0,
      hist: histFrom(p), listed: p.firstVisibleDate ? isoDay(p.firstVisibleDate) : day, listedEst: false,
      leaseYears: d.leaseYears || 0, firstSeen: day, lastSeen: day, checked: day, src: "rightmove",
      f: extractFacts(d, text, g, P, N)
    }
  };
}

// ---------- The update itself ----------
// fetchPage(url) must resolve to { status, url, text }.
export async function runUpdate(db, fetchPage, opts = {}) {
  const S = { ...SETTINGS, ...opts };
  const log = S.log;
  const pause = () => sleep(S.delayMs[0] + Math.random() * (S.delayMs[1] - S.delayMs[0]));
  const now = Date.now(), day = isoDay(now);
  db.houses = db.houses || [];
  db.skipped = db.skipped || {};
  const byId = new Map(db.houses.map(h => [h.id, h]));
  const seen = new Map();
  const problems = [];
  let sweepComplete = true;
  const stats = { added: 0, back: 0, sold: 0, removed: 0, cheaper: 0, skipped: 0, reread: 0 };

  // 1. Go through every page of the searches
  for (const [i, q] of S.searches.entries()) {
    try {
      let page = 0, pages = 1, total = 0;
      do {
        const res = await fetchPage(`https://www.rightmove.co.uk/property-for-sale/find.html?${q}&index=${page * 24}`);
        if (res.status !== 200) throw new Error(`search page ${page + 1} returned ${res.status}`);
        const r = parseSearchPage(res.text);
        pages = Math.min(r.pages, 42); total = r.total;
        r.properties.forEach(p => { if (p && p.id && !seen.has(p.id)) seen.set(p.id, p); });
        page++;
        await pause();
      } while (page < pages);
      if (total > 1000) { sweepComplete = false; problems.push(`search ${i + 1} has ${total} results, over Rightmove's 1,000 limit`); }
      log(`Search ${i + 1}: ${total} listings over ${pages} pages`);
    } catch (e) {
      sweepComplete = false;
      problems.push(`couldn't read the Rightmove search (${e.message})`);
      log(`Search ${i + 1} failed: ${e.message}`);
    }
  }
  if (!seen.size) {
    db.lastRun = { at: new Date(now).toISOString(), ok: false, message: [...new Set(problems)].join("; ") || "Rightmove returned no listings" };
    return { ok: false, message: db.lastRun.message, stats };
  }

  // 2. Refresh houses we already know, and collect new ones worth opening
  const candidates = [];
  for (const [id, p] of seen) {
    const h = byId.get(id);
    if (h) {
      h.lastSeen = day;
      if (h.status !== 0) { h.status = 0; stats.back++; log(`Back on the market: ${h.addr}`); }
      const price = p.price?.amount;
      if (price && price !== h.price) { if (price < h.price) stats.cheaper++; h.price = price; }
      if (p.price?.displayPrices?.length) h.qual = qualShort(p.price.displayPrices[0].displayPriceQualifier);
      if (p.firstVisibleDate) { h.listed = isoDay(p.firstVisibleDate); h.listedEst = false; }
      const hist = histFrom(p); if (hist) h.hist = hist;
      if (!h.img) h.img = imgPath(p.propertyImages?.images?.[0]?.url);
      continue;
    }
    if (db.skipped[id]) { db.skipped[id].seen = day; continue; }
    if (!looksLikeGarage(p)) continue; // no garage in the listing: re-checked for free every run
    if (areaVerdict(p.displayAddress, S) === false) continue;
    if (p.location && milesBetween(S.centre, [p.location.latitude, p.location.longitude]) > S.maxMiles) continue;
    candidates.push(p);
  }

  // 3. Open each new listing and read it properly
  candidates.sort((a, b) => String(b.firstVisibleDate).localeCompare(String(a.firstVisibleDate)));
  for (const p of candidates.slice(0, S.maxDetailFetches)) {
    try {
      const res = await fetchPage(`https://www.rightmove.co.uk/properties/${p.id}`);
      await pause();
      const d = res.status === 200 ? parseListingPage(res.text) : null;
      if (!d) { problems.push(`couldn't read listing ${p.id}`); continue; }
      if (areaVerdict(d.pc, S) === false) { db.skipped[p.id] = { why: "outside your areas", seen: day }; stats.skipped++; continue; }
      const r = buildHouse(p, d, day);
      if (r.skip) { db.skipped[p.id] = { why: r.skip, seen: day }; stats.skipped++; continue; }
      db.houses.push(r.house); byId.set(r.house.id, r.house); stats.added++;
      log(`New: ${r.house.addr} £${r.house.price.toLocaleString("en-GB")} (${r.house.garage} garage)`);
    } catch (e) { problems.push(`listing ${p.id}: ${e.message}`); }
  }
  if (candidates.length > S.maxDetailFetches) log(`${candidates.length - S.maxDetailFetches} more new listings will be read next time`);

  // 3b. Re-read older listings for the detailed check (bedroom sizes, condition, upgrades, EPC...)
  const stale = db.houses.filter(h => h.status === 0 && h.src === "rightmove" && seen.has(h.id) && (!h.f || h.f.v !== FACTS_VERSION));
  for (const h of stale.slice(0, S.maxRereads)) {
    try {
      const res = await fetchPage(`https://www.rightmove.co.uk/properties/${h.id}`);
      await pause();
      const d = res.status === 200 ? parseListingPage(res.text) : null;
      if (!d) continue;
      const text = listingText(d);
      const g = classifyGarage(text);
      const { P, N } = featureTags(text, d);
      h.f = extractFacts(d, text, g, P, N);
      if (d.sqft) h.sqft = d.sqft;
      if (d.ctax) h.ctax = d.ctax;
      if (d.baths) h.baths = d.baths;
      if (!h.gq && g.quote) h.gq = g.quote;
      stats.reread++;
    } catch (e) { problems.push(`re-reading ${h.id}: ${e.message}`); }
  }
  if (stale.length > S.maxRereads) log(`${stale.length - S.maxRereads} more listings will get the detailed check next time`);
  if (stats.reread) log(`Detailed check done for ${stats.reread} listings`);

  // 4. Houses that dropped out of the search: sold, under offer or taken off?
  const check = async (h, label) => {
    try {
      const res = await fetchPage(`https://www.rightmove.co.uk/properties/${h.id}`);
      await pause();
      h.checked = day;
      const d = res.status === 200 ? parseListingPage(res.text) : null;
      if (res.status === 404 || res.status === 410 || (res.status === 200 && (!d || !d.published) && /removed|no longer|not available|archived/i.test(res.text))) {
        if (h.status !== 3) { h.status = 3; h.offMarket = day; stats.removed++; log(`Off the market: ${h.addr}`); }
        return;
      }
      if (!d) return;
      const st = d.tags.includes("SOLD_STC") ? 1 : d.tags.includes("UNDER_OFFER") ? 2 : d.published ? 0 : 3;
      if (st !== h.status) { if (st === 1 || st === 2) stats.sold++; if (st === 3) { stats.removed++; h.offMarket = day; } h.status = st; log(`${label}: ${h.addr} is now ${["available", "sold STC", "under offer", "off the market"][st]}`); }
      if (d.price) h.price = d.price;
    } catch (e) { problems.push(`checking ${h.id}: ${e.message}`); }
  };
  if (sweepComplete) {
    const missing = db.houses.filter(h => h.status === 0 && h.src === "rightmove" && !seen.has(h.id) && h.checked !== day)
      .sort((a, b) => String(a.checked || "").localeCompare(String(b.checked || "")));
    for (const h of missing.slice(0, S.maxMissingChecks)) await check(h, "Changed");
    const soldOnes = db.houses.filter(h => (h.status === 1 || h.status === 2) && h.src === "rightmove" && !seen.has(h.id))
      .sort((a, b) => String(a.checked || "").localeCompare(String(b.checked || "")));
    for (const h of soldOnes.slice(0, S.maxSoldChecks)) await check(h, "Re-check");
  } else {
    log("Search didn't finish, so no houses were marked as sold or removed this time");
  }

  // 5. Tidy up and record how it went
  for (const [id, s] of Object.entries(db.skipped)) if (now - Date.parse(s.seen) > 60 * DAY) delete db.skipped[id];
  if (sweepComplete) db.updated = new Date(now).toISOString();
  const summary = `${stats.added} new, ${stats.reread} re-checked, ${stats.cheaper} price drops, ${stats.sold} sold STC/under offer, ${stats.removed} off the market, ${stats.back} back on the market`;
  db.lastRun = { at: new Date(now).toISOString(), ok: sweepComplete, message: sweepComplete ? summary : problems[0], problems: problems.slice(0, 10), stats };
  return { ok: sweepComplete, message: summary + (problems.length ? ` (${problems.length} problems: ${problems.slice(0, 3).join("; ")})` : ""), stats };
}

// One house per line, so GitHub shows readable changes
export const serialize = db => JSON.stringify({ ...db, houses: undefined })
  .replace(/}$/, `,"houses":[\n${db.houses.map(h => JSON.stringify(h)).join(",\n")}\n]}`).replace("{,", "{") + "\n";
// ===== END CORE =====

// ===== NODE MAIN =====
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9"
};
async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS, redirect: "follow" });
      const text = await r.text();
      if (r.status >= 500 && attempt < 3) throw new Error("server error " + r.status);
      return { status: r.status, url: r.url, text };
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(6000 * attempt);
    }
  }
}
async function nodeMain() {
  const fs = await import("node:fs/promises");
  const file = new URL("./listings.json", import.meta.url);
  const db = JSON.parse(await fs.readFile(file, "utf8"));
  const result = await runUpdate(db, fetchPage);
  await fs.writeFile(file, serialize(db));
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}
if (typeof process !== "undefined" && process.versions?.node && !globalThis.HOUSE_MAP_NO_MAIN) await nodeMain();
