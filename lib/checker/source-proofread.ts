// lib/checker/source-proofread.ts
//
// The client's own material can contain typos too (Coop's DR flyer, the manus, copy fields
// on a card). Designers copy that text word for word, so a typo there ends up in the ad.
// This proofreads the source texts once per order; findings are reported as "the client's
// file has a typo — ask before correcting", and an ad that copied it isn't blamed for it.

import { askJson, type Usage } from "./anthropic";
import type { Issue } from "./compare";

export type SourceText = { where: string; text: string };
export type SourceTypo = { where: string; text: string; issue: string; suggestion: string };

const SCHEMA = {
  type: "object",
  properties: {
    typos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          where: { type: "string" },
          text: { type: "string", description: "the wrong word or phrase, exactly as written" },
          issue: { type: "string" },
          suggestion: { type: "string", description: "the corrected word or phrase" },
        },
        required: ["where", "text", "issue", "suggestion"],
      },
    },
  },
  required: ["typos"],
};

const SYSTEM = `You proofread a client's source material for an ad agency (product texts from a retail flyer, a brief, copy written by the client). Languages: mostly Swedish, also Finnish, Norwegian, English.
Report ONLY clear errors that a careful proofreader would correct before printing:
- misspelled words, doubled or missing letters, swapped letters ("Välj mellan oilka sorter")
- two words run together or one word split wrongly ("mellanolika", "fullkorns makaroner")
- missing space after a full stop or comma between words ("Touch.Gäller"), doubled words ("och och")
Facts, units and numbers are not spelling — skip them entirely.
Do NOT report: brand or product names (Marabou, Gorby's, Änglamark, Toms, made-up product names), abbreviations used in retail (Jfr-pris, Ord. pris, st, förp, Klass 1, ca), capitalisation style, missing final full stop, numbers, prices, dates, style or tone.
"where" = the label given for that text. "text" = the wrong part exactly as written (short). If there are no clear errors: empty list.`;

/** Proofread the client's texts. Duplicate texts are sent once. */
export async function proofreadSources(items: SourceText[]): Promise<{ typos: SourceTypo[]; usage: Usage | null }> {
  const seen = new Set<string>();
  const uniq = items
    .map((i) => ({ where: i.where, text: i.text.replace(/\s+/g, " ").trim() }))
    .filter((i) => i.text.length > 2 && /\p{L}{3}/u.test(i.text))
    .filter((i) => (seen.has(i.text) ? false : (seen.add(i.text), true)))
    .slice(0, 300);
  if (!uniq.length) return { typos: [], usage: null };
  const { data, usage } = await askJson<{ typos: SourceTypo[] }>({
    system: SYSTEM,
    content: [{ type: "text", text: uniq.map((i) => `[${i.where}] ${i.text}`).join("\n") }],
    toolName: "source_typos",
    toolDescription: "Clear spelling/spacing errors in the client's source texts.",
    schema: SCHEMA,
    maxTokens: 2500,
  });
  // keep only findings that really quote the source (guards against invented typos)
  const all = uniq.map((i) => i.text.toLowerCase()).join("\n");
  const typos = (data.typos || []).filter(
    (t) => t.text && t.suggestion && t.text.trim().toLowerCase() !== t.suggestion.trim().toLowerCase() && all.includes(t.text.trim().toLowerCase()),
  );
  return { typos, usage };
}

const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Does this text from an ad contain one of the source typos? */
export function typoIn(text: string | undefined | null, typos: SourceTypo[]): SourceTypo | null {
  if (!text) return null;
  const t = flat(text);
  return typos.find((x) => t.includes(flat(x.text))) ?? null;
}

/** The expected text with the source's typos fixed — what the ad should say. */
export function fixTypos(text: string, typos: SourceTypo[]): string {
  let out = text;
  for (const t of typos) {
    const re = new RegExp(t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, t.suggestion);
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[’‘`´]/g, "'").replace(/[\s.]+$/, "").replace(/\s+/g, "");

/**
 * We correct the client's typos ourselves instead of waiting for them (no bottleneck):
 *  - the ad copied a typo from the client's file → error: correct it in the ad
 *  - the ad already has the correct spelling, and that's the only difference → not an issue
 *  - the ad differs for other reasons too → issue stays, compared against the corrected text
 */
export function correctSourceTypos(issues: Issue[], typos: SourceTypo[], source: string): Issue[] {
  if (!typos.length) return issues;
  const out: Issue[] = [];
  for (const i of issues) {
    const inFound = typoIn(i.found, typos);
    const inExpected = typoIn(i.expected, typos);
    if (inExpected && !inFound && i.found) {
      const fixed = fixTypos(i.expected!, typos);
      if (squash(fixed) === squash(i.found)) continue; // designer already corrected it
      out.push({ ...i, expected: fixed });
      continue;
    }
    if (inFound) {
      out.push({
        ...i,
        severity: "error",
        message: `Typo copied from ${source} — correct it in the ad: “${inFound.text}” → “${inFound.suggestion}”`,
        expected: i.expected && inExpected ? fixTypos(i.expected, typos) : i.expected ?? inFound.suggestion,
      });
      continue;
    }
    out.push(i);
  }
  return out;
}

/** Errors for every client typo that appears on an ad (when the ad matches the flyer, nothing else would catch it). */
export function typoIssues(texts: string[], typos: SourceTypo[], source: string): Issue[] {
  const out: Issue[] = [];
  for (const t of typos) {
    const hit = texts.find((x) => x && typoIn(x, [t]));
    if (hit)
      out.push({
        severity: "error",
        message: `Typo copied from ${source} — correct it in the ad: “${t.text}” → “${t.suggestion}”`,
        found: hit,
        expected: fixTypos(hit, [t]),
      });
  }
  return out;
}

/** The order-level warning: we found it, we correct it, here's what to tell the client. */
export function sourceTypoWarning(t: SourceTypo, owner: string, clientName: string | null): Issue {
  const to = clientName ? `Hej ${clientName}! ` : "Hej! ";
  const var_ = t.where
    .replace(/^flyer p\.\s*([\d?]+)\s*\((.+)\)$/i, "reklambladet s. $1, $2")
    .replace(/^manus Bild (\d+) headline$/i, "manus, rubrik Bild $1")
    .replace(/^client comment$/i, "din kommentar");
  return {
    severity: "warning",
    message:
      `${owner} has a typo (${t.where}): ${t.issue}. Correct it in the ads and let the client know — ` +
      `e.g. “${to}Vi hittade ett stavfel i underlaget (${var_}): ”${t.text}” – vi har rättat det till ”${t.suggestion}” i annonserna.”`,
    found: t.text,
    expected: t.suggestion,
  };
}
