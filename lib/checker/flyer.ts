// lib/checker/flyer.ts
//
// Reads the "DR" flyer PDF and returns, for every product in the manus, exactly what the
// flyer prints: heading, price/mechanic, conditions and info line. This is the source of
// truth the ads are compared against.

import { askJson, b64, type Usage } from "./anthropic";
import type { ManusProduct } from "./manus";

export type FlyerProduct = {
  manusName: string; // as written in the manus ("Hägen daszs")
  manusPage: number | null;
  found: boolean; // false = not in the flyer ("Egen vara som ej finns i DR")
  page: number | null; // page where it was found
  heading: string; // product name as printed ("Glass")
  price: string; // as printed: "2 för 89:-", "49:90/kg", "45:-/st"
  memberPrice: boolean; // "Medlemspris" badge
  klipp: boolean; // "KLIPP!" badge
  limit: string | null; // "MAX 2 ST/HUSHÅLL." exactly as printed, or null
  limitFor?: string | null; // product name printed directly under that MAX line (self-check)
  info: string; // info line(s) under the heading, exactly as printed, joined with one space
  note: string | null; // anything the reader was unsure about
};

export type FlyerReading = { validity: string | null; products: FlyerProduct[]; usage: Usage };

const SCHEMA = {
  type: "object",
  properties: {
    validity: {
      type: ["string", "null"],
      description: 'Validity period printed on the flyer, e.g. "23/11–29/11" (from "Aktuella priser 23/11–29/11").',
    },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          manusName: { type: "string" },
          manusPage: { type: ["integer", "null"] },
          found: { type: "boolean" },
          page: { type: ["integer", "null"] },
          heading: { type: "string" },
          price: { type: "string" },
          memberPrice: { type: "boolean" },
          klipp: { type: "boolean" },
          limit: { type: ["string", "null"] },
          limitFor: {
            type: ["string", "null"],
            description: "If limit is set: the product name printed DIRECTLY UNDER that MAX line (same column).",
          },
          info: { type: "string" },
          note: { type: ["string", "null"] },
        },
        required: ["manusName", "manusPage", "found", "page", "heading", "price", "memberPrice", "klipp", "limit", "info", "note"],
      },
    },
  },
  required: ["validity", "products"],
};

const SYSTEM = `Du läser svenska dagligvarureklamblad (DR) från Coop och skriver av exakt vad som står.
Regler:
- Skriv av tecken för tecken: stavning, versaler, skiljetecken, mellanslag, kolon i priser (59:50, 90:-, 110:-/kg).
- Rätta ALDRIG fel i bladet. Gissa aldrig. Är du osäker, skriv det i "note".
- "price" = priset/erbjudandet som tryckt, inklusive mekanik och enhet: "2 för 99:-", "49:90/kg", "45:-/st", "5 för 100:-", "5 för 55:- 10 för 100:-". Upphöjda ören skrivs med kolon (49 90 → 49:90).
- "info" = textraden/raderna under produktnamnet (leverantör, val, vikt, Jfr-pris, Ord. pris, Pant tillkommer …), sammanfogade med ett mellanslag, utan produktnamnet och utan MAX-raden.
- "limit" = rad som "MAX 2 ST/HUSHÅLL." exakt som tryckt, annars null. Den står direkt ovanför produktnamnet i SAMMA
  textblock (samma kolumn/ruta). En MAX-rad som hör till en grannprodukt i en annan kolumn eller ruta räknas inte –
  kontrollera vänsterkanten: MAX-raden och produktnamnet börjar i samma x-position. Vid minsta tvekan: null + note.
- Sidnumret i manus (s1, s 5) är en ledtråd; produkten kan finnas på en annan sida. Manusnamnet kan vara slarvigt stavat ("Hägen daszs" = Häagen-Dazs, "Sötpotsatis" = Sötpotatis) eller allmänt ("Äpplen" = "Äpplen Pink Lady").
- Hittas produkten inte i bladet: found=false och tomma strängar.`;

/** Bump when the prompt changes so cached readings are not reused. */
export const FLYER_PROMPT_VERSION = "3";

export async function readFlyer(pdf: Uint8Array, products: ManusProduct[]): Promise<FlyerReading> {
  const list = products.map((p) => `- ${p.name}${p.page ? ` (sida ${p.page})` : ""}`).join("\n");
  const { data, usage } = await askJson<{ validity: string | null; products: FlyerProduct[] }>({
    system: SYSTEM,
    toolName: "flyer_products",
    toolDescription: "Report each requested product exactly as printed in the flyer.",
    schema: SCHEMA,
    maxTokens: 12000,
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(pdf) } },
      {
        type: "text",
        text: `Hitta dessa produkter i bladet och skriv av dem exakt. Svara med en post per rad nedan, i samma ordning:\n${list}`,
      },
    ],
  });
  // self-check: drop a limit whose MAX line actually sits above a different product
  for (const p of data.products) {
    if (p.limit && p.limitFor && !sameName(p.limitFor, p.heading)) {
      p.note = `${p.note ? p.note + " " : ""}MAX line "${p.limit}" belongs to "${p.limitFor}", not this product.`;
      p.limit = null;
    }
  }
  return { ...data, usage };
}

function sameName(a: string, b: string): boolean {
  const k = (s: string) => s.toLowerCase().replace(/[^a-zåäöéü0-9]+/g, "");
  return k(a) === k(b) || k(a).includes(k(b)) || k(b).includes(k(a));
}
