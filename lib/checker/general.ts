// lib/checker/general.ts
//
// Content check for every non-Coop card (SoMe, Display, GMP, carousels …).
// There is no manus/flyer, so the "truth" is assembled from the card itself:
//   card title + description + custom fields (copy fields are taken word for word)
//   + attachments uploaded with the brief + the client's comments (they win)
//   + the client's website and the source links on the card.
// Every finished file is then read and checked against that brief, plus spelling,
// brand name/URL, facts vs the website, sizes and consistency across the set.

import sharp from "sharp";
import JSZip from "jszip";
import { askJson, b64, type ContentBlock, type Usage } from "./anthropic";
import { similarity, type FileResult, type Issue } from "./compare";
import { allComments, pickClientComments } from "./feedback";
import { readSite, siteLinks, type SitePage } from "./website";
import { correctSourceTypos, fixTypos, sourceTypoWarning, typoIssues, type SourceTypo } from "./source-proofread";
import type { CheckReport } from "./run";

// ---------- attachments ----------

type Att = { name: string; date: number; size: number; url: string; ext: string };
type Got = Att & { data: Uint8Array };

const IMG = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(mp4|mov|webm|m4v|avi)$/i;
const REFERENCE_NAME = /brief|logo|guide|manual|profil|exempel|example|inspo|referens|reference|moodboard|underlag|material(?!.*spiderads)/i;
const OLD = /[-_ ](old|gammal|tidigare|backup)\b|\(old\)/i;
const BRIEF_WINDOW_MS = 15 * 60 * 1000; // files added within 15 min of the card = part of the order

/** The team's files vs the material that came with the order. */
export function splitAttachments(atts: Att[], created: number): { deliverables: Att[]; reference: Att[] } {
  const deliverables: Att[] = [];
  const reference: Att[] = [];
  for (const a of atts) {
    const early = a.date && created && a.date - created < BRIEF_WINDOW_MS;
    if (early || REFERENCE_NAME.test(a.name)) reference.push(a);
    else if (!OLD.test(a.name)) deliverables.push(a);
  }
  // the same file uploaded again (stealth update, "(1)", "_v2") → keep the newest
  const base = (n: string) =>
    n
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .replace(/\s*\(\d+\)$/, "")
      .replace(/[-_ ]v\d+$/, "")
      .replace(/[-_ ](final|fix|ny|new)$/, "")
      .trim();
  const newest = new Map<string, Att>();
  for (const d of deliverables) {
    const k = `${base(d.name)}|${d.ext}`;
    const cur = newest.get(k);
    if (!cur || d.date > cur.date) newest.set(k, d);
  }
  // pasted screenshots are all called "image.png" — never merge those
  const kept = deliverables.filter((d) => /^image\.(png|jpe?g)$/i.test(d.name) || newest.get(`${base(d.name)}|${d.ext}`) === d);
  return { deliverables: kept, reference };
}

