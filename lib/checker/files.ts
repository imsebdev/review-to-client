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
  flyerWeek?: number; // week number for kind "flyer"
};

const IMAGE = /\.(jpe?g|png|webp)$/i;

export function classify(name: string): { kind: Kind; mvk?: number; flyerWeek?: number } {
  const base = name.split("/").pop() || name;
  if (/manus.*\.xlsx?$/i.test(base)) return { kind: "manus" };
  const flyer = base.match(/^[a-z]{2}_(\d{2})(\d{2})_.*\.pdf$/i);
  if (flyer) return { kind: "flyer", flyerWeek: Number(flyer[2]) };
  if (!IMAGE.test(base)) return { kind: "other" };
  if (/frilagda/i.test(name)) return { kind: "cutout" };
  if (/70\s*x\s*100|skyl+t|poster/i.test(base)) return { kind: "poster" };
  const mvk = base.match(/mvk\s*[-_ ]?\s*(\d{1,2})/i);
  if (mvk) return { kind: "mvk", mvk: Number(mvk[1]) };
  return { kind: "other" };
}

/** Unpack zips and classify everything. Newer files win when the same name appears twice. */
export async function sortFiles(files: InFile[]): Promise<Sorted[]> {
  const out: Sorted[] = [];
  for (const f of files) {
    const date = f.date ?? 0;
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f.data);
      const entries = Object.values(zip.files).filter((e) => !e.dir && !/__MACOSX|\/\.|^\./.test(e.name));
      for (const e of entries) {
        const name = `${f.name}/${fixZipName(e.name)}`;
        out.push({ name, date, data: await e.async("uint8array"), ...classify(name) });
      }
    } else {
      out.push({ name: f.name, date, data: f.data, ...classify(f.name) });
    }
  }
  // de-duplicate: same MVK number or same poster file name → keep the newest
  const best = new Map<string, Sorted>();
  for (const s of out) {
    const key =
      s.kind === "mvk" ? `mvk:${s.mvk}` : s.kind === "poster" ? `poster:${baseName(s.name).toLowerCase()}` : `x:${s.name}`;
    const prev = best.get(key);
    if (!prev || s.date > prev.date || (s.date === prev.date && !s.name.includes(".zip/") && prev.name.includes(".zip/")))
      best.set(key, s);
  }
  return Array.from(best.values());
}

/** Pick the flyer for the order's week; cards sometimes carry a later week's flyer as inspiration. */
export function pickFlyer(files: Sorted[], week: number): Sorted | null {
  const flyers = files.filter((f) => f.kind === "flyer");
  return flyers.find((f) => f.flyerWeek === week) ?? null;
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
