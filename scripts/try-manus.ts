import { readFileSync } from "fs";
import { readManus, posterProducts } from "../lib/checker/manus";
const cases: Array<[string, number, string]> = [
  ["checker-fixtures/manus-xtra.xlsx", 48, "X:-TRA - V.48 - New Christmas Theme - MVK x10 + 2 Posters"],
  ["checker-fixtures/manus-stora.xlsx", 48, "Stora Coop - V.48 - Christmas Theme - MVK x10 + 70x100 Poster"],
  ["checker-fixtures/manus-stora.xlsx", 47, "Stora Coop - V.47 - Family Theme (Like V.43) - MVK x10 - Poster"],
  ["checker-fixtures/manus-stora.xlsx", 47, "Stora Coop - Medlemsvecka Theme - V47 - MVK x10"],
  ["checker-fixtures/manus-coopplus.xlsx", 47, "Coop+ - V.47 - MVK x10"],
];
(async () => {
  for (const [f, w, t] of cases) {
    const { manus, choice } = await readManus(readFileSync(f), w, t);
    console.log(`\n### ${t}\n sheet: ${choice?.sheet} (${choice?.reason}) chain=${manus?.chain} theme=${manus?.theme}`);
    for (const b of manus!.bilder) console.log(` Bild ${b.index}${b.poster ? " [POSTER]" : ""} rubrik=${JSON.stringify(b.rubrik)} :: ${b.products.map(p => `${p.name}(s${p.page ?? "?"})`).join(", ")}${b.notes.length ? "  notes=" + JSON.stringify(b.notes) : ""}`);
    for (const p of manus!.posters) console.log(` POSTER ${JSON.stringify(p)} -> ${posterProducts(manus!, p).length} products`);
    console.log(" rules:", manus!.rules.map(r => r.slice(0, 70)));
  }
})();