async function download(a: Att): Promise<Got> {
  const res = await fetch(a.url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed for ${a.name}: ${res.status}`);
  return { ...a, data: new Uint8Array(await res.arrayBuffer()) };
}

// ---------- the brief ----------

// Card fields that are workflow, not content
const INTERNAL_FIELD = /review link|stealth|message to client|figma|requester|^name:?$|harvest|time|budget|invoice|status/i;

export type Brief = {
  language: string;
  brandName: string;
  brandSpellings: string[]; // how the client writes its own name
  urls: string[]; // URLs that may appear on the ads
  exactCopy: Array<{ label: string; text: string }>;
  requirements: Array<{ text: string; source: string }>;
  facts: Array<{ text: string; source: string }>;
  expectedAds: number | null;
  expectedFormats: string[];
  clientChanges: Array<{ quote: string; date: string }>;
  sourceTypos: SourceTypo[]; // typos in the client's own material
  summary: string;
};

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    language: { type: "string", description: "Language the ads should be in, e.g. Swedish, Finnish, Norwegian, English" },
    brandName: { type: "string" },
    brandSpellings: { type: "array", items: { type: "string" } },
    urls: { type: "array", items: { type: "string" } },
    exactCopy: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] },
    },
    requirements: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text", "source"] },
    },
    facts: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text", "source"] },
    },
    expectedAds: { type: ["integer", "null"] },
    expectedFormats: { type: "array", items: { type: "string" } },
    clientChanges: {
      type: "array",
      items: { type: "object", properties: { quote: { type: "string" }, date: { type: "string" } }, required: ["quote", "date"] },
    },
    sourceTypos: {
      type: "array",
      items: {
        type: "object",
        properties: { where: { type: "string" }, text: { type: "string" }, issue: { type: "string" }, suggestion: { type: "string" } },
        required: ["where", "text", "issue", "suggestion"],
      },
    },
    summary: { type: "string" },
  },
  required: ["language", "brandName", "brandSpellings", "urls", "exactCopy", "requirements", "facts", "expectedAds", "expectedFormats", "clientChanges", "sourceTypos", "summary"],
};

const BRIEF_SYSTEM = `You prepare a QA checklist for an ad agency. The agency makes ads (social media, display banners, Google Performance Max assets, carousels) for many clients, mostly in Swedish, Finnish, Norwegian or English.
From the order card, the client's comments, the attached reference material and the client's website, write down what the finished ads must get right.

- language: the language the ads must be written in (from the copy, the brief or the website).
- brandName / brandSpellings: the client's name exactly as the client writes it (website logo/title, card). Include accepted variants only if the client uses them.
- urls: web addresses that may appear on the ads (the client's domain, landing pages from the card).
- exactCopy: ONLY text the brief gives word for word to be used in the ads (quoted headlines, slogans, CTA text). Do not invent copy, do not include instructions.
- requirements: concrete, checkable things the ads must or must not do, taken ONLY from the card and the client's comments (offer, product, campaign name, number of ads, "Black Week", "show next free time", "no prices"…). Short, one per item. source = "brief" or "client comment". The website is never a source of requirements — terms, small print and campaign conditions on the site are facts, not things the ad must show.
- facts: facts from the website/source pages that ads might state and that can be verified: prices, discounts, opening hours, phone numbers, addresses, product names, campaign dates, what the service is. Short. source = the page URL.
- expectedAds: how many different ads/slides the order asks for, if it says (e.g. "3 ads in the carousel" → 3), else null.
- expectedFormats: formats asked for (e.g. "SoMe 1080x1080", "Display", "GMP").
- clientChanges: the client's change requests from the comments that still apply (later comments win), quoted briefly with the date. They override the brief.
- sourceTypos: clear spelling errors in the CLIENT'S OWN material that is meant to end up in the ads — copy fields, quoted copy in the description or comments, text in attached PDFs/briefs/images. Only clear errors (misspelled or run-together words, missing space after a full stop, doubled words). Not brand/product names, not numbers, not style. where = which field/file; text = the wrong part exactly as written; suggestion = the correction. Empty list if none.
- summary: 1–2 sentences: what is being advertised and to whom.
Never invent facts. If the website couldn't be read, rely on the card.`;

// ---------- reading one finished file ----------

type FileReading = {
  kind: "single_ad" | "presentation" | "other";
  ads: Array<{ label: string; texts: string[] }>;
  issues: Array<{ severity: "error" | "warning"; message: string; found: string | null; expected: string | null }>;
  unreadable: string[];
};

const FILE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["single_ad", "presentation", "other"] },
    ads: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, texts: { type: "array", items: { type: "string" } } },
        required: ["label", "texts"],
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["error", "warning"] },
          message: { type: "string" },
          found: { type: ["string", "null"] },
          expected: { type: ["string", "null"] },
        },
        required: ["severity", "message", "found", "expected"],
      },
    },
    unreadable: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "ads", "issues", "unreadable"],
};

