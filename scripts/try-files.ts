import { readFileSync } from "fs";
import { sortFiles, pickFlyer, weekFromTitle, chainFromTitle } from "../lib/checker/files";
const U = "/mnt/user-data/uploads/";
(async () => {
  const files = [
    "3911232e-X-TRA_-_Veckoboost_48_-_Jul_1.zip", "285e863f-Manus_Veckoboost_X-tra_2.xlsx",
    "44306dbb-cx_2651_mandag_grund_s1-8_proof5_v2_1.pdf", "771179b6-cx_2648_mandag_grund_s1-8_godkand_Original.pdf",
  ].map(n => ({ name: n.replace(/^[0-9a-f]{8}-/, ""), data: new Uint8Array(readFileSync(U + n)) }));
  const s = await sortFiles(files);
  const count: Record<string, number> = {};
  s.forEach(f => (count[f.kind] = (count[f.kind] ?? 0) + 1));
  console.log(count);
  console.log("posters:", s.filter(f => f.kind === "poster").map(f => f.name.split("/").pop()));
  console.log("mvks:", s.filter(f => f.kind === "mvk").map(f => f.mvk).sort((a, b) => a! - b!).join(","));
  console.log("flyer for week 48:", pickFlyer(s, 48)?.name);
  for (const t of ["X:-TRA - V.48 - New Christmas Theme", "Stora Coop - Veckoboost 45 - MVK x10", "Coop+ V46 - MVK x10 - REVIEW", "Coop Närhandel - V47 . MVK x10", "Stora Coop - Vecka 18 - 10x MVK", "Coop+ V.48 - Medlemsvecka theme like Stora Coop V.47"])
    console.log(t.padEnd(55), "week", weekFromTitle(t), "chain", chainFromTitle(t));
})();
