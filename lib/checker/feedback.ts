// lib/checker/feedback.ts
//
// Client feedback on the card overrides the manus and the flyer.
// Pernilla's revise/approve notes arrive as "📋 Client Review Submitted" comments (posted by the
// review app), sometimes as her own comments, and the team can paste feedback from email as a
// comment starting with "Kund:" / "Client:" / "Feedback:". Claude turns the comments into a
// list of concrete changes, which run.ts applies to what each MVK/poster is expected to show.

import { askJson, type Usage } from "./anthropic";
import type { Manus } from "./manus";

const CLICKUP = "https://api.clickup.com/api/v2";

export type ClientComment = { date: number; author: string; text: string; files: string[]; decision: string | null };

export type ChangeKind =
  | "headline_set" // the headline should read <text>
  | "headline_remove" // no headline
  | "text_add" // <text> must be on the ad (badge, bauble, extra line)
  | "text_remove" // <text> must not be on the ad (optionally only on <product>)
  | "product_remove"
  | "product_add" // <newProduct> (with price/info if given)
  | "product_replace" // <product> → <newProduct>
  | "product_update" // <product>: new name/price/info/limit
  | "visual" // colours, images, layout — can't be checked from text
  | "other";

export type ClientChange = {
  quote: string; // the client's words
  date: string; // when she said it (YYYY-MM-DD)
  scope: "all" | "mvk" | "poster";
  mvks: number[]; // for scope "mvk"
  kind: ChangeKind;
  product: string | null; // product as named in the manus
  newProduct: string | null;
  text: string | null;
  price: string | null;
  info: string | null;
  limit: string | null;
};

export type ClientFeedback = { comments: ClientComment[]; changes: ClientChange[]; usage: Usage | null };

// ---------- reading comments from ClickUp ----------

const PASTED = /^\s*(kund|client|feedback|pernilla|coop)\s*:/i;

async function clickupGet(path: string): Promise<any> {
  const key = process.env.CLICKUP_API_KEY;
  if (!key) throw new Error("CLICKUP_API_KEY not configured");
  const res = await fetch(`${CLICKUP}${path}`, { headers: { Authorization: key }, cache: "no-store" });
  if (!res.ok) throw new Error(`ClickUp ${res.status} reading comments`);
  return res.json();
}

/** All comments on a card (newest first from ClickUp, paged 25 at a time), plus threaded replies. */
export async function allComments(taskId: string): Promise<any[]> {
  const out: any[] = [];
  let q = "";
  for (let page = 0; page < 12; page++) {
    const r = await clickupGet(`/task/${taskId}/comment${q}`);
    const list: any[] = r.comments || [];
    out.push(...list);
    if (list.length < 25) break;
    const last = list[list.length - 1];
    q = `?start=${last.date}&start_id=${last.id}`;
  }
  const withReplies = out.filter((c) => Number(c.reply_count || 0) > 0).slice(0, 20);
  for (const c of withReplies) {
    const r = await clickupGet(`/comment/${c.id}/reply`).catch(() => ({ comments: [] }));
    out.push(...(r.comments || []));
  }
  return out;
}

/** "📋 Client Review Submitted …" → decision, picked files, comment. */
export function parseReviewComment(text: string): { decision: string | null; files: string[]; comment: string } | null {
  if (!/Client Review Submitted/i.test(text)) return null;
  const decision = text.match(/Decision:\s*(\w+)/i)?.[1]?.toLowerCase() ?? null;
  const files = (text.match(/Design\(s\):\s*([^\n]+)/i)?.[1] ?? "")
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const comment = (text.split(/📝\s*Comment:\s*/i)[1] ?? "").trim();
  return { decision, files, comment };
}

export function pickClientComments(raw: any[], teamEmails: string[]): ClientComment[] {
  const team = new Set(teamEmails.map((e) => e.toLowerCase()));
  const out: ClientComment[] = [];
  for (const c of raw) {
    const text = String(c.comment_text || "").trim();
    if (!text) continue;
    if (/AI check —|Stealth update/i.test(text)) continue;
    const review = parseReviewComment(text);
    const email = String(c.user?.email || "").toLowerCase();
    const date = Number(c.date || 0);
    if (review) {
      if (!review.comment) continue;
      out.push({ date, author: "Kund (granskningslänk)", text: review.comment, files: review.files, decision: review.decision });
    } else if (PASTED.test(text)) {
      out.push({ date, author: "Kund (inklistrat av teamet)", text: text.replace(PASTED, "").trim(), files: [], decision: null });
    } else if (email && !team.has(email) && !email.endsWith("@imseb.com")) {
      out.push({ date, author: `Kund (${email})`, text, files: [], decision: null });
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

// ---------- turning comments into changes ----------

const SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          date: { type: "string" },
          scope: { type: "string", enum: ["all", "mvk", "poster"] },
          mvks: { type: "array", items: { type: "integer" } },
          kind: {
            type: "string",
            enum: [
              "headline_set",
              "headline_remove",
              "text_add",
              "text_remove",
              "product_remove",
              "product_add",
              "product_replace",
              "product_update",
              "visual",
              "other",
            ],
          },
          product: { type: ["string", "null"] },
          newProduct: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          price: { type: ["string", "null"] },
          info: { type: ["string", "null"] },
          limit: { type: ["string", "null"] },
        },
        required: ["quote", "date", "scope", "mvks", "kind", "product", "newProduct", "text", "price", "info", "limit"],
      },
    },
  },
  required: ["changes"],
};