const FILE_SYSTEM = `You proofread finished ads for an ad agency before they go to the client. You get the QA checklist (brief) and one file.
The file is either ONE ad (kind "single_ad"), or a presentation sheet / mockup that shows one or several ads, often inside a Facebook/Instagram/LinkedIn feed or on a website mockup (kind "presentation").

1. ads: list every ad you see (label like "Ad 1", "Slide 2", "300x250 banner") with ALL its text exactly as printed, one line per text block, no corrections.
   For feed mockups, also list the post text above/below the ad as a separate entry labelled "Post text". Ignore the platform's own interface (Sponsored, Like, Share, page name, time stamps, browser chrome, the platform's own buttons like "Varaa nyt"/"Learn more").
   Sheets often show ALTERNATIVE designs side by side ("Alt. 1", "Grafik alt. 2", "Alternativ 3"): those are options for the client, not slides — label them that way; they may differ in design and wording.
2. issues — report ONLY real problems, each with the exact text found and what it should be:
   - spelling, grammar, wrong word, missing/doubled spaces, wrong punctuation in the ad's language (error if clearly wrong, warning if debatable or a style matter)
   - the client's name spelled differently from the brief in TEXT (error); a wrong or misspelled URL (error). Logos and wordmarks are graphics — never report a logo as a spelling error (a symbol next to the name is not a letter).
   - copy that should be word for word (exactCopy) but is written differently on this file (error). Don't report exactCopy as missing — that's checked across all files separately.
   - a requirement or client change not followed (error), or only partly (warning)
   - a fact ON THE AD that contradicts the brief/website: price, date, phone, opening hours, offer (error). If the ad states a fact you simply can't find in the brief/website, that's a warning ("couldn't verify"), not an error. Never require website small print (dates, terms, "while stocks last") to be on the ad unless the brief asks for it.
   - placeholder or leftover text: lorem ipsum, "Rubrik här", "XX:-", another company's name or offer, wrong campaign, or words that belong to a different kind of business than this client (e.g. "book a car service" on a barber ad — typical when a template from another client was reused) (error)
   - text that is cut off, covered, overlapping or too small/low-contrast to read (warning)
   - mixed languages where it isn't intended (warning)
   - for 9:16 stories/reels: important text in the top ~14% or bottom ~20% (covered by the app UI) (warning)
   Do NOT comment on design taste, colours, layout choices or image selection unless the brief/client asked for something specific.
   If the ad repeats a typo listed in the checklist's sourceTypos (the client's own material), report it as an error: we correct the client's typos in the ads.
   Do not repeat the same problem twice. If everything is fine: empty list.
3. unreadable: text you can't read reliably. Never guess numbers.
Write messages in English, quote the ad's text in its original language.`;

async function jpeg(img: sharp.Sharp, maxSide: number): Promise<string> {
  const buf = await img.resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
  return b64(buf);
}

const imgBlock = (d: string): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });

/** Big sheets: overview + 4 overlapping tiles so small text stays readable. */
async function imageBlocks(data: Uint8Array): Promise<{ blocks: ContentBlock[]; width: number; height: number }> {
  const base = sharp(Buffer.from(data), { animated: false }).rotate();
  const meta = await base.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (Math.max(W, H) <= 2000) return { blocks: [imgBlock(await jpeg(base.clone(), 1568))], width: W, height: H };
  const blocks: ContentBlock[] = [{ type: "text", text: "Overview of the whole file:" }, imgBlock(await jpeg(base.clone(), 1568))];
  const ov = 0.12;
  const tw = Math.round(W * (0.5 + ov / 2));
  const th = Math.round(H * (0.5 + ov / 2));
  for (const [label, left, top] of [
    ["top left", 0, 0],
    ["top right", W - tw, 0],
    ["bottom left", 0, H - th],
    ["bottom right", W - tw, H - th],
  ] as Array<[string, number, number]>) {
    blocks.push({ type: "text", text: `Detail, ${label} part (overlaps its neighbours):` });
    blocks.push(imgBlock(await jpeg(base.clone().extract({ left, top, width: tw, height: th }), 1568)));
  }
  return { blocks, width: W, height: H };
}

function briefText(b: Brief): string {
  return `QA CHECKLIST (brief)\n${JSON.stringify(b, null, 1)}`;
}

async function readFile(brief: Brief, name: string, blocks: ContentBlock[], extra: string): Promise<{ r: FileReading; usage: Usage }> {
  const { data, usage } = await askJson<FileReading>({
    system: FILE_SYSTEM,
    content: [{ type: "text", text: briefText(brief) }, ...blocks, { type: "text", text: `File name: ${name}${extra ? `\n${extra}` : ""}` }],
    toolName: "ad_check",
    toolDescription: "Text on the file and the real problems found.",
    schema: FILE_SCHEMA,
    maxTokens: 6000,
  });
  return { r: { kind: data.kind ?? "other", ads: data.ads ?? [], issues: data.issues ?? [], unreadable: data.unreadable ?? [] }, usage };
}

// ---------- HTML5 banners ----------

