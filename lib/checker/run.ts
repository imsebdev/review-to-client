// lib/checker/run.ts
//
// Runs the whole check for one ClickUp card:
//   ClickUp task → download attachments → manus → flyer → read every MVK/poster → compare.

import { createHash } from "crypto";
import { Redis } from "@upstash/redis";
import { fetchTask } from "../clickup-task";
import { readAd, type AdReading } from "./ad";
import { checkFile, productsFromPosterName, similarity, type FileResult, type Issue } from "./compare";
import { chainFromTitle, pickFlyer, sortFiles, weekFromTitle, type InFile, type Sorted } from "./files";
import { FLYER_PROMPT_VERSION, readFlyer, type FlyerProduct, type FlyerReading } from "./flyer";
import { posterProducts, readManus, type Manus, type ManusPoster } from "./manus";
import { appliesTo, readClientFeedback, type ClientChange, type ClientFeedback } from "./feedback";

export type CheckReport = {
  taskId: string;
  title: string;
  url: string;
  chain: string | null;
  week: number | null;
  sheet: string | null;
  flyer: string | null;
  orderIssues: Issue[]; // card-level: missing manus/flyer/MVKs/posters
  files: FileResult[];
  status: "passed" | "warnings" | "failed" | "incomplete" | "skipped";
  clientChanges: ClientChange[]; // the client's feedback from the card comments, applied on top of the manus
  assigneeEmails: string[];
  tokens: { input: number; output: number };
  ms: number;
};

const MAX_ZIP_BYTES = 80 * 1024 * 1024; // skip huge asset dumps (e.g. 150 MB decoration packs)

