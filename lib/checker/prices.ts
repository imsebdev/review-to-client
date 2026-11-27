// lib/checker/prices.ts
//
// Swedish retail price arithmetic, so the checker can verify numbers without AI:
//   - parse offer prices: "69:90/kg", "45:-/st", "2 för 99:-", "5 för 55:- 10 för 100:-"
//   - parse pack sizes from the info line: "450 g", "380-460 ml", "6x33 cl", "2 kg", "20-43 st"
//   - recompute "Jfr-pris" (comparison price) and "Du sparar" and compare with what is printed
//
// Money is handled in öre (integers) to avoid float noise. Coop rounds comparison prices to
// the nearest öre, so we allow ±1 öre per endpoint.

export type Offer = {
  qty: number; // "2 för" -> 2, plain price -> 1
  total: number; // öre for `qty` items
  per: "st" | "kg" | "liter" | "förp" | null; // unit after the price ("/kg"), if any
};

export type Quantity = { min: number; max: number; unit: "kg" | "liter" | "st" };

export type Finding = { ok: boolean; message: string; expected?: string; found?: string };

const ORE = 100;

/** "99:-" → 9900, "69:90" → 6990, "1:97" → 197, "45,50" → 4550, "110:-" → 11000 */
export function parseMoney(s: string): number | null {
  const m = s.trim().match(/^(\d{1,5})(?:[:.,](\d{2}|-{1,2}))?$/);
  if (!m) return null;
  const kr = Number(m[1]);
  const ore = m[2] && /\d/.test(m[2]) ? Number(m[2]) : 0;
  return kr * ORE + ore;
}

export function formatMoney(ore: number): string {
  const kr = Math.floor(ore / ORE);
  const rest = ore % ORE;
  return rest === 0 ? `${kr}:-` : `${kr}:${String(rest).padStart(2, "0")}`;
}

/**
 * Parse every offer tier in a price text.
 * "2 för 99:-" → [{qty:2,total:9900}], "5 för 55:- 10 för 100:-" → two tiers,
 * "69:90 /kg" → [{qty:1,total:6990,per:"kg"}]. Superscript öre on images often
 * comes back as "69 90" — accepted too.
 */
export function parseOffers(text: string): Offer[] {
  const t = text.replace(/\s+/g, " ").replace(/–/g, "-").toLowerCase();
  const offers: Offer[] = [];
  // "2 för", "2-för", "2för", "2 st för" (badges often stack "2 / FÖR" and get read with a hyphen)
  const multi = /(\d+)\s*(?:st\s*)?-?\s*för\s*(\d{1,5}(?:[:.,]\d{2}|:-{1,2}|:)?)\s*(?:\/\s*(st|kg|liter|förp))?/g;
  let m: RegExpExecArray | null;
  while ((m = multi.exec(t))) {
    const total = parseMoney(m[2].replace(/:$/, ":-"));
    if (total != null) offers.push({ qty: Number(m[1]), total, per: (m[3] as Offer["per"]) ?? null });
  }
  if (offers.length) return offers;
  const single = t.match(/(\d{1,5})(?:\s*[:.,]\s*(\d{2}|-{1,2})|\s+(\d{2})\b)?\s*(?::-)?\s*\/?\s*(st|kg|liter|förp)?/);
  if (single) {
    const ore = single[2] && /\d/.test(single[2]) ? Number(single[2]) : single[3] ? Number(single[3]) : 0;
    offers.push({ qty: 1, total: Number(single[1]) * ORE + ore, per: (single[4] as Offer["per"]) ?? null });
  }
  return offers;
}