async function html5Text(zipData: Uint8Array): Promise<{ text: string; sizes: string[]; clickTag: boolean; files: number }> {
  const zip = await JSZip.loadAsync(zipData);
  const htmls = Object.values(zip.files).filter((f) => !f.dir && /\.html?$/i.test(f.name) && !/__MACOSX/.test(f.name));
  const texts: string[] = [];
  const sizes: string[] = [];
  let clickTag = false;
  for (const f of htmls.slice(0, 20)) {
    const html = await f.async("string");
    const size = html.match(/name=["']ad\.size["'][^>]*content=["']width=(\d+),\s*height=(\d+)/i);
    if (size) sizes.push(`${size[1]}x${size[2]}`);
    if (/clicktag/i.test(html)) clickTag = true;
    const visible = html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /[a-zåäöæø]{2}/i.test(l));
    const strings = Array.from(html.matchAll(/(["'`])((?:(?!\1)[^\\\n]){4,160})\1/g))
      .map((m) => m[2])
      .filter((s) => /\s/.test(s) && /[a-zåäöæø]{3}/i.test(s) && !/[{};=<>]|https?:|\.(js|css|png|jpe?g|svg)\b/.test(s));
    texts.push(`--- ${f.name}\n${Array.from(new Set([...visible, ...strings])).join("\n")}`);
  }
  return { text: texts.join("\n").slice(0, 12000), sizes, clickTag, files: htmls.length };
}

// ---------- the whole set ----------

const SET_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["error", "warning"] },
          message: { type: "string" },
          found: { type: ["string", "null"] },
          expected: { type: ["string", "null"] },
        },
        required: ["severity", "message", "found", "expected"],
      },
    },
  },
  required: ["issues"],
};

const SET_SYSTEM = `You check a whole delivery of ads (all files of one order) against its brief. The individual files were already checked; their findings are listed — do NOT repeat any of them, not even reworded.
Alternative designs ("Alt. 1/2/3") are options for the client: they may differ in design and wording; only flag them if a FACT differs (price, date, phone, brand spelling, URL).
Report only problems across the set that the per-file findings don't already cover:
- the same thing written differently between ads/sizes (price, date, CTA, headline, brand name, URL) when it should be the same (error if a fact differs, warning for wording)
- the number of ads/slides doesn't match what the brief asks for (error), formats the brief asks for that are missing (warning)
- a requirement or client change from the brief that no file fulfils (error)
Each with the exact text found and what it should be. Messages in English. If everything is fine: empty list.`;

// ---------- sizes ----------

const STANDARD = new Set(
  [
    "1080x1080", "1080x1350", "1080x1920", "1200x628", "1200x1200", "1080x566", "1200x1500", "1200x300", "960x1200", "1920x1080",
    "300x250", "300x600", "320x320", "320x480", "320x50", "320x100", "728x90", "160x600", "980x240", "980x120", "980x300",
    "250x250", "970x250", "468x60", "640x640", "640x320", "336x280", "120x600", "1080x1440", "1440x1440",
  ].flatMap((s) => {
    const [w, h] = s.split("x").map(Number);
    return [s, `${w * 2}x${h * 2}`];
  }),
);

// ---------- run ----------