const SYSTEM = `Du hjälper en reklambyrå att kontrollera Coop-annonser (MVK = en 1080x1080-annons, numrerad 1–10, plus ev. 70x100-skyltar).
Annonserna görs enligt ett manus (Excel) och en reklamblad-PDF (DR). Kunden (Pernilla på Coop) ger sedan feedback i kommentarer.
KUNDENS FEEDBACK GÄLLER FÖRE MANUS OCH DR. Din uppgift: gör om kommentarerna till en lista med konkreta ändringar som gäller NU.

Regler:
- Gå igenom kommentarerna i tidsordning. Senare kommentarer ersätter tidigare om de motsäger varandra; ta bara med det som gäller nu.
- En ändring per sak. "quote" = kundens egna ord för just den saken (ordagrant, kort). "date" = kommentarens datum.
- scope: "all" om det gäller alla annonser ("på alla", "överallt"), "mvk" med mvks=[nummer] om det gäller vissa MVK, "poster" för skylten.
  Nämns ingen annons men kommentaren hör till en vald fil (t.ex. "…_MVK3.jpg") och det handlar om den filens innehåll: scope "mvk" med den filens nummer.
  Om en produkt nämns: använd manus-översikten för att hitta vilka MVK (och skylt) den finns på.
- kind:
  headline_set (rubriken ska lyda text), headline_remove (ingen rubrik),
  text_add (texten "text" ska finnas på annonsen, t.ex. julkula/pratbubbla med viss text),
  text_remove (texten "text" ska bort; sätt product om det bara gäller en produkt, t.ex. "2 för" på chokladsnacks),
  product_remove, product_add (newProduct + ev. price/info/limit), product_replace (product → newProduct),
  product_update (product får nytt namn/pris/info/gräns – fyll bara i det kunden faktiskt anger),
  visual (färger, bilder, placering, storlek – går inte att kontrollera i text), other.
- "Tag bort rubrik där det finns" + "lägg till X på MVK3" = headline_remove (all) + text_add (mvk 3).
  "X ska det stå" om en rubrik/text = headline_set eller text_add med X; välj headline_set om manus har en rubrik på den MVK:n.
- product = produktnamnet så som det står i manus-översikten (t.ex. "Chokladsnacks"), annars kundens ord.
- Skriv texter/priser exakt som kunden skrev dem. Hitta aldrig på värden.
- Beröm, "allt ok", tack och frågor utan instruktion: ingen ändring. Är kommentaren tom på instruktioner: tom lista.`;

function manusOverview(manus: Manus | null): string {
  if (!manus) return "(inget manus)";
  const lines = manus.bilder
    .filter((b) => b.products.length || b.rubrik)
    .map((b) => `MVK ${b.index}: rubrik ${b.rubrik ? `"${b.rubrik}"` : "–"}; produkter: ${b.products.map((p) => p.name).join(", ") || "–"}`);
  if (manus.posters.length) lines.push(`Skyltar 70x100: ${manus.posters.length} st`);
  return lines.join("\n");
}

const day = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "?");

export async function readClientFeedback(taskId: string, teamEmails: string[], manus: Manus | null): Promise<ClientFeedback> {
  const comments = pickClientComments(await allComments(taskId), teamEmails);
  if (!comments.length) return { comments, changes: [], usage: null };
  const listing = comments
    .map(
      (c, i) =>
        `#${i + 1} ${day(c.date)} — ${c.author}${c.decision ? ` — beslut: ${c.decision}` : ""}${c.files.length ? ` — vald fil: ${c.files.join(", ")}` : ""}\n${c.text}`,
    )
    .join("\n\n");
  const { data, usage } = await askJson<{ changes: ClientChange[] }>({
    system: SYSTEM,
    content: [{ type: "text", text: `MANUS-ÖVERSIKT\n${manusOverview(manus)}\n\nKUNDKOMMENTARER (äldst först)\n${listing}` }],
    toolName: "client_changes",
    toolDescription: "The client's current change requests, as a list.",
    schema: SCHEMA,
    maxTokens: 3000,
  });
  return { comments, changes: (data.changes || []).filter((c) => c && c.kind), usage };
}

/** Does this change apply to the given file? */
export function appliesTo(c: ClientChange, file: { mvk: number | null; poster: boolean }): boolean {
  if (c.scope === "all") return true;
  if (c.scope === "poster") return file.poster;
  return !file.poster && file.mvk != null && (c.mvks || []).includes(file.mvk);
}