/** Pack size from an info line. "Ca" (approximate) weights are returned but flagged by the caller. */
export function parseQuantity(info: string): (Quantity & { approx: boolean }) | null {
  const t = info.replace(/\s+/g, " ").replace(/–/g, "-").toLowerCase();
  const approx = /\bca\b/.test(t);
  // multipack "6x33 cl", "3x90 g"
  const mp = t.match(/(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(g|kg|ml|cl|dl|l|liter)\b/);
  if (mp) {
    const q = toBase(Number(mp[1]) * num(mp[2]), mp[3]);
    return { min: q.value, max: q.value, unit: q.unit, approx };
  }
  const rg = t.match(/(\d+(?:[.,]\d+)?)\s*(?:-\s*(\d+(?:[.,]\d+)?))?\s*(g|kg|ml|cl|dl|l|liter|st)\b(?!\/)/);
  if (!rg) return null;
  const a = toBase(num(rg[1]), rg[3]);
  const b = rg[2] ? toBase(num(rg[2]), rg[3]) : a;
  return { min: Math.min(a.value, b.value), max: Math.max(a.value, b.value), unit: a.unit, approx };
}

/**
 * Every pack size mentioned in an info line, in order. Products packed in liquid (pickled beetroot,
 * herring, shrimp in brine…) print both the net weight and the drained weight ("avrunnen vikt"), and
 * their Jfr-pris is based on the DRAINED weight — so the first weight alone isn't enough.
 * drained=true when the weight is labelled "avrunnen/avr. vikt" (before or after) or is the second of "530 g/350 g".
 */
export function parseQuantities(info: string): Array<Quantity & { approx: boolean; drained: boolean }> {
  const t = info.replace(/\s+/g, " ").replace(/–/g, "-").toLowerCase();
  const approx = /\bca\b/.test(t);
  const out: Array<Quantity & { approx: boolean; drained: boolean }> = [];
  const re = /(?:(\d+)\s*x\s*)?(\d+(?:[.,]\d+)?)\s*(?:-\s*(\d+(?:[.,]\d+)?))?\s*(g|kg|ml|cl|dl|l|liter|st)\b(?!\s*\/\s*(?:hushåll|kund|person))/g;
  const DRAINED = /avr(?:unnen|\.|un)?\s*(?:vikt)?|drained|fast vikt/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const unit = m[4];
    const mult = m[1] ? Number(m[1]) : 1;
    const a = toBase(mult * num(m[2]), unit);
    const b = m[3] ? toBase(mult * num(m[3]), unit) : a;
    const before = t.slice(Math.max(0, m.index - 25), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const drained =
      DRAINED.test(before.split(/[.;]/).pop() ?? "") || /^\s*\(?\s*avr/.test(after) || (/\/\s*$/.test(before) && out.length > 0);
    out.push({ min: Math.min(a.value, b.value), max: Math.max(a.value, b.value), unit: a.unit, approx, drained });
  }
  return out;
}

function num(s: string) {
  return Number(s.replace(",", "."));
}

function toBase(v: number, unit: string): { value: number; unit: Quantity["unit"] } {
  switch (unit) {
    case "g":
      return { value: v / 1000, unit: "kg" };
    case "kg":
      return { value: v, unit: "kg" };
    case "ml":
      return { value: v / 1000, unit: "liter" };
    case "cl":
      return { value: v / 100, unit: "liter" };
    case "dl":
      return { value: v / 10, unit: "liter" };
    case "l":
    case "liter":
      return { value: v, unit: "liter" };
    default:
      return { value: v, unit: "st" };
  }
}

/** Jfr-pris printed on the ad: "Jfr-pris 96:74-117:11/liter", "Jfr-pris 110:-/kg". Several tiers possible. */
export function parseJfr(info: string): Array<{ min: number; max: number; unit: string; tier: number | null }> {
  const t = info.replace(/\s+/g, " ").replace(/–/g, "-");
  const out: Array<{ min: number; max: number; unit: string; tier: number | null }> = [];
  // tiered: "vid köp av 2: 1:97-4:23/st"
  const tierRe = /vid köp av (\d+):\s*([\d:,.\-]+?)\/(kg|liter|st|tvätt)/gi;
  let m: RegExpExecArray | null;
  while ((m = tierRe.exec(t))) {
    const r = parseRange(m[2]);
    if (r) out.push({ ...r, unit: m[3].toLowerCase(), tier: Number(m[1]) });
  }
  if (out.length) return out;
  const plain = t.match(/jfr-?pris\s*([\d:,.\-]+?)\/(kg|liter|st|tvätt)/i);
  if (plain) {
    const r = parseRange(plain[1]);
    if (r) out.push({ ...r, unit: plain[2].toLowerCase(), tier: null });
  }
  return out;
}

function parseRange(s: string): { min: number; max: number } | null {
  // "96:74-117:11", "65:--86:67", "110:-", "1:60-1:81"
  const parts = s.match(/\d{1,5}(?:[:.,]\d{2}|:-{1,2})?/g);
  if (!parts || !parts.length) return null;
  const vals = parts.map((p) => parseMoney(p)).filter((v): v is number => v != null);
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/**
 * Recompute the comparison price from offer + pack size and compare with the printed one.
 * Returns null when it can't be checked (approximate weight, per-wash, unit mismatch).
 */
export function checkJfr(priceText: string, info: string): Finding[] {
  const offers = parseOffers(priceText);
  const sizes = info.replace(/jfr-?pris.*$/i, ""); // pack sizes, not the jfr itself
  const qty = parseQuantity(sizes);
  const printed = parseJfr(info);
  if (!offers.length || !qty || !printed.length) return [];
  if (qty.approx) return [];
  const all = parseQuantities(sizes);
  const findings: Finding[] = [];
  for (const p of printed) {
    // candidates: every pack size in the right unit, drained weight first (that's what Jfr-pris uses)
    const cands = all.filter((q) => q.unit === p.unit).sort((a, b) => Number(b.drained) - Number(a.drained));
    if (!cands.length) continue; // e.g. "/tvätt" — can't be derived from pack size
    const offer = p.tier ? offers.find((o) => o.qty === p.tier) : offers[0];
    if (!offer || (offer.per && offer.per !== "st" && offer.per !== "förp")) continue; // /kg prices have no pack jfr
    const each = offer.total / offer.qty;
    const exp = (q: Quantity) => ({ min: Math.round(each / q.max), max: Math.round(each / q.min) });
    const matches = (e: { min: number; max: number }) => Math.abs(e.min - p.min) <= 1 && Math.abs(e.max - p.max) <= 1;
    const hit = cands.find((q) => matches(exp(q)));
    const e = exp(hit ?? cands[0]);
    const ok = !!hit;
    const fmt = (a: number, b: number) => (a === b ? formatMoney(a) : `${formatMoney(a)}-${formatMoney(b)}`);
    findings.push({
      ok,
      message: ok ? "Jfr-pris is correct" : "Jfr-pris doesn't match the price and pack size",
      expected: `${fmt(e.min, e.max)}/${p.unit}${p.tier ? ` (vid köp av ${p.tier})` : ""}`,
      found: `${fmt(p.min, p.max)}/${p.unit}`,
    });
  }
  return findings;
}

/**
 * "Du sparar 5:60" against "Tidigare lägsta pris 45:50/st" or "Ord. pris (från) 37:90/st".
 * With "minst" the saving is the smallest one (cheapest ordinary price).
 */
export function checkSaving(priceText: string, info: string, savingText: string): Finding | null {
  const offers = parseOffers(priceText);
  const ord = info.match(/(?:ord\.?\s*pris|tidigare lägsta pris)\s*(?:från\s*)?([\d:,.\-]+?)\/st/i);
  // "5:60", "5,60", "11:-" — or superscript öre read as "5 60"
  const saving = savingText.match(/(\d{1,5}\s+\d{2}\b|\d{1,5}(?:[:.,]\d{2}|:-)?)/);
  if (!offers.length || !ord || !saving) return null;
  const ordOre = parseMoney(ord[1]);
  const savOre = parseMoney(saving[1].replace(/\s+/, ":"));
  if (ordOre == null || savOre == null) return null;
  const o = offers[0];
  const expected = ordOre * o.qty - o.total;
  const ok = Math.abs(expected - savOre) <= 1;
  return {
    ok,
    message: ok ? '"Du sparar" is correct' : '"Du sparar" doesn\'t match the ordinary price'  ,
    expected: formatMoney(expected),
    found: formatMoney(savOre),
  };
}

/** A weight splash ("1 KG", "500 G") must agree with the pack size in the info line. */
export function checkWeightSplash(splash: string, info: string): Finding | null {
  const s = parseQuantity(splash);
  const q = parseQuantity(info.replace(/jfr-?pris.*$/i, ""));
  if (!s || !q || s.unit !== q.unit) return null;
  const ok = s.min >= q.min - 1e-9 && s.max <= q.max + 1e-9;
  return {
    ok,
    message: ok ? "Weight splash is correct" : "Weight splash doesn't match the info line",
    expected: fmtQty(q),
    found: splash.trim(),
  };
}

function fmtQty(q: Quantity): string {
  const one = (v: number) =>
    q.unit === "kg" ? (v < 1 ? `${Math.round(v * 1000)} g` : `${v} kg`) : q.unit === "liter" ? (v < 1 ? `${Math.round(v * 1000)} ml` : `${v} liter`) : `${v} st`;
  return q.min === q.max ? one(q.min) : `${one(q.min)}-${one(q.max)}`;
}
