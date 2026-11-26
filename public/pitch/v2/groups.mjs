// public/pitch/v2/groups.mjs
//
// The ONE place that decides how a card's files are sorted on the v2 review page.
// Loaded by the browser (/pitch/v2/groups.mjs) and, later, imported by /api/zip so the
// page and the zips always agree. Plain JS, no dependencies.
//
// Team routine: put a group word in the file name, e.g.
//   Stora-Coop_V48_MVK_1080x1080_01.jpg   Stora-Coop_V48_LABEL_Blomkal.png
//   Stora-Coop_V48_POSTER_70x100_PRINT.pdf
// To add a group: add one entry to GROUPS (order = order on the page).

/** Group words, in page order. `match` runs on the file name (case-insensitive).
 *  `folder`: folder name inside zips when the title has characters a folder can't (e.g. "/"). */
export const GROUPS = [
  { id: "MVK",      title: "MVK-annonser",    match: [word("mvk")] },
  { id: "CAROUSEL", title: "Karusell",        match: [word("carousel"), word("karusell")] },
  { id: "STORY",    title: "Stories",         match: [word("story"), word("stories")] },
  { id: "REEL",     title: "Reels",           match: [word("reel"), word("reels")] },
  { id: "BANNER",   title: "HTML5-banners",   match: [word("banner")] },
  { id: "BACKUP",   title: "Backup-bilder",   match: [word("backup")] },
  { id: "POSTER",   title: "Skylt / affisch", folder: "Skylt-affisch", match: [word("poster"), /skyl+t/i, /70\s*x\s*100/i] },
  { id: "PRINT",    title: "Tryckfiler",      match: [word("print"), /tryckfil/i] },
  { id: "FLYER",    title: "Flyer",           match: [word("flyer")] },
  { id: "TABLE",    title: "Bordsryttare",    match: [word("table")] },
  { id: "LABEL",    title: "Frilagda priser", match: [word("label"), /etikett/i, /frilagd/i] },
];

// Checked first when a name has two group words:
//   "…_BANNER_BACKUP_300x250.jpg" is a backup image, "…_POSTER_70x100_PRINT.pdf" is the print file.
const MATCH_FIRST = ["BACKUP", "PRINT"];
const MATCH_ORDER = [
  ...MATCH_FIRST.map((id) => GROUPS.find((g) => g.id === id)),
  ...GROUPS.filter((g) => !MATCH_FIRST.includes(g.id)),
];

export const OTHER = { id: "OTHER", title: "Övrigt" };      // some files grouped, these weren't
export const ALL_FILES = { id: "ALL", title: "Alla filer" }; // no file on the card has a group word

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tiff"];
const VIDEO_EXT = ["mp4", "mov", "webm", "m4v"];
const SHEET_EXT = ["xls", "xlsx", "xlsm", "csv", "numbers"];
const ARCHIVE_EXT = ["zip", "rar", "7z", "gz", "tar"];

// The Tally order's flyer ("DR" PDF), e.g. cx_2640_mandag_grund_s1-8_godkand_Original.pdf.
// Same rule as lib/checker/files.ts#classify.
const TALLY_FLYER = /^[a-z]{2}_\d{4}_.*\.pdf$/i;

/** Whole-word match that also works next to digits, _ - . and spaces ("mvk6", "_MVK_"). */
function word(w) {
  return new RegExp("(^|[^a-zåäö])" + w + "(?![a-zåäö])", "i");
}

/** Folder name for a group inside a zip: never contains "/" or "\\". */
export function folderName(g) {
  return (g.folder || g.title).replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim();
}

export function fileNameFromUrl(url) {
  try { return decodeURIComponent(String(url).split("?")[0].split("/").pop()); } catch (e) { return String(url); }
}

export function extOf(name) {
  const base = String(name).split("?")[0].split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** "image" | "video" | "file". No extension counts as an image, like the live page. */
export function kindOf(name) {
  const e = extOf(name);
  if (!e || IMAGE_EXT.includes(e)) return "image";
  if (VIDEO_EXT.includes(e)) return "video";
  return "file";
}

export function groupWordOf(name) {
  for (const g of MATCH_ORDER) if (g.match.some((re) => re.test(name))) return g.id;
  return null;
}

/** Why a file is never shown or offered to the client, or null if it is. */
export function hiddenReason(name) {
  const e = extOf(name);
  if (SHEET_EXT.includes(e)) return "sheet (order manus)";
  if (TALLY_FLYER.test(name)) return "Tally flyer (order input)";
  if (ARCHIVE_EXT.includes(e) && groupWordOf(name) !== "BANNER") return "archive (zips are built on click)";
  return null;
}

function trailingNumber(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const m = base.match(/(\d+)\D*$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Sort a card's file URLs into groups.
 * @param {string[]} urls  the comma-split `preview` field from Redis
 * @returns {{ groups: {id,title,folder,files}[], files: object[], hidden: {name,url,reason}[], ungrouped: string[] }}
 *   files: every visible file in page order, each { url, name, ext, kind, group }
 */
export function sortFiles(urls) {
  const hidden = [];
  const visible = [];
  for (const url of urls) {
    const name = fileNameFromUrl(url);
    const reason = hiddenReason(name);
    if (reason) { hidden.push({ name, url, reason }); continue; }
    visible.push({ url, name, ext: extOf(name), kind: kindOf(name), group: groupWordOf(name) });
  }

  const anyGrouped = visible.some((f) => f.group);
  for (const f of visible) if (!f.group) f.group = anyGrouped ? OTHER.id : ALL_FILES.id;

  const order = [...GROUPS, OTHER, ALL_FILES];
  const groups = [];
  for (const g of order) {
    const files = visible
      .filter((f) => f.group === g.id)
      .sort((a, b) => trailingNumber(a.name) - trailingNumber(b.name) || a.name.localeCompare(b.name, "sv"));
    if (files.length) groups.push({ id: g.id, title: g.title, folder: folderName(g), files });
  }

  return {
    groups,
    files: groups.flatMap((g) => g.files),
    hidden,
    ungrouped: anyGrouped ? visible.filter((f) => f.group === OTHER.id).map((f) => f.name) : [],
  };
}
