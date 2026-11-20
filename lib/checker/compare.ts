// lib/checker/compare.ts
//
// Compares what an ad says (AdReading) with what it should say (flyer products for the
// MVK/poster, manus headline, flyer validity) and runs the arithmetic checks.
// Pure functions: no network, easy to test with hand-written readings.

import type { AdItem, AdReading } from "./ad";
import type { FlyerProduct } from "./flyer";
import { checkJfr, checkSaving, checkWeightSplash, parseOffers } from "./prices";

export type Severity = "error" | "warning";

export type Issue = {
  severity: Severity;
  product?: string;
  message: string;
  expected?: string;
  found?: string;
};

export type FileResult = {
  file: string; // display name, e.g. "MVK 6" or the poster file name
  kind: "mvk" | "poster";
  expectedCount: number;
  foundCount: number;
  matchedCount: number;
  issues: Issue[];
};

// ---------- text helpers ----------

export function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/[   ]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function key(s: string): string {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9åäöéü]+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = `  ${key(s)}  `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => B.has(x) && inter++);
  return (2 * inter) / (A.size + B.size);
}

function samePrice(a: string, b: string): boolean {
  const pa = parseOffers(a);
  const pb = parseOffers(b);
  if (!pa.length || !pb.length || pa.length !== pb.length) return false;
  return pa.every((o, i) => o.qty === pb[i].qty && o.total === pb[i].total);
}

function unitOf(s: string): string | null {
  const m = norm(s).toLowerCase().match(/\/\s*(kg|st|liter|förp)/);
  return m ? m[1] : null;
}

/** Words/numbers present in one text but not the other — enough to explain an info-line difference. */
function wordDiff(expected: string, found: string): { missing: string[]; extra: string[] } {
  const tok = (s: string) => norm(s).split(" ").map((w) => w.replace(/[.,;:]+$/, ""));
  const e = tok(expected);
  const f = tok(found);
  const count = (arr: string[]) => arr.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
  const ce = count(e);
  const cf = count(f);
  const missing: string[] = [];
  const extra: string[] = [];
  ce.forEach((n, w) => {
    for (let i = 0; i < n - (cf.get(w) ?? 0); i++) missing.push(w);
  });
  cf.forEach((n, w) => {
    for (let i = 0; i < n - (ce.get(w) ?? 0); i++) extra.push(w);
  });
  return { missing, extra };
}

const hasDigit = (w: string) => /\d/.test(w);

const LIMIT_RE = /max\s*\d+\s*(?:st|köp|kg|förp)\.?\s*\/\s*hushåll\.?/gi;

/** Split "… 500 g. Jfr-pris 99:80/kg. Max 3 st/hushåll." into info without the limit + the limit. */
export function splitLimit(info: string, limit: string | null): { info: string; limit: string } {
  const found: string[] = [...(info.match(LIMIT_RE) ?? []), ...(limit ? [limit] : [])];
  const cleaned = norm(info.replace(LIMIT_RE, " "));
  const lim = found.map((l) => norm(l).toLowerCase().replace(/\s+/g, "").replace(/\.$/, ""))[0] ?? "";
  return { info: cleaned, limit: lim };
}

