// lib/checker/manus.ts
//
// Reads Coop's "Manus_Veckoboost_<chain>.xlsx" and turns one week's sheet into a plain
// structure the checker can compare against: which products go on which MVK ("Bild"),
// the headline per MVK, which MVKs (or "all products") need a 70x100 poster, and the
// free-text rules written on the sheet.
//
// The workbook layout (same for X:-TRA, Coop+ and Stora Coop):
//   - one sheet per week: "Vecka 48", sometimes split: "Vecka 47-Barn" / "Vecka 47 Medlem"
//   - a header row with "Bild 1:" … "Bild 10:" (Stora Coop may add "SKYLT 70x100")
//   - left label column: "Rubrik:" row, then "Vara:" row(s) — one product per cell, with
//     a page reference into the flyer ("Kaffe s1", "Blomkål s 5")
//   - under the products: notes per column; red "Tag fram en 70x100 skylt" = poster for that MVK
//   - footer: "Bakgrund:", "Rubrik:", "Övrigt:" with general instructions
//
import ExcelJS from "exceljs";

export type ManusProduct = {
  raw: string; // exactly as written in the cell
  name: string; // without the page reference
  page: number | null; // flyer page ("s5" -> 5), null if none given
};

export type ManusBild = {
  index: number; // 1-based MVK number
  rubrik: string | null;
  products: ManusProduct[];
  notes: string[]; // non-product text in the column (recipe links, speech bubbles, …)
  poster: boolean; // "Tag fram en 70x100 skylt" under this MVK
};

export type ManusPoster =
  | { kind: "per-bild"; bild: number } // poster shows the products of one MVK
  | { kind: "all"; note: string }; // one poster with every product on the sheet

export type Manus = {
  chain: string; // "X:-tra", "COOP +", "Stora Coop"
  week: number;
  sheet: string;
  theme: string | null; // "TEMA: JUL"
  bilder: ManusBild[];
  posters: ManusPoster[];
  rules: string[]; // footer + loose instructions (Bakgrund, Rubrik, Övrigt, format examples)
};

export type SheetChoice = { sheet: string; candidates: string[]; reason: string };

// ---------- small helpers ----------

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const o = v as any;
  if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join("").trim();
  if (o.text != null) return String(o.text).trim(); // hyperlink cells
  if (o.result != null) return String(o.result).trim(); // formula cells
  return "";
}

/** Merged cells repeat the master's value in every covered cell — read only the master. */
function isMergeCopy(cell: ExcelJS.Cell): boolean {
  return cell.isMerged && cell.master && cell.master.address !== cell.address;
}

function isRed(cell: ExcelJS.Cell): boolean {
  const argb = (cell.font?.color as any)?.argb as string | undefined;
  if (!argb) return false;
  const hex = argb.slice(-6).toUpperCase();
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r > 180 && g < 80 && b < 80;
}

const PAGE_REF = /\bs\s?\.?\s?(\d{1,2})\b/i; // "s1", "s 12", "s.5"
const BILD_HEADER = /^bild\s*(\d{1,2})\s*:?\s*$/i;
const POSTER_HEADER = /skylt|70\s*x\s*100/i;
const POSTER_NOTE = /(tag|ta)\s+fram\s+en.*(skylt|70\s*x\s*100)/i;
const FOOTER_LABEL = /^(bakgrund|rubrik|övrigt)\s*:/i;
const NOTE_HINT =
  /https?:|recept|pratbubbla|bild|lägg|tag |ta |skriv|obs|se |exempel|använd|gör |alltså|mellan klockan|står|rubrik|medlemsdag/i;

export function weekFromSheetName(name: string): number | null {
  const m = name.match(/vecka\s*0*(\d{1,2})|^v\.?\s*0*(\d{1,2})\b/i);
  if (!m) return null;
  return Number(m[1] ?? m[2]);
}

