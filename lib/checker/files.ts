// lib/checker/files.ts
//
// Sort a ClickUp card's attachments into what the checker needs:
//   manus   — Manus_Veckoboost_<chain>.xlsx
//   flyer   — the "DR" PDF, e.g. cx_2648_mandag_grund_s1-8_godkand_Original.pdf (26 = year, 48 = week)
//   mvk     — xtra-coop-v48-mvk6.jpg, Stora-Coop_V48_1080x1080_MVK1.jpg, Coop_Närhandel_V47_…_MVK7.jpg
//   poster  — "… 70x100 …" / "Skylt" / "Skyllt"
//   cutout  — "Frilagda priser & info/<product>.png" (the team's crops from the flyer)
// Zips are opened and their contents sorted the same way.

import JSZip from "jszip";

export type InFile = { name: string; data: Uint8Array; date?: number };

export type Kind = "manus" | "flyer" | "mvk" | "poster" | "cutout" | "other";

export type Sorted = {
  name: string; // path inside a zip is kept: "zipname.zip/inner/file.jpg"
  kind: Kind;
  data: Uint8Array;
  date: number;
  mvk?: number; // MVK number for kind "mvk"
  format?: string; // "1080x1920" when the file name says so (story versions of an MVK)
  flyerWeek?: number; // week number for kind "flyer"
  zip?: string; // the zip it came from
  replaced?: { name: string; data: Uint8Array }; // an older/other copy of the same file (zip vs loose)
};

const IMAGE = /\.(jpe?g|png|webp)$/i;

export function classify(name: string): { kind: Kind; mvk?: number; flyerWeek?: number } {
  const base = name.split("/").pop() || name;
  if (/manus.*\.xlsx?$/i.test(base)) return { kind: "manus" };
  const flyer = base.match(/^[a-z]{2}_(\d{2})(\d{2})_.*\.pdf$/i);
  if (flyer) return { kind: "flyer", flyerWeek: Number(flyer[2]) };
  // print files of posters come as PDF ("… 70x100 - Skylt - Tryckfil.pdf")
  if (/\.pdf$/i.test(base) && /70\s*x\s*100|skyl+t|poster|tryck/i.test(name)) return { kind: "poster" };
  if (!IMAGE.test(base)) return { kind: "other" };
  if (/frilagda|priser\s*(&|och)\s*info|cut-?outs?/i.test(name)) return { kind: "cutout" };
  if (/70\s*x\s*100|skyl+t|poster/i.test(base)) return { kind: "poster" };
  const mvk = base.match(/mvk\s*[-_ ]?\s*(\d{1,2})/i);
  if (mvk) return { kind: "mvk", mvk: Number(mvk[1]) };
  return { kind: "other" };
}

async function unzip(name: string, data: Uint8Array, date: number, out: Sorted[], depth: number): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((e) => !e.dir && !/__MACOSX|(^|\/)\./.test(e.name));
  for (const e of entries) {
    const inner = `${name}/${fixZipName(e.name)}`;
    const bytes = await e.async("uint8array");
    if (/\.zip$/i.test(e.name) && depth < 2) await unzip(inner, bytes, date, out, depth + 1);
    else out.push({ name: inner, date, data: bytes, zip: name.split(".zip/")[0].replace(/\.zip$/i, "") + ".zip", ...classify(inner) });
  }
}