/** dd/mm–dd/mm (any text around it) → [start, end] as comparable numbers, or null. */
function dateRange(s: string | null): [number, number] | null {
  const m = (s ?? "").match(/(\d{1,2})\/(\d{1,2})\D+(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return [Number(m[2]) * 100 + Number(m[1]), Number(m[4]) * 100 + Number(m[3])];
}

// ---------- matching ad items to expected products ----------

type Match = { exp: FlyerProduct; item: AdItem; by: "name" | "price" };

export function matchItems(expected: FlyerProduct[], items: AdItem[]) {
  const pairs: Array<{ e: number; i: number; score: number }> = [];
  expected.forEach((exp, e) => {
    items.forEach((it, i) => {
      const nameScore = Math.max(similarity(it.name, exp.heading || exp.manusName), similarity(it.name, exp.manusName));
      const priceBonus = exp.found && samePrice(it.price, exp.price) ? 0.25 : 0;
      pairs.push({ e, i, score: nameScore + priceBonus });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedE = new Set<number>();
  const usedI = new Set<number>();
  const matches: Match[] = [];
  for (const p of pairs) {
    if (p.score < 0.5 || usedE.has(p.e) || usedI.has(p.i)) continue;
    usedE.add(p.e);
    usedI.add(p.i);
    matches.push({ exp: expected[p.e], item: items[p.i], by: "name" });
  }
  // second pass: a leftover ad item whose price equals a leftover product's price is probably
  // that product with the wrong name/text on it (e.g. chicken labelled "Clementiner")
  items.forEach((it, i) => {
    if (usedI.has(i)) return;
    const e = expected.findIndex((exp, k) => !usedE.has(k) && exp.found && samePrice(it.price, exp.price));
    if (e >= 0) {
      usedE.add(e);
      usedI.add(i);
      matches.push({ exp: expected[e], item: it, by: "price" });
    }
  });
  return {
    matches,
    missing: expected.filter((_, k) => !usedE.has(k)),
    extra: items.filter((_, k) => !usedI.has(k)),
  };
}

// ---------- per product ----------

function compareProduct(m: Match): Issue[] {
  const { exp, item } = m;
  const issues: Issue[] = [];
  const product = exp.heading || exp.manusName;

  if (!item.labelMatchesPhoto) {
    issues.push({
      severity: "error",
      product,
      message: "The text doesn't belong to the product photo",
      found: `text "${item.name}", photo shows ${item.photoShows}`,
    });
  }

  if (!exp.found) {
    // product not in the flyer (X:-TRA "egen vara"): only arithmetic + spelling can be checked
    issues.push(...arithmetic(item, product));
    return issues;
  }

  // name, price and info all different → it's another product, say that once instead of four times
  const infoDiffers = norm(exp.info).replace(/[.\s]+$/, "") !== norm(item.info).replace(/[.\s]+$/, "");
  if (m.by === "name" && similarity(item.name, exp.heading) < 0.8 && !samePrice(item.price, exp.price) && infoDiffers) {
    issues.push({
      severity: "error",
      product,
      message: "Looks like a different product than the manus asks for",
      expected: `${exp.heading} — ${exp.price}${exp.memberPrice ? " Medlemspris" : ""} — ${exp.info} (flyer p. ${exp.page ?? "?"})`,
      found: `${item.name} — ${item.price}${item.memberPrice ? " Medlemspris" : ""} — ${item.info}`,
    });
    return issues;
  }

  if (m.by === "price" || similarity(item.name, exp.heading) < 0.8) {
    issues.push({
      severity: m.by === "price" ? "error" : "warning",
      product,
      message: "Product name differs from the flyer",
      expected: exp.heading,
      found: item.name,
    });
  }

  if (!samePrice(item.price, exp.price)) {
    issues.push({ severity: "error", product, message: "Price differs from the flyer", expected: exp.price, found: item.price });
  } else {
    const ue = unitOf(exp.price);
    const ui = unitOf(item.price);
    if (ue && ui && ue !== ui)
      issues.push({ severity: "error", product, message: "Price unit differs (/kg vs /st)", expected: exp.price, found: item.price });
  }

  if (exp.memberPrice !== item.memberPrice) {
    issues.push({
      severity: "error",
      product,
      message: exp.memberPrice ? '"Medlemspris" is missing' : '"Medlemspris" is shown but the flyer has no member price',
    });
  }
  if (exp.klipp && !item.klipp) issues.push({ severity: "warning", product, message: '"KLIPP!" badge from the flyer is missing' });

  const e = splitLimit(exp.info, exp.limit);
  const a = splitLimit(item.info, item.limit);
  if (e.limit && !a.limit) issues.push({ severity: "error", product, message: "Purchase limit is missing", expected: exp.limit ?? e.limit });
  else if (!e.limit && a.limit) issues.push({ severity: "error", product, message: "Purchase limit is not in the flyer", found: item.limit ?? a.limit });
  else if (e.limit && a.limit && e.limit !== a.limit)
    issues.push({ severity: "error", product, message: "Purchase limit differs", expected: exp.limit ?? e.limit, found: item.limit ?? a.limit });

  // line breaks after "/" come back as "Nederländerna/ Sverige" — not a real difference
  const stripEnd = (x: string) => x.replace(/\s*\/\s*/g, "/").replace(/[.\s]+$/, "");
  // ' vs ’ is the same character to a reader; a missing space after "." may just be a line break in the ad
  const quotes = (x: string) => x.replace(/[’‘`´]/g, "'");
  const squash = (x: string) => quotes(stripEnd(x)).replace(/\s+/g, "");
  if (stripEnd(e.info) !== stripEnd(a.info) && squash(e.info) === squash(a.info)) {
    if (quotes(stripEnd(e.info)) !== quotes(stripEnd(a.info)))
      issues.push({
        severity: "warning",
        product,
        message: "Spacing differs from the flyer — check for a missing space (e.g. after a full stop)",
        expected: e.info,
        found: a.info,
      });
  } else if (stripEnd(e.info) !== stripEnd(a.info)) {
    const d = wordDiff(stripEnd(e.info), stripEnd(a.info));
    const numeric = [...d.missing, ...d.extra].some(hasDigit);
    const onlyPunct = !d.missing.length && !d.extra.length;
    issues.push({
      severity: onlyPunct ? "warning" : numeric || d.missing.length + d.extra.length > 0 ? "error" : "warning",
      product,
      message: onlyPunct ? "Info text differs from the flyer in punctuation/spacing" : "Info text differs from the flyer",
      expected: e.info,
      found: a.info,
    });
  }

  // arithmetic: if the flyer prints the same numbers, the mistake is Coop's, not the designer's
  const sameAsFlyer = stripEnd(e.info) === stripEnd(a.info) && samePrice(item.price, exp.price);
  for (const x of arithmetic(item, product)) {
    if (sameAsFlyer && /Jfr-pris/.test(x.message))
      issues.push({ ...x, severity: "warning", message: `${x.message} — the flyer says the same, so this is probably Coop's error (ask Pernilla)` });
    else issues.push(x);
  }
  return issues;
}

function arithmetic(item: AdItem, product: string): Issue[] {
  const issues: Issue[] = [];
  for (const f of checkJfr(item.price, item.info)) {
    if (!f.ok) issues.push({ severity: "error", product, message: f.message, expected: f.expected, found: f.found });
  }
  for (const s of item.splashes) {
    if (/sparar/i.test(s)) {
      const f = checkSaving(item.price, item.info, s);
      if (f && !f.ok) issues.push({ severity: "error", product, message: f.message, expected: f.expected, found: f.found });
    } else if (/^\s*(ca\s*)?\d+([.,]\d+)?\s*(g|kg|ml|cl|dl|l|liter)\s*$/i.test(s)) {
      const f = checkWeightSplash(s, item.info);
      if (f && !f.ok) issues.push({ severity: "error", product, message: f.message, expected: f.expected, found: f.found });
    }
  }
  return issues;
}

// ---------- texts on the ad ----------

function allTexts(r: AdReading): string[] {
  return [
    r.headline ?? "",
    ...r.otherText,
    ...r.items.flatMap((i) => [i.name, i.price, i.info, i.limit ?? "", ...i.splashes]),
  ].filter((t) => !!key(t));
}

function textMatches(t: string, want: string): boolean {
  const k = key(t);
  const w = key(want);
  if (!k || !w) return false;
  return k === w || (w.length >= 6 && (k.includes(w) || (w.includes(k) && k.length >= 6))) || similarity(t, want) >= 0.8;
}

/** The first text on the ad that matches `want` (headline, splashes, item names…), or null. */
export function findText(r: AdReading, want: string): string | null {
  return allTexts(r).find((t) => textMatches(t, want)) ?? null;
}

// ---------- per file ----------

export function checkFile(opts: {
  file: string;
  kind: "mvk" | "poster";
  expected: FlyerProduct[];
  reading: AdReading;
  flyerValidity: string | null;
  manusHeadline: string | null;
  headlineNeedsPeriod: boolean;
  fileNameProducts?: string[]; // product words taken from a poster's file name
  // from the client's feedback on the card (overrides the manus)
  forbidHeadline?: boolean; // client asked for no headline
  requiredTexts?: Array<{ text: string; quote: string }>; // must appear on the ad
  forbiddenTexts?: Array<{ text: string; product: string | null; quote: string }>; // must not appear
}): FileResult {
  const { reading } = opts;
  const issues: Issue[] = [];
  const { matches, missing, extra } = matchItems(opts.expected, reading.items);

  for (const m of missing)
    issues.push({ severity: "error", product: m.heading || m.manusName, message: "Product from the manus is missing" });
  for (const x of extra)
    issues.push({
      severity: "warning",
      product: x.name,
      message: "Product is not in the manus for this ad",
      found: `${x.name} ${x.price}`.trim(),
    });

  // the same product name twice on one ad is almost always a copy-paste slip
  const names = reading.items.map((i) => key(i.name));
  names.forEach((n, i) => {
    if (n && names.indexOf(n) !== i)
      issues.push({ severity: "error", product: reading.items[i].name, message: "Same product name appears twice" });
  });

  for (const m of matches) issues.push(...compareProduct(m));

  // validity dates
  const fr = dateRange(opts.flyerValidity);
  const ar = dateRange(reading.validity);
  if (fr && ar && (ar[0] < fr[0] || ar[1] > fr[1]))
    issues.push({ severity: "error", message: "Dates are outside the flyer's validity period", expected: opts.flyerValidity!, found: reading.validity! });

  // headline. Ads often carry several big texts (an event splash like "Kanelbullens dag 4/10!",
  // "12-PACK", "Helgerbjudande …"), so the manus headline only has to appear in one of them.
  let headline = reading.headline;
  if (opts.manusHeadline) {
    const hit = findText(reading, opts.manusHeadline);
    if (hit) headline = hit;
    else if (!reading.headline) issues.push({ severity: "warning", message: "Headline from the manus is missing", expected: opts.manusHeadline });
    else
      issues.push({ severity: "warning", message: "Headline differs from the manus", expected: opts.manusHeadline, found: reading.headline });
  } else if (opts.forbidHeadline && reading.headline) {
    // a text the client asked for (e.g. a bauble "Julstöket kan börja!") may be read as the headline
    const wanted = (opts.requiredTexts ?? []).some((r) => textMatches(reading.headline!, r.text));
    if (!wanted) {
      issues.push({ severity: "error", message: "The client asked to remove the headline", found: reading.headline });
      headline = null;
    }
  }
  for (const r of opts.requiredTexts ?? [])
    if (!findText(reading, r.text))
      issues.push({ severity: "error", message: `Text the client asked for is missing (client: “${r.quote}”)`, expected: r.text });
  for (const f of opts.forbiddenTexts ?? []) {
    const where = f.product
      ? reading.items
          .filter((i) => similarity(i.name, f.product!) >= 0.5)
          .flatMap((i) => [i.name, i.price, i.info, i.limit ?? "", ...i.splashes])
      : allTexts(reading);
    const hit = where.find((t) => t && key(t).includes(key(f.text)));
    if (hit)
      issues.push({
        severity: "error",
        product: f.product ?? undefined,
        message: `The client asked to remove this (client: “${f.quote}”)`,
        found: hit,
      });
  }

  if (opts.headlineNeedsPeriod && headline && !/[.!?]$/.test(norm(headline)))
    issues.push({ severity: "warning", message: 'Headline should end with a period ("Alltid punkt i rubrik")', found: headline });

  // poster file name should name products that are on the poster
  for (const p of opts.fileNameProducts ?? []) {
    if (!reading.items.some((i) => similarity(i.name, p) >= 0.5))
      issues.push({ severity: "warning", message: "File name mentions a product that isn't on the poster", found: p });
  }

  const alreadyFound = new Set(issues.map((i) => key(i.found ?? "")).filter(Boolean));
  for (const t of reading.textIssues) {
    if (key(t.text) === key(t.suggestion)) continue; // "Röda äpplen" → "Röda äpplen"
    if (alreadyFound.has(key(t.text))) continue; // same thing as an arithmetic finding
    if (Array.from(alreadyFound).some((f) => f.includes(key(t.text)))) continue; // already shown in an info-line diff
    issues.push({ severity: "warning", message: `Text: ${t.issue}`, found: t.text, expected: t.suggestion });
  }
  for (const u of reading.unreadable) issues.push({ severity: "warning", message: "Couldn't read reliably — check by eye", found: u });

  return {
    file: opts.file,
    kind: opts.kind,
    expectedCount: opts.expected.length,
    foundCount: reading.items.length,
    matchedCount: matches.length,
    issues,
  };
}

/** "X_-TRA - Jul Veckoboost 48 - Potatis i påse & Brysselkål i nät- 70x100.jpg" → ["Potatis i påse", "Brysselkål i nät"] */
export function productsFromPosterName(fileName: string): string[] {
  const base = (fileName.split("/").pop() || fileName).replace(/\.[a-z]+$/i, "");
  const m = base.match(/(?:veckoboost|v)\s*\.?\s*\d{1,2}\s*-\s*(.+?)\s*-?\s*70\s*x\s*100/i);
  if (!m) return [];
  if (/favorit|skyl|poster|samlad|alla/i.test(m[1])) return [];
  // theme words in file names ("Jul", "Påsk", "Christmas") aren't products
  const theme = /^(jul|julen|jultema|christmas|xmas|påsk|nyår|midsommar|halloween|tema|theme|veckoboost|skyl+t|poster|final|ny|new|v\d+)$/i;
  return m[1]
    .split(/\s*&\s*|\s*,\s*|\s+och\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && !theme.test(s));
}