/** Split "Kaffe s 1" into name + page. Text with no page ref keeps page null. */
export function parseProduct(raw: string): ManusProduct {
  const text = raw.replace(/\s+/g, " ").trim();
  const m = text.match(PAGE_REF);
  if (!m || m.index == null) return { raw, name: text, page: null };
  const name = text.slice(0, m.index).replace(/[\s\-–,:]+$/, "").trim();
  return { raw, name: name || text, page: Number(m[1]) };
}

function looksLikeProduct(text: string): boolean {
  if (PAGE_REF.test(text)) return true;
  if (NOTE_HINT.test(text)) return false;
  return text.split(/\s+/).length <= 4 && text.length <= 40;
}

// ---------- sheet selection ----------

/**
 * Pick the sheet for a week. When a week has several sheets ("Vecka 47-Barn",
 * "Vecka 47 Medlem"), words from the ClickUp card title decide (Familj → Barn, Medlem…).
 */
export function chooseSheet(sheetNames: string[], week: number, cardTitle = ""): SheetChoice | null {
  const candidates = sheetNames.filter((s) => weekFromSheetName(s) === week);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { sheet: candidates[0], candidates, reason: "only sheet for the week" };

  const title = cardTitle.toLowerCase();
  const synonyms: Array<[RegExp, RegExp]> = [
    [/famil|barn/, /familj|barn/i],
    [/medlem/, /medlem/i],
    [/jul/, /jul/i],
  ];
  for (const [inTitle, inSheet] of synonyms) {
    if (inTitle.test(title)) {
      const hit = candidates.find((c) => inSheet.test(c));
      if (hit) return { sheet: hit, candidates, reason: `card title matches "${hit}"` };
    }
  }
  // Fall back to the plain "Vecka NN" sheet if there is one.
  const plain = candidates.find((c) => /^\s*vecka\s*\d+\s*$/i.test(c));
  return { sheet: plain ?? candidates[0], candidates, reason: "ambiguous — several sheets for this week" };
}

// ---------- main parser ----------

export async function loadWorkbook(data: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as any);
  return wb;
}

