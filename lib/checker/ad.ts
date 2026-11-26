// lib/checker/ad.ts
//
// Reads one finished MVK or poster image and returns every text element per product,
// plus headline, validity dates and any spelling/spacing issues. Posters are large, so
// they are sent as an overview plus four overlapping tiles in the same request.

import sharp from "sharp";
import { askJson, b64, type ContentBlock, type Usage } from "./anthropic";

export type AdItem = {
  name: string; // product heading as printed
  photoShows: string; // short description of the product photo next to it
  labelMatchesPhoto: boolean;
  price: string; // "2 för 49:-", "49:90/kg"
  memberPrice: boolean;
  klipp: boolean;
  limit: string | null; // "MAX 1 KÖP/HUSHÅLL."
  info: string; // info line(s) as printed
  splashes: string[]; // other badges near the product: "1 KG", "Du sparar 5:60", "500 G"
};

export type AdReading = {
  headline: string | null;
  validity: string | null; // "23/11–29/11" from "Aktuella priser 23/11–29/11"
  otherText: string[]; // remaining text (logo lines, slogans, speech bubbles)
  items: AdItem[];
  textIssues: Array<{ text: string; issue: string; suggestion: string }>;
  unreadable: string[]; // anything it could not read reliably
  usage: Usage;
};

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: ["string", "null"] },
    validity: { type: ["string", "null"] },
    otherText: { type: "array", items: { type: "string" } },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          photoShows: { type: "string" },
          labelMatchesPhoto: { type: "boolean" },
          price: { type: "string" },
          memberPrice: { type: "boolean" },
          klipp: { type: "boolean" },
          limit: { type: ["string", "null"] },
          info: { type: "string" },
          splashes: { type: "array", items: { type: "string" } },
        },
        required: ["name", "photoShows", "labelMatchesPhoto", "price", "memberPrice", "klipp", "limit", "info", "splashes"],
      },
    },
    textIssues: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, issue: { type: "string" }, suggestion: { type: "string" } },
        required: ["text", "issue", "suggestion"],
      },
    },
    unreadable: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "validity", "otherText", "items", "textIssues", "unreadable"],
};

const SYSTEM = `Du korrekturläser färdiga svenska butiksannonser (Coop, X:-TRA, Stora Coop) för Meta och 70x100-skyltar.
Skriv av exakt vad som står i bilden – rätta ingenting i avskriften.
- "headline" = annonsens rubrik (t.ex. "Färska fynd."). Märket "Aktuella priser 16/11–22/11", logotyper och
  slogans är INTE rubrik; finns ingen rubrik: null. Datumen i "Aktuella priser" går till "validity".
  Har annonsen flera stora rubrikliknande texter (t.ex. "Kanelbullens dag 4/10!", "12-PACK", "Helgerbjudande torsdag–söndag"),
  välj den mest framträdande som "headline" och lägg ALLA de andra i "otherText", ordagrant.
- En post i "items" per produkt (produktnamn + pris + info). Hör två produkter ihop med ett gemensamt pris, en post.
- "price" som tryckt med kolon för ören: 19⁹⁰ → "19:90", "2 för 49:-", "/kg" eller "/st" om det står.
- "info" = textraden/raderna under produktnamnet, sammanfogade med ett mellanslag.
- "photoShows": vad produktbilden bredvid texten faktiskt visar (t.ex. "hel kyckling i Guldfågeln-påse").
  labelMatchesPhoto=false om produktnamnet/texten uppenbart inte hör till bilden (t.ex. texten säger Clementiner men bilden visar kyckling).
- "splashes": övriga märken vid produkten, t.ex. "1 KG", "500 G", "Du sparar 5:60", "Du sparar minst 16:80".
- "textIssues": ENDAST verkliga fel i svensk text: felstavning, saknat mellanslag efter punkt/komma ("Touch.Gäller", "a,b"),
  dubbla mellanslag, produktnamn med liten begynnelsebokstav när övriga har stor, felaktig versalisering. Inte stilval, inte varumärken.
  Kommentera aldrig bildinnehållet, priser eller räknefel här – bara stavning/skiljetecken/mellanslag/versaler i texten.
  Om du inte hittar några sådana fel: tom lista.
- "unreadable": annonsens egen text (pris, produktnamn, info, rubrik) som du inte kan läsa säkert. Gissa aldrig siffror.
  Text på förpackningarna i produktbilderna räknas inte – den ska varken skrivas av eller rapporteras.`;

async function jpeg(img: sharp.Sharp, maxSide: number): Promise<string> {
  const buf = await img
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return b64(buf);
}