/** Unpack zips (also zips inside zips) and classify everything. Newer files win when the same file appears twice. */
export async function sortFiles(files: InFile[]): Promise<Sorted[]> {
  const out: Sorted[] = [];
  for (const f of files) {
    const date = f.date ?? 0;
    if (/\.zip$/i.test(f.name)) await unzip(f.name, f.data, date, out, 0);
    else out.push({ name: f.name, date, data: f.data, ...classify(f.name) });
  }
  for (const s of out) {
    const fmt = baseName(s.name).match(/(\d{3,4})\s*x\s*(\d{3,4})/);
    if (s.kind === "mvk" && fmt && fmt[1] !== fmt[2]) s.format = `${fmt[1]}x${fmt[2]}`;
  }
  // de-duplicate: same MVK (and format) or same poster → keep the newest, remember the other copy
  const best = new Map<string, Sorted>();
  for (const s of out) {
    const ext = (s.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase() === "pdf" ? "pdf" : "img";
    const key =
      s.kind === "mvk"
        ? `mvk:${s.mvk}:${s.format ?? ""}`
        : s.kind === "poster"
          ? `poster:${posterKey(baseName(s.name))}:${ext}`
          : `x:${s.name}`;
    const prev = best.get(key);
    const better = !prev || s.date > prev.date || (s.date === prev.date && !s.name.includes(".zip/") && prev.name.includes(".zip/"));
    if (better) {
      if (prev) s.replaced = { name: prev.name, data: prev.data };
      best.set(key, s);
    } else if (prev && !prev.replaced) prev.replaced = { name: s.name, data: s.data };
  }
  return Array.from(best.values());
}

/** One line per zip: what was found inside, so the team sees nothing was skipped. */
export function zipSummary(files: Sorted[], allNames: string[]): string[] {
  const zips = Array.from(new Set(allNames.filter((n) => n.includes(".zip/")).map((n) => n.split(".zip/")[0] + ".zip")));
  return zips.map((z) => {
    const inside = files.filter((f) => f.name.startsWith(z + "/"));
    const count = (k: string) => inside.filter((f) => f.kind === k).length;
    const parts = [
      count("mvk") && `${count("mvk")} MVK`,
      count("poster") && `${count("poster")} poster file(s)`,
      count("cutout") && `${count("cutout")} cut-outs`,
      count("other") && `${count("other")} other file(s)`,
    ].filter(Boolean);
    return `📦 ${z.split("/").pop()}: ${parts.join(", ") || "nothing the checker can read"}`;
  });
}

/** Pick the flyer for the order's week; cards sometimes carry a later week's flyer as inspiration. */
export function pickFlyer(files: Sorted[], week: number): Sorted | null {
  const flyers = files.filter((f) => f.kind === "flyer");
  return flyers.find((f) => f.flyerWeek === week) ?? null;
}

/** "X_-TRA - Jul Veckoboost 48 - Apelsiner & Röda äpplen- 70x100.jpg" and the same without "Jul" → same key */
function posterKey(n: string): string {
  const m = n.match(/\d{1,2}\s*-\s*(.+?)\s*-?\s*70\s*x\s*100/i);
  return (m ? m[1] : n).toLowerCase().replace(/[^a-zåäö0-9]+/g, "");
}

function baseName(n: string) {
  return n.split("/").pop() || n;
}

/** Windows zip tools write non-ASCII names as "#U00e5" — turn them back into "å". */
export function fixZipName(n: string): string {
  return n.replace(/#U([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Week number from a card title: "X:-TRA - V.48 - …", "Stora Coop V20 - …", "Veckoboost 45", "Vecka 18". */
export function weekFromTitle(title: string): number | null {
  const m = title.match(/\bV(?:ecka|\.)?\s*\.?\s*(\d{1,2})\b|veckoboost\s*(\d{1,2})/i);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Chain from a card title, used to choose rules. The first chain named wins ("Coop+ … like Stora Coop V.47"). */
export function chainFromTitle(title: string): "xtra" | "stora" | "coopplus" | "narhandel" | "coop" | null {
  const t = title.toLowerCase();
  const patterns: Array<["xtra" | "stora" | "coopplus" | "narhandel", RegExp]> = [
    ["xtra", /x\s*:?-?\s*tra/],
    ["stora", /stora coop/],
    ["coopplus", /coop\s*\+/],
    ["narhandel", /coop närhandel|närhandel/],
  ];
  let best: { chain: "xtra" | "stora" | "coopplus" | "narhandel"; at: number } | null = null;
  for (const [chain, re] of patterns) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { chain, at: m.index };
  }
  if (best) return best.chain;
  return /coop/.test(t) ? "coop" : null;
}