export function parseSheet(ws: ExcelJS.Worksheet): Manus {
  // 1) find the header row with "Bild N:" cells
  let headerRow = -1;
  const bildCols = new Map<number, number>(); // column -> bild index
  let posterCol = -1;
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (headerRow !== -1) return;
    const found = new Map<number, number>();
    row.eachCell((cell, c) => {
      const m = cellText(cell.value).match(BILD_HEADER);
      if (m) found.set(c, Number(m[1]));
    });
    if (found.size >= 2) {
      headerRow = r;
      found.forEach((v, k) => bildCols.set(k, v));
      row.eachCell((cell, c) => {
        if (!found.has(c) && POSTER_HEADER.test(cellText(cell.value))) posterCol = c;
      });
    }
  });
  if (headerRow === -1) throw new Error(`Sheet "${ws.name}": no "Bild 1:" header row found`);

  const firstBildCol = Math.min(...Array.from(bildCols.keys()));

  // 2) title block above the header: chain, week, theme
  let chain = "";
  let theme: string | null = null;
  for (let r = 1; r < headerRow; r++) {
    ws.getRow(r).eachCell((cell) => {
      const t = cellText(cell.value);
      if (!t) return;
      if (/^tema\s*:/i.test(t)) theme = t.replace(/^tema\s*:\s*/i, "").trim() || null;
      else if (!chain && !/veckoboost|vecka/i.test(t)) chain = t;
    });
  }

  // 3) walk the rows under the header
  const bilder = new Map<number, ManusBild>();
  bildCols.forEach((idx) =>
    bilder.set(idx, { index: idx, rubrik: null, products: [], notes: [], poster: false }),
  );
  const rules: string[] = [];
  let posterAllNote: string | null = null;
  let section: "none" | "rubrik" | "vara" | "link" | "footer" = "none";

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const label = cellText(row.getCell(1).value);
    if (/^rubrik\s*:/i.test(label)) section = "rubrik";
    else if (/^vara\s*:/i.test(label)) section = "vara";
    else if (/^länk/i.test(label)) section = "link";
    else if (/^förslag på rub/i.test(label)) break; // list of headline suggestions — not instructions

    // footer label sitting inside the Bild columns ("Bakgrund:" in column B, text in C)
    let footerHere = false;
    row.eachCell((cell, c) => {
      if (isMergeCopy(cell)) return;
      if (c >= firstBildCol && FOOTER_LABEL.test(cellText(cell.value))) {
        const value = cellText(row.getCell(c + 1).value);
        if (value) rules.push(`${cellText(cell.value)} ${value}`);
        footerHere = true;
      }
    });
    if (footerHere) {
      section = "footer";
      continue;
    }

    row.eachCell((cell, c) => {
      if (isMergeCopy(cell)) return;
      const text = cellText(cell.value);
      if (!text) return;

      if (c === posterCol) {
        if (POSTER_NOTE.test(text) || /alla varor/i.test(text)) posterAllNote = text;
        return;
      }
      const bildIdx = bildCols.get(c);
      if (bildIdx == null) {
        // label column or beyond the grid: loose instructions ("Skriv så här vid frukt och grönt:")
        if (c < firstBildCol && !/^(rubrik|vara|länk)/i.test(text) && section === "footer") rules.push(text);
        return;
      }
      const bild = bilders(bilder, bildIdx);

      if (POSTER_NOTE.test(text)) {
        bild.poster = true;
        return;
      }
      if (section === "rubrik") {
        bild.rubrik = bild.rubrik ? `${bild.rubrik} ${text}` : text;
      } else if (section === "vara") {
        if (looksLikeProduct(text) && !(isRed(cell) && NOTE_HINT.test(text))) bild.products.push(parseProduct(text));
        else bild.notes.push(text);
      } else if (section === "link") {
        bild.notes.push(text);
      } else if (section === "footer") {
        // free text below the grid but in the first Bild column = general instruction
        if (c === firstBildCol) rules.push(text);
        else bild.notes.push(text);
      }
    });

    // an empty band after the products ends the product block
    if (section === "vara" && rowIsEmpty(row) && r > headerRow + 3) section = "footer";
  }

  // Free text between the products and the footer in the first column is often general
  // ("Starta upp med lite julmanér…"). Move long notes from Bild 1 that aren't column-specific.
  const posters: ManusPoster[] = [];
  bilder.forEach((b) => b.poster && posters.push({ kind: "per-bild", bild: b.index }));
  if (posterAllNote) posters.push({ kind: "all", note: posterAllNote });

  const week = weekFromSheetName(ws.name) ?? -1;
  return {
    chain: chain || "?",
    week,
    sheet: ws.name,
    theme,
    bilder: Array.from(bilder.values()).sort((a, b) => a.index - b.index),
    posters,
    rules,
  };
}

function bilders(map: Map<number, ManusBild>, idx: number): ManusBild {
  return map.get(idx)!;
}

function rowIsEmpty(row: ExcelJS.Row): boolean {
  let empty = true;
  row.eachCell((cell) => {
    if (cellText(cell.value)) empty = false;
  });
  return empty;
}

/** Load a manus file and parse the sheet for `week` (card title helps pick between split sheets). */
export async function readManus(data: ArrayBuffer | Buffer, week: number, cardTitle = "") {
  const wb = await loadWorkbook(data);
  const names = wb.worksheets.map((w) => w.name);
  const choice = chooseSheet(names, week, cardTitle);
  if (!choice) return { manus: null, choice: null, sheets: names };
  const ws = wb.getWorksheet(choice.sheet)!;
  return { manus: parseSheet(ws), choice, sheets: names };
}

/** Every product a poster must show. */
export function posterProducts(manus: Manus, poster: ManusPoster): ManusProduct[] {
  if (poster.kind === "per-bild") return manus.bilder.find((b) => b.index === poster.bild)?.products ?? [];
  return manus.bilder.flatMap((b) => b.products);
}