/** Images to send: MVKs as one picture; large posters as overview + 4 overlapping tiles. */
async function imageBlocks(data: Uint8Array, poster: boolean): Promise<ContentBlock[]> {
  const base = sharp(Buffer.from(data)).rotate();
  const meta = await base.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  const img = (d: string): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });

  if (!poster || Math.max(W, H) <= 1600) return [img(await jpeg(base.clone(), 1568))];

  const blocks: ContentBlock[] = [{ type: "text", text: "Översikt av hela skylten:" }, img(await jpeg(base.clone(), 1568))];
  const ov = 0.12; // overlap so no text line is cut in every tile
  const tw = Math.round(W * (0.5 + ov / 2));
  const th = Math.round(H * (0.5 + ov / 2));
  const tiles: Array<[string, number, number]> = [
    ["övre vänstra", 0, 0],
    ["övre högra", W - tw, 0],
    ["nedre vänstra", 0, H - th],
    ["nedre högra", W - tw, H - th],
  ];
  for (const [label, left, top] of tiles) {
    blocks.push({ type: "text", text: `Detalj, ${label} delen (överlappar grannarna):` });
    blocks.push(img(await jpeg(base.clone().extract({ left, top, width: tw, height: th }), 1568)));
  }
  return blocks;
}

const isPdf = (d: Uint8Array) => d[0] === 0x25 && d[1] === 0x50 && d[2] === 0x44 && d[3] === 0x46; // "%PDF"

export async function readAd(data: Uint8Array, opts: { poster: boolean; fileName: string }): Promise<AdReading> {
  // print files are PDFs: Claude reads the page image plus the PDF's own text layer (exact text)
  const blocks: ContentBlock[] = isPdf(data)
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(data) } },
        { type: "text", text: "Detta är tryckfilen (PDF). Läs texten exakt som den står i filen." },
      ]
    : await imageBlocks(data, opts.poster);
  const { data: out, usage } = await askJson<Omit<AdReading, "usage">>({
    system: SYSTEM,
    toolName: "ad_text",
    toolDescription: "All text on the ad, per product, exactly as printed, plus real text errors.",
    schema: SCHEMA,
    maxTokens: opts.poster ? 10000 : 4000,
    content: [
      ...blocks,
      {
        type: "text",
        text: opts.poster
          ? "Detta är EN skylt. Samma produkt kan synas i flera detaljbilder (de överlappar) – lista den då en gång. " +
            "Men två olika produktbilder med egna priser är två poster, även om de har samma produktnamn."
          : "Detta är en annons (MVK) för Meta.",
      },
    ],
  });
  return { ...out, usage };
}


// ---------- cut-outs ("Frilagda priser & info") ----------

export type CutoutReading = {
  file: string;
  items: AdItem[];
  textIssues: AdReading["textIssues"];
  unreadable: string[];
};

const CUTOUT_SCHEMA = {
  type: "object",
  properties: {
    cutouts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          items: SCHEMA.properties.items,
          textIssues: SCHEMA.properties.textIssues,
          unreadable: SCHEMA.properties.unreadable,
        },
        required: ["index", "items", "textIssues", "unreadable"],
      },
    },
  },
  required: ["cutouts"],
};

/**
 * The team's cut-outs of price + info per product (they get placed on the ads and posters).
 * Several small images per request; each answer is matched back by its index.
 */
export async function readCutouts(files: Array<{ name: string; data: Uint8Array }>): Promise<{ readings: CutoutReading[]; usage: Usage }> {
  const content: ContentBlock[] = [];
  for (let i = 0; i < files.length; i++) {
    content.push({ type: "text", text: `Bild ${i + 1} — fil: ${files[i].name.split("/").pop()}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await jpeg(sharp(Buffer.from(files[i].data)).flatten({ background: "#ffffff" }), 1200) } });
  }
  content.push({
    type: "text",
    text:
      `Detta är ${files.length} utklipp ("frilagda priser & info"): varje bild är pris + infotext för en produkt (ibland även produktnamn), ` +
      `som sedan placeras på annonserna. Svara med en post per bild i "cutouts" (index = bildens nummer). ` +
      `"name" = produktnamnet om det står i bilden, annars tom sträng. Samma regler som för annonser i övrigt.`,
  });
  const { data, usage } = await askJson<{ cutouts: Array<Omit<CutoutReading, "file"> & { index: number }> }>({
    system: SYSTEM,
    content,
    toolName: "cutout_text",
    toolDescription: "Price and info text in each cut-out image, plus real text errors.",
    schema: CUTOUT_SCHEMA,
    maxTokens: 6000,
  });
  const readings = files.map((f, i) => {
    const r = (data.cutouts || []).find((c) => c.index === i + 1);
    return { file: f.name, items: r?.items ?? [], textIssues: r?.textIssues ?? [], unreadable: r?.unreadable ?? [] };
  });
  return { readings, usage };
}
