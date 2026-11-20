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
- En post i "items" per produkt (produktnamn + pris + info). Hör två produkter ihop med ett gemensamt pris, en post.
- "price" som tryckt med kolon för ören: 19⁹⁰ → "19:90", "2 för 49:-", "/kg" eller "/st" om det står.
- "info" = textraden/raderna under produktnamnet, sammanfogade med ett mellanslag.
- "photoShows": vad produktbilden bredvid texten faktiskt visar (t.ex. "hel kyckling i Guldfågeln-påse").
  labelMatchesPhoto=false om produktnamnet/texten uppenbart inte hör till bilden (t.ex. texten säger Clementiner men bilden visar kyckling).
- "splashes": övriga märken vid produkten, t.ex. "1 KG", "500 G", "Du sparar 5:60", "Du sparar minst 16:80".
- "textIssues": ENDAST verkliga fel i svensk text: felstavning, saknat mellanslag efter punkt/komma ("Touch.Gäller", "a,b"),
  dubbla mellanslag, produktnamn med liten begynnelsebokstav när övriga har stor, felaktig versalisering. Inte stilval, inte varumärken.
- "unreadable": text du inte kan läsa säkert. Gissa aldrig siffror.`;

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

export async function readAd(data: Uint8Array, opts: { poster: boolean; fileName: string }): Promise<AdReading> {
  const blocks = await imageBlocks(data, opts.poster);
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