export async function runGeneralCheck(task: any, taskId: string, assigneeEmails: string[], t0: number): Promise<CheckReport> {
  const title = String(task.name || "");
  const tokens = { input: 0, output: 0 };
  const add = (u: Usage | null | undefined) => {
    if (!u) return;
    tokens.input += u.input_tokens;
    tokens.output += u.output_tokens;
  };
  const orderIssues: Issue[] = [];
  const created = Number(task.date_created || 0);

  const atts: Att[] = (task.attachments || []).map((a: any) => {
    const name = String(a.title || "");
    return { name, date: Number(a.date || 0), size: Number(a.size || 0), url: String(a.url || ""), ext: (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase() };
  });
  const { deliverables, reference } = splitAttachments(atts, created);
  const images = deliverables.filter((d) => IMG.test(d.name) && d.size <= 40 * 1024 * 1024);
  const zips = deliverables.filter((d) => /\.zip$/i.test(d.name) && d.size <= 60 * 1024 * 1024);
  const pdfs = deliverables.filter((d) => /\.pdf$/i.test(d.name) && d.size <= 20 * 1024 * 1024);
  const videos = deliverables.filter((d) => VIDEO.test(d.name));

  const base = {
    taskId,
    title,
    url: task.url || `https://app.clickup.com/t/${taskId}`,
    chain: null,
    week: null,
    flyer: null,
    clientChanges: [],
    assigneeEmails,
  };

  if (!images.length && !zips.length && !pdfs.length && !videos.length) {
    return {
      ...base,
      mode: "general",
      sheet: null,
      sources: [],
      orderIssues: [
        {
          severity: "error",
          message:
            "No finished files on the card yet — upload the ads (JPG/PNG, PDF or HTML5 zip) before moving it to internal review. Files added in the first 15 minutes count as the client's material.",
        },
      ],
      files: [],
      status: "incomplete",
      tokens,
      ms: Date.now() - t0,
    };
  }

  // --- brief inputs
  const fields: Array<{ name: string; value: string }> = (task.custom_fields || [])
    .map((f: any) => ({ name: String(f.name || "").replace(/:\s*$/, ""), value: typeof f.value === "string" ? f.value.trim() : "" }))
    .filter((f: { name: string; value: string }) => f.value && !INTERNAL_FIELD.test(f.name));
  const description = String(task.markdown_description || task.text_content || task.description || "").trim();

  const raw = await allComments(taskId).catch(() => []);
  const comments = pickClientComments(raw, assigneeEmails);

  const companyUrl = fields.find((f) => /company url|website|hemsida/i.test(f.name))?.value ?? "";
  const links = siteLinks([companyUrl, ...fields.filter((f) => /source|link|landing/i.test(f.name)).map((f) => f.value), description]).slice(0, 4);
  const pages: SitePage[] = await Promise.all(links.map((u) => readSite(u)));
  const sources = ["card", ...(comments.length ? [`${comments.length} client comment(s)`] : []), ...pages.filter((p) => !p.error).map((p) => p.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))];
  for (const p of pages.filter((p) => p.error))
    orderIssues.push({ severity: "warning", message: `Couldn't read ${p.url} (${p.error}) — facts on the ads weren't checked against it` });

  // reference images/PDFs the client attached (first few)
  const refBlocks: ContentBlock[] = [];
  for (const r of reference.filter((r) => IMG.test(r.name) && r.size <= 15 * 1024 * 1024).slice(0, 4)) {
    try {
      const g = await download(r);
      refBlocks.push({ type: "text", text: `Reference attached with the order: ${r.name}` }, imgBlock(await jpeg(sharp(Buffer.from(g.data)).rotate(), 1024)));
    } catch {}
  }
  for (const r of reference.filter((r) => /\.pdf$/i.test(r.name) && r.size <= 8 * 1024 * 1024).slice(0, 2)) {
    try {
      const g = await download(r);
      refBlocks.push({ type: "text", text: `Reference PDF attached with the order: ${r.name}` }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(g.data) } });
    } catch {}
  }

  const day = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "?");
  const cardText = [
    `CARD TITLE: ${title}`,
    `DESCRIPTION:\n${description || "(empty)"}`,
    `FIELDS:\n${fields.map((f) => `- ${f.name}: ${f.value}`).join("\n") || "(none)"}`,
    `CLIENT COMMENTS (oldest first, they override the brief):\n${comments.map((c) => `${day(c.date)}${c.decision ? ` [${c.decision}]` : ""}${c.files.length ? ` (file: ${c.files.join(", ")})` : ""}: ${c.text}`).join("\n") || "(none)"}`,
    ...pages.map((p) => (p.error ? `WEBSITE ${p.url}: could not be read (${p.error})` : `WEBSITE ${p.url} — "${p.title}"\n${p.text}`)),
  ].join("\n\n");

  const { data: briefData, usage: bu } = await askJson<Brief>({
    system: BRIEF_SYSTEM,
    content: [{ type: "text", text: cardText }, ...refBlocks],
    toolName: "qa_checklist",
    toolDescription: "What the finished ads must get right.",
    schema: BRIEF_SCHEMA,
    maxTokens: 4000,
  });
  add(bu);
  const brief: Brief = { ...briefData };
  // copy fields on the card are used word for word — take them as typed, not as Claude retold them
  const copyFields = fields.filter((f) => /copy|text|rubrik|headline|cta|knapp|button/i.test(f.name));
  brief.exactCopy = [
    ...copyFields.map((f) => ({ label: f.name, text: f.value })),
    ...(brief.exactCopy || []).filter((c) => !copyFields.some((f) => similarity(f.value, c.text) > 0.8)),
  ];

  brief.sourceTypos = (brief.sourceTypos || []).filter((t) => t.text && t.suggestion && t.text.trim() !== t.suggestion.trim());
  const contact = fields.find((f) => /^name$/i.test(f.name))?.value?.split(/\s+/)[0] ?? null;
  for (const t of brief.sourceTypos) orderIssues.push(sourceTypoWarning(t, "The client's material", contact));
  // copy fields are used word for word — but with the client's typos corrected
  brief.exactCopy = brief.exactCopy.map((c) => ({ ...c, text: fixTypos(c.text, brief.sourceTypos) }));

  // --- read every file
  const files: FileResult[] = [];
  const allTexts: string[] = [];
  const perFileTexts: string[] = [];
  const findingsText = () =>
    files
      .flatMap((f) => f.issues.map((i) => `- ${f.file}: ${i.message}${i.found ? ` (found: ${i.found})` : ""}`))
      .join("\n") || "(none)";

  const imageResults = await pool(images, 3, async (a) => {
    const g = await download(a);
    const { blocks, width, height } = await imageBlocks(g.data);
    const { r, usage } = await readFile(brief, a.name, blocks, `Pixel size: ${width}x${height}`);
    add(usage);
    return { a, r, width, height };
  });
  for (const { a, r, width, height } of imageResults) {
    const size = `${width}x${height}`;
    const issues: Issue[] = r.issues.map((i) => ({ severity: i.severity, message: i.message, found: i.found ?? undefined, expected: i.expected ?? undefined }));
    if (r.kind === "single_ad" && !STANDARD.has(size))
      issues.push({ severity: "warning", message: `Unusual ad size ${size} — check the format the client asked for` });
    for (const u of r.unreadable) issues.push({ severity: "warning", message: "Couldn't read reliably — check by eye", found: u });
    const texts = r.ads.flatMap((ad) => ad.texts);
    allTexts.push(...texts);
    perFileTexts.push(`### ${a.name} (${size}, ${r.kind}, ${r.ads.length} ad(s))\n${r.ads.map((ad) => `[${ad.label}] ${ad.texts.join(" | ")}`).join("\n")}`);
    files.push({ file: a.name, kind: "creative", detail: `${size}${r.kind === "presentation" ? `, ${r.ads.length} ad(s)` : ""}`, expectedCount: 0, foundCount: r.ads.length, matchedCount: 0, issues: dedupe(issues) });
  }

  for (const a of pdfs) {
    const g = await download(a);
    const { r, usage } = await readFile(brief, a.name, [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(g.data) } }], "This is a PDF delivery (presentation or print file).");
    add(usage);
    const texts = r.ads.flatMap((ad) => ad.texts);
    allTexts.push(...texts);
    perFileTexts.push(`### ${a.name} (PDF, ${r.ads.length} ad(s))\n${r.ads.map((ad) => `[${ad.label}] ${ad.texts.join(" | ")}`).join("\n")}`);
    const issues: Issue[] = r.issues.map((i) => ({ severity: i.severity, message: i.message, found: i.found ?? undefined, expected: i.expected ?? undefined }));
    for (const u of r.unreadable) issues.push({ severity: "warning", message: "Couldn't read reliably — check by eye", found: u });
    files.push({ file: a.name, kind: "creative", detail: `PDF, ${r.ads.length} ad(s)`, expectedCount: 0, foundCount: r.ads.length, matchedCount: 0, issues: dedupe(issues) });
  }

  for (const a of zips) {
    const g = await download(a);
    const h = await html5Text(g.data).catch(() => null);
    if (!h || !h.files) continue; // a zip of images/source files, not HTML5 banners
    const { r, usage } = await readFile(
      brief,
      a.name,
      [{ type: "text", text: `HTML5 BANNER SOURCE — the visible text and text strings from ${h.files} HTML file(s). You can't see the animation; check the text only.\n${h.text}` }],
      `Banner sizes declared in ad.size: ${h.sizes.join(", ") || "none"}`,
    );
    add(usage);
    const issues: Issue[] = r.issues.filter((i) => !/cut off|covered|overlap|contrast|too small|safe/i.test(i.message)).map((i) => ({ severity: i.severity, message: i.message, found: i.found ?? undefined, expected: i.expected ?? undefined }));
    if (!h.clickTag) issues.push({ severity: "warning", message: "No clickTag found in the HTML — the banner may not be clickable in the ad server" });
    const missingSize = h.files - h.sizes.length;
    if (missingSize > 0) issues.push({ severity: "warning", message: `${missingSize} HTML file(s) without an ad.size meta tag` });
    allTexts.push(...r.ads.flatMap((ad) => ad.texts));
    perFileTexts.push(`### ${a.name} (HTML5, sizes ${h.sizes.join(", ") || "?"})\n${r.ads.map((ad) => `[${ad.label}] ${ad.texts.join(" | ")}`).join("\n")}`);
    files.push({ file: a.name, kind: "html5", detail: `HTML5 ${h.sizes.join(", ") || ""} — text only, animation not checked`.trim(), expectedCount: 0, foundCount: h.files, matchedCount: 0, issues: dedupe(issues) });
  }

  for (const v of videos)
    files.push({ file: v.name, kind: "video", detail: "video — not checked automatically, watch it through", expectedCount: 0, foundCount: 0, matchedCount: 0, issues: [] });

  // --- copy from the card must appear word for word somewhere in the delivery
  for (const c of brief.exactCopy) {
    const want = c.text.trim();
    if (!want) continue;
    const k = flat(want);
    const exact = allTexts.some((t) => flat(t).includes(k)) || flat(allTexts.join(" ")).includes(k);
    if (exact) continue;
    const near = bestNear(want, allTexts);
    if (near && near.score >= 0.7)
      orderIssues.push({ severity: "error", message: `"${c.label}" differs from the brief`, expected: want, found: near.text });
    else
      orderIssues.push({
        severity: "warning",
        message: `"${c.label}" from the card isn't on any file — fine if it's only used as the post text in the ad manager`,
        expected: want,
      });
  }

  // --- the delivery as a whole
  if (perFileTexts.length) {
    const { data: set, usage: su } = await askJson<{ issues: FileReading["issues"] }>({
      system: SET_SYSTEM,
      content: [
        {
          type: "text",
          text: `${briefText(brief)}\n\nFILES AND THEIR TEXT\n${perFileTexts.join("\n\n")}${videos.length ? `\n\n(+ ${videos.length} video file(s), not read)` : ""}\n\nALREADY REPORTED PER FILE (don't repeat)\n${findingsText()}\n${orderIssues.map((i) => `- ${i.message}`).join("\n")}`,
        },
      ],
      toolName: "set_check",
      toolDescription: "Problems across the whole delivery.",
      schema: SET_SCHEMA,
      maxTokens: 2500,
    });
    add(su);
    for (const i of set.issues || []) orderIssues.push({ severity: i.severity, message: i.message, found: i.found ?? undefined, expected: i.expected ?? undefined });
  }

  for (const f of files) f.issues = correctSourceTypos(f.issues, brief.sourceTypos, "the client's material");
  if (brief.sourceTypos.length) {
    // an ad that copied the client's typo word for word: scan each file's text lines
    for (const f of files) {
      const block = perFileTexts.find((p) => p.startsWith(`### ${f.file} `)) ?? "";
      const lines = block.split("\n").flatMap((l) => l.split(" | "));
      for (const t of typoIssues(lines, brief.sourceTypos, "the client's material"))
        if (!f.issues.some((i) => i.message === t.message)) f.issues.push(t);
    }
  }

  orderIssues.splice(0, orderIssues.length, ...correctSourceTypos(orderIssues, brief.sourceTypos, "the client's material"));

  const all = [...orderIssues, ...files.flatMap((f) => f.issues)];
  const status: CheckReport["status"] = all.some((i) => i.severity === "error") ? "failed" : all.length || videos.length ? "warnings" : "passed";

  return {
    ...base,
    mode: "general",
    sheet: null,
    sources,
    clientChanges: [],
    briefChanges: brief.clientChanges,
    orderIssues: dedupe(orderIssues),
    files,
    status,
    tokens,
    ms: Date.now() - t0,
  };
}

// ---------- helpers ----------

function flat(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}'%:.,!?-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bestNear(want: string, texts: string[]): { text: string; score: number } | null {
  let best: { text: string; score: number } | null = null;
  const words = want.split(/\s+/).length;
  for (const t of texts) {
    // compare against windows of similar length so a long text block doesn't hide a match
    const parts = t.split(/\s+/);
    for (let i = 0; i <= Math.max(0, parts.length - words); i++) {
      const w = parts.slice(i, i + words + 1).join(" ");
      const score = similarity(w, want);
      if (!best || score > best.score) best = { text: w, score };
    }
  }
  return best;
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.message}|${i.found ?? ""}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
