// lib/sprakkoll.ts
// Språkkoll: spelling & grammar suggestions for the client-facing text fields on a card
// ("Message to client" — shown on the review page and used in the email — and "Company name",
// shown as "Projekt"). Suggestions only: nothing is ever changed on the card by this code.
//
// Claude returns a list of fixes (exact wrong text → right text). The corrected text is built
// here by applying exactly those fixes to the original, so it can never contain a change that
// isn't listed in the comment.
//
// Separate from the AI content checker (lib/checker/*), which checks the designs. It only reuses
// the checker's Claude call (askJson) and is otherwise independent.

import { askJson, type Usage } from "./checker/anthropic";

export type SprakField = { key: "message" | "company"; label: string; text: string };
export type Fix = { wrong: string; right: string; why: string };
export type FieldResult = SprakField & { fixes: Fix[]; corrected: string };
export type SprakResult = { fields: FieldResult[]; fixCount: number; usage: Usage | null; ms: number };

const SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["message", "company"] },
          fixes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                wrong: { type: "string", description: "the wrong part, copied EXACTLY from the text (same letters, case, spaces), as short as possible but unique enough to find" },
                right: { type: "string", description: "the corrected version of exactly that part" },
                why: { type: "string", description: "max 8 words, plain English, e.g. 'spelling', 'written as one word', 'en-word: uppdaterad'" },
              },
              required: ["wrong", "right", "why"],
            },
          },
        },
        required: ["key", "fixes"],
      },
    },
  },
  required: ["fields"],
};

const SYSTEM = `You proofread short client-facing texts for an advertising agency (SpiderAds) before they go to a client.
The texts are mostly Swedish, sometimes English. They are:
- "message": a short, friendly message to the client, shown on the client's review page and in the email.
- "company": the project title shown on the review page (title style, e.g. "Stora Coop - Jul - Veckoboost 48 - MVK-konceptannonser x10 & 70x100 Skylt").

Report ONLY real mistakes a careful Swedish/English proofreader would fix:
- misspelled words, doubled/missing/swapped letters (veckobosst → veckoboost, skyllt → skylt)
- särskrivning: words that must be written together, or joined with a hyphen after an abbreviation or a capitalised name/word (Jul konceptannonser → jul-konceptannonser, MVK konceptannonser → MVK-konceptannonser, zip filen → zip-filen)
- wrong en/ett agreement (uppdaterat skylt → uppdaterad skylt), wrong word form
- wrong capitalisation inside a sentence (a common noun capitalised mid-sentence: "Jul" in running text → "jul"; but keep capitals at the start of a sentence and in titles where every part starts with a capital)
- clearly wrong punctuation or spacing (missing space after a full stop or comma, doubled words, space before a comma)

Do NOT report, and never change:
- tone, word choice, style, sentence length, informal greetings, emojis, the "// Mvh, Name" signature style
- brand, store and product names: Coop, Stora Coop, Coop+, X:-TRA, Veckoboost, MVK, SpiderAds, people's names
- sizes and formats (70x100, 1080x1080, A4), week numbers (V48, v.48), prices, dates
- anything inside quotation marks that is a file name (e.g. "Stora-Coop_V48 - Jul- 70x100 - Skylt - Tryckfil.zip")
- English words commonly used in Swedish agency talk (korr, deadline, feedback, zip)
- missing full stop at the very end, title-style capitalisation in the "company" field
If a text has no real mistakes, return an empty fixes list for it. When in doubt, leave it out.

Each fix: "wrong" must be copied exactly from the text so it can be found and replaced; keep it short (the word or the few words that change). "right" is the replacement for exactly that part.`;

function applyFixes(text: string, fixes: Fix[]): { corrected: string; used: Fix[] } {
  let corrected = text;
  const used: Fix[] = [];
  // longest first, so a fix inside a longer fix doesn't break it
  for (const f of [...fixes].sort((a, b) => b.wrong.length - a.wrong.length)) {
    if (!f.wrong || f.wrong === f.right || !corrected.includes(f.wrong)) continue;
    corrected = corrected.split(f.wrong).join(f.right);
    used.push(f);
  }
  // keep the order the fixes appear in the original text
  used.sort((a, b) => text.indexOf(a.wrong) - text.indexOf(b.wrong));
  return { corrected, used };
}

export async function proofread(fields: SprakField[]): Promise<SprakResult> {
  const t0 = Date.now();
  const todo = fields.filter((f) => f.text.trim());
  if (!todo.length) return { fields: [], fixCount: 0, usage: null, ms: 0 };

  const input = todo.map((f) => `<${f.key}>\n${f.text}\n</${f.key}>`).join("\n\n");
  const { data, usage } = await askJson<{ fields: { key: string; fixes: Fix[] }[] }>({
    system: SYSTEM,
    content: [{ type: "text", text: `Proofread these texts:\n\n${input}` }],
    toolName: "sprakkoll",
    toolDescription: "Report the real spelling/grammar mistakes in each text (empty list if none).",
    schema: SCHEMA,
    maxTokens: 2000,
  });

  const out: FieldResult[] = todo.map((f) => {
    const raw = (data.fields || []).find((x) => x.key === f.key)?.fixes || [];
    const clean = raw
      .map((x) => ({ wrong: String(x.wrong ?? ""), right: String(x.right ?? ""), why: String(x.why ?? "").slice(0, 80) }))
      .filter((x) => x.wrong.trim());
    const { corrected, used } = applyFixes(f.text, clean);
    return { ...f, fixes: used, corrected };
  });
  return { fields: out, fixCount: out.reduce((n, f) => n + f.fixes.length, 0), usage, ms: Date.now() - t0 };
}

/** The ClickUp comment (plain text). Only called when there is at least one fix. */
export function commentText(r: SprakResult): string {
  const parts: string[] = [`✍️ Språkkoll – ${r.fixCount} spelling/grammar ${r.fixCount === 1 ? "suggestion" : "suggestions"} (nothing has been changed)`];
  for (const f of r.fields.filter((x) => x.fixes.length)) {
    parts.push(
      `${f.label}:\n` +
        f.fixes.map((x) => `• "${x.wrong}" → "${x.right}" (${x.why})`).join("\n") +
        `\n\nCorrected ${f.label.toLowerCase()} (copy into the field if you agree):\n${f.corrected}`,
    );
  }
  return parts.join("\n\n");
}

export function slackLine(taskId: string, taskName: string, r: SprakResult, opts: { live: boolean; comment: string }): string {
  const link = `<https://app.clickup.com/t/${taskId}|${taskName || "#" + taskId}>`;
  const tag = opts.live ? "" : "[TEST] ";
  if (!r.fixCount) return `${tag}✍️ Språkkoll ${link}: ✅ no mistakes found.`;
  const fixes = r.fields.flatMap((f) => f.fixes.map((x) => `• ${f.label}: "${x.wrong}" → "${x.right}" (${x.why})`)).join("\n");
  return `${tag}✍️ Språkkoll ${link}: ${r.fixCount} ${r.fixCount === 1 ? "suggestion" : "suggestions"} (ClickUp comment: ${opts.comment})\n${fixes}`;
}