function kv(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

/** Download the attachments the checker can use. ClickUp URLs are single-use, so fetch each once. */
async function downloadAttachments(task: any): Promise<InFile[]> {
  const wanted = (task.attachments || []).filter((a: any) => {
    const t = String(a.title || "");
    if (/\.(xlsx?|pdf|jpe?g|png|webp)$/i.test(t)) return true;
    if (/\.zip$/i.test(t)) return Number(a.size || 0) <= MAX_ZIP_BYTES;
    return false;
  });
  const out: InFile[] = [];
  // a few at a time to stay friendly with ClickUp
  for (let i = 0; i < wanted.length; i += 4) {
    const batch = wanted.slice(i, i + 4);
    const got = await Promise.all(
      batch.map(async (a: any) => {
        const res = await fetch(a.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Download failed for ${a.title}: ${res.status}`);
        return { name: String(a.title), data: new Uint8Array(await res.arrayBuffer()), date: Number(a.date || 0) };
      }),
    );
    out.push(...got);
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Flyer reading is the slowest/most expensive step — cache it per flyer + product list. */
async function readFlyerCached(flyer: Sorted, manus: Manus): Promise<FlyerReading> {
  const products = manus.bilder.flatMap((b) => b.products);
  const hash = createHash("sha1")
    .update(FLYER_PROMPT_VERSION)
    .update(flyer.data)
    .update(JSON.stringify(products.map((p) => p.raw)))
    .digest("hex");
  const cacheKey = `aicheck:flyer:${hash}`;
  const store = kv();
  if (store) {
    const hit = await store.get<FlyerReading>(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  const reading = await readFlyer(flyer.data, products);
  if (store) await store.set(cacheKey, reading, { ex: 60 * 60 * 24 * 21 }).catch(() => null);
  return reading;
}

type Effective = {
  expected: FlyerProduct[];
  manusHeadline: string | null;
  forbidHeadline: boolean;
  requiredTexts: Array<{ text: string; quote: string }>;
  forbiddenTexts: Array<{ text: string; product: string | null; quote: string }>;
  touched: Array<{ product: string; quote: string }>; // products changed by the client without exact values
};

const sameProduct = (p: FlyerProduct, name: string) =>
  similarity(p.heading || p.manusName, name) >= 0.5 || similarity(p.manusName, name) >= 0.5;

function clientProduct(name: string, c: ClientChange): FlyerProduct {
  return {
    manusName: name,
    manusPage: null,
    found: false,
    page: null,
    heading: name,
    price: c.price ?? "",
    memberPrice: false,
    klipp: false,
    limit: c.limit,
    info: c.info ?? "",
    note: "client feedback",
  };
}

/** Apply the client's changes (in order) to what one file is expected to show. */
function applyFeedback(base: { expected: FlyerProduct[]; headline: string | null }, changes: ClientChange[]): Effective {
  const e: Effective = { expected: [...base.expected], manusHeadline: base.headline, forbidHeadline: false, requiredTexts: [], forbiddenTexts: [], touched: [] };
  for (const c of changes) {
    switch (c.kind) {
      case "headline_set":
        if (c.text) {
          e.manusHeadline = c.text;
          e.forbidHeadline = false;
        }
        break;
      case "headline_remove":
        e.manusHeadline = null;
        e.forbidHeadline = true;
        break;
      case "text_add":
        if (c.text) e.requiredTexts.push({ text: c.text, quote: c.quote });
        break;
      case "text_remove":
        if (c.text) e.forbiddenTexts.push({ text: c.text, product: c.product, quote: c.quote });
        if (c.product) e.touched.push({ product: c.product, quote: c.quote });
        break;
      case "product_remove":
        if (c.product) e.expected = e.expected.filter((p) => !sameProduct(p, c.product!));
        break;
      case "product_add":
        if (c.newProduct) e.expected.push(clientProduct(c.newProduct, c));
        break;
      case "product_replace":
        if (c.product) e.expected = e.expected.filter((p) => !sameProduct(p, c.product!));
        if (c.newProduct) e.expected.push(clientProduct(c.newProduct, c));
        break;
      case "product_update": {
        const i = c.product ? e.expected.findIndex((p) => sameProduct(p, c.product!)) : -1;
        if (i < 0) break;
        const p = { ...e.expected[i] };
        if (c.newProduct) p.heading = c.newProduct;
        if (c.price) p.price = c.price;
        if (c.info) p.info = c.info;
        if (c.limit) p.limit = c.limit;
        e.expected[i] = p;
        // a change we can't express exactly (e.g. "take away 2 för") → don't fail the product on flyer values
        if (!c.price && !c.info && !c.limit && !c.newProduct) e.touched.push({ product: c.product!, quote: c.quote });
        break;
      }
    }
  }
  return e;
}

/** Issues on a product the client changed loosely become warnings that say why. */
function softenTouched(r: FileResult, touched: Effective["touched"]): FileResult {
  if (!touched.length) return r;
  r.issues = r.issues.map((i) => {
    if (!i.product || /client/i.test(i.message)) return i;
    const t = touched.find((x) => similarity(x.product, i.product!) >= 0.5);
    if (!t || i.severity !== "error") return i;
    return { ...i, severity: "warning", message: `${i.message} — the client changed this product (“${t.quote}”), check it against her comment` };
  });
  return r;
}

export async function runCheck(taskId: string): Promise<CheckReport> {
  const t0 = Date.now();
  const task = await fetchTask(taskId);
  const title = String(task.name || "");
  const week = weekFromTitle(title);
  const chain = chainFromTitle(title);
  const orderIssues: Issue[] = [];
  const tokens = { input: 0, output: 0 };
  const add = (u: { input_tokens: number; output_tokens: number }) => {
    tokens.input += u.input_tokens;
    tokens.output += u.output_tokens;
  };

  const assigneeEmails: string[] = (task.assignees || []).map((a: any) => String(a.email || "").toLowerCase()).filter(Boolean);
  const looksLikeManus = (task.attachments || []).some((a: any) => /manus/i.test(String(a.title || "")));
  if (!chain && !looksLikeManus) {
    // not a Coop order (e.g. another client's SoMe card) — nothing to check against
    return {
      taskId,
      title,
      url: task.url || `https://app.clickup.com/t/${taskId}`,
      chain,
      week,
      sheet: null,
      flyer: null,
      orderIssues: [],
      files: [],
      status: "skipped",
      clientChanges: [],
      assigneeEmails,
      tokens,
      ms: Date.now() - t0,
    };
  }

  const files = await sortFiles(await downloadAttachments(task));
  const manusFile = files.filter((f) => f.kind === "manus").sort((a, b) => b.date - a.date)[0];
  const flyerFile = week ? pickFlyer(files, week) : null;
  const mvks = files.filter((f) => f.kind === "mvk").sort((a, b) => a.mvk! - b.mvk!);
  const posters = files.filter((f) => f.kind === "poster");

  let manus: Manus | null = null;
  let sheet: string | null = null;
  if (!week) orderIssues.push({ severity: "error", message: "Couldn't read the week number from the card title" });
  if (!manusFile) orderIssues.push({ severity: "error", message: "No manus spreadsheet (Manus_Veckoboost_….xlsx) on the card" });
  else if (week) {
    const r = await readManus(manusFile.data, week, title);
    manus = r.manus;
    sheet = r.choice?.sheet ?? null;
    if (!manus) orderIssues.push({ severity: "error", message: `The manus has no sheet for week ${week}` });
    else if (r.choice && r.choice.candidates.length > 1 && r.choice.reason.startsWith("ambiguous"))
      orderIssues.push({
        severity: "warning",
        message: `Several manus sheets for week ${week} (${r.choice.candidates.join(", ")}) — used "${r.choice.sheet}"`,
      });
  }
  if (!flyerFile) {
    const others = files.filter((f) => f.kind === "flyer").map((f) => f.name);
    orderIssues.push({
      severity: "error",
      message: `No flyer (DR) for week ${week ?? "?"} on the card${others.length ? ` — found only: ${others.join(", ")}` : ""}. Prices can't be verified.`,
    });
  }

  // flyer → expected products in manus order
  let flyer: FlyerReading | null = null;
  const expectedFor = new Map<string, FlyerProduct>(); // manus raw → flyer product
  if (manus && flyerFile) {
    flyer = await readFlyerCached(flyerFile, manus);
    add(flyer.usage ?? { input_tokens: 0, output_tokens: 0 });
    const all = manus.bilder.flatMap((b) => b.products);
    all.forEach((p, i) => {
      const byOrder = flyer!.products[i];
      const fp =
        byOrder && similarity(byOrder.manusName, p.name) > 0.6
          ? byOrder
          : flyer!.products.find((x) => similarity(x.manusName, p.name) > 0.6) ?? byOrder;
      if (fp) expectedFor.set(p.raw, fp);
    });
  }
  const expectedOf = (raws: string[]): FlyerProduct[] =>
    raws.map(
      (raw) =>
        expectedFor.get(raw) ?? {
          manusName: raw,
          manusPage: null,
          found: false,
          page: null,
          heading: raw.replace(/\bs\s?\d+\b.*$/i, "").trim(),
          price: "",
          memberPrice: false,
          klipp: false,
          limit: null,
          info: "",
          note: "flyer not available",
        },
    );

  // completeness: every MVK in the manus has a file, and no unexpected ones
  if (manus) {
    const wantedMvk = manus.bilder.filter((b) => b.products.length || b.rubrik || b.notes.length).map((b) => b.index);
    const have = new Set(mvks.map((m) => m.mvk!));
    const missing = wantedMvk.filter((n) => !have.has(n));
    if (missing.length) orderIssues.push({ severity: "error", message: `MVK file missing: ${missing.map((n) => `MVK ${n}`).join(", ")}` });
    const extraMvk = mvks.filter((m) => !wantedMvk.includes(m.mvk!)).map((m) => `MVK ${m.mvk}`);
    if (extraMvk.length) orderIssues.push({ severity: "warning", message: `MVK not in the manus: ${extraMvk.join(", ")}` });
    if (manus.posters.length > posters.length)
      orderIssues.push({
        severity: "error",
        message: `Manus asks for ${manus.posters.length} poster(s) (70x100), ${posters.length} found on the card`,
      });
  }

  const headlineNeedsPeriod = !!manus?.rules.some((r) => /alltid punkt i rubrik/i.test(r));

  // the client's comments on the card win over the manus and the flyer
  let feedback: ClientFeedback = { comments: [], changes: [], usage: null };
  try {
    feedback = await readClientFeedback(taskId, assigneeEmails, manus);
    if (feedback.usage) add(feedback.usage);
  } catch (e: any) {
    orderIssues.push({ severity: "warning", message: `Couldn't read the client's comments on the card (${String(e?.message ?? e).slice(0, 120)}) — checked against the manus only` });
  }

  // read + compare every MVK
  const mvkResults = await pool(mvks, 4, async (f) => {
    const bild = manus?.bilder.find((b) => b.index === f.mvk);
    const reading = await readAd(f.data, { poster: false, fileName: f.name });
    add(reading.usage);
    const eff = applyFeedback(
      { expected: expectedOf((bild?.products ?? []).map((p) => p.raw)), headline: bild?.rubrik ?? null },
      feedback.changes.filter((c) => appliesTo(c, { mvk: f.mvk ?? null, poster: false })),
    );
    return softenTouched(
      checkFile({
        file: `MVK ${f.mvk}`,
        kind: "mvk",
        expected: eff.expected,
        reading,
        flyerValidity: flyer?.validity ?? null,
        manusHeadline: eff.manusHeadline,
        headlineNeedsPeriod: headlineNeedsPeriod && !!eff.manusHeadline,
        forbidHeadline: eff.forbidHeadline,
        requiredTexts: eff.requiredTexts,
        forbiddenTexts: eff.forbiddenTexts,
      }),
      eff.touched,
    );
  });

  // posters: read, then decide which poster spec from the manus each file is
  const posterReadings: Array<{ f: Sorted; reading: AdReading }> = await pool(posters, 2, async (f) => {
    const reading = await readAd(f.data, { poster: true, fileName: f.name });
    add(reading.usage);
    return { f, reading };
  });
  const specs: ManusPoster[] = manus?.posters ?? [];
  const usedSpecs = new Set<number>();
  const posterResults = posterReadings.map(({ f, reading }) => {
    let best = -1;
    let bestScore = -1;
    specs.forEach((s, i) => {
      if (usedSpecs.has(i) && specs.length > 1) return;
      const prods = posterProducts(manus!, s);
      const score = prods.filter((p) => reading.items.some((it) => similarity(it.name, p.name) > 0.5)).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best >= 0) usedSpecs.add(best);
    const raws = best >= 0 ? posterProducts(manus!, specs[best]).map((p) => p.raw) : [];
    const display = f.name.split("/").pop() || f.name;
    const eff = applyFeedback(
      { expected: expectedOf(raws), headline: null },
      feedback.changes.filter((c) => appliesTo(c, { mvk: null, poster: true }) && !/^headline_/.test(c.kind)),
    );
    const result = softenTouched(
      checkFile({
        file: display,
        kind: "poster",
        expected: eff.expected,
        reading,
        flyerValidity: flyer?.validity ?? null,
        manusHeadline: null,
        headlineNeedsPeriod: false,
        fileNameProducts: productsFromPosterName(display),
        // "add a bauble on MVK3" mustn't be required on the poster unless the change names the poster
        requiredTexts: eff.requiredTexts.filter((r) =>
          feedback.changes.some((c) => c.scope === "poster" && c.kind === "text_add" && c.text === r.text),
        ),
        forbiddenTexts: eff.forbiddenTexts,
      }),
      eff.touched,
    );
    if (best < 0) result.issues.unshift({ severity: "warning", message: "The manus doesn't ask for a poster — checked spelling and arithmetic only" });
    return result;
  });

  const all = [...orderIssues, ...mvkResults.flatMap((r) => r.issues), ...posterResults.flatMap((r) => r.issues)];
  const incomplete = !manus || !flyer;
  const status: CheckReport["status"] = all.some((i) => i.severity === "error")
    ? "failed"
    : incomplete
      ? "incomplete"
      : all.length
        ? "warnings"
        : "passed";

  return {
    taskId,
    title,
    url: task.url || `https://app.clickup.com/t/${taskId}`,
    chain,
    week,
    sheet,
    flyer: flyerFile?.name ?? null,
    orderIssues,
    files: [...mvkResults, ...posterResults],
    status,
    clientChanges: feedback.changes,
    assigneeEmails,
    tokens,
    ms: Date.now() - t0,
  };
}
