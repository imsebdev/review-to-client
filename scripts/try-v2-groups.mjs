// node scripts/try-v2-groups.mjs  — checks the v2 grouping rules on real and example file names.
import { sortFiles } from "../public/pitch/v2/groups.mjs";

const u = (n) => `https://x.test/api/file/T/ID/${encodeURIComponent(n)}`;
const cases = {
  "X:-TRA V40 (old names, real card)": [
    "xtra-coop-v40-mvk5-test.png","xtra-coop-v40-mvk8-test.png","xtra-coop-v40-mvk10-test-fix.png","X-TRA - Veckoboost 40.zip",
    "xtra-coop-v40-mvk8-old","xtra-coop-v40-mvk3.png","xtra-coop-v40-mvk4.png","xtra-coop-v40-mvk2.png","xtra-coop-v40-mvk1.png",
    "xtra-coop-v40-mvk10-old","xtra-coop-v40-mvk9.png","xtra-coop-v40-mvk6.png","xtra-coop-v40-mvk7.png","xtra-coop-v40-mvk5-old",
    "Manus_Veckoboost_X-tra.xlsx","cx_2640_mandag_grund_s1-8_godkand_Original.pdf"],
  "Stora Coop V48 (today's names)": [
    "Stora-Coop_V48 - Jul- 70x100 - Skylt - Tryckfil.zip","Stora Coop - Veckoboost - V48 - Jul.zip","Stora-Coop_V48 - Jul- 70x100 - Skyllt.jpg",
    "Stora-Coop_V48_1080x1080_MVK1.jpg","Stora-Coop_V48_1080x1080_MVK10.jpg","Stora-Coop_V48_1080x1080_MVK2.jpg",
    "Manus_Veckoboost_StoraCoop.xlsx","sc_2648_mandag_torp_s1-12_Original.pdf"],
  "New routine": [
    "Stora-Coop_V48_MVK_1080x1080_02.jpg","Stora-Coop_V48_MVK_1080x1080_01.jpg","Stora-Coop_V48_LABEL_Blomkal.png",
    "Stora-Coop_V48_POSTER_70x100.jpg","Stora-Coop_V48_POSTER_70x100_PRINT.pdf","random-extra.jpg"],
  "Banners": ["Hemmafix_BlackWeek_BANNER_980x240.zip","Hemmafix_BlackWeek_BACKUP_980x240.jpg","Hemmafix_BlackWeek_BANNER_BACKUP_300x250.jpg","old.zip"],
  "No group words": ["ad-1.jpg","ad-2.jpg","flyer-a4.pdf"],
  "Social": ["K_CAROUSEL_1080x1080_02.jpg","K_CAROUSEL_1080x1080_01.jpg","K_STORY_1080x1920_01.jpg","K_REEL_15s.mp4"],
};
for (const [title, names] of Object.entries(cases)) {
  const r = sortFiles(names.map(u));
  console.log(`\n== ${title}`);
  for (const g of r.groups) console.log(`  ${g.title}: ${g.files.map((f) => f.name + (f.kind !== "image" ? ` [${f.kind}]` : "")).join(" | ")}`);
  for (const h of r.hidden) console.log(`  hidden: ${h.name} (${h.reason})`);
  if (r.ungrouped.length) console.log(`  WARN no group word: ${r.ungrouped.join(", ")}`);
}
