// Offline test: client-comment parsing + applying changes to readings (no network).
import { pickClientComments, appliesTo, type ClientChange } from "../lib/checker/feedback";
import { checkFile } from "../lib/checker/compare";

const raw = [
  { comment_text: "📋 Client Review Submitted\n\n🧑‍💼 From: Pern illa Claesson (Stora Coop - Jul)\n✅ Decision: approve\n🖼️ Approved Design(s): Stora-Coop_V48_1080x1080_MVK1.jpg\n📝 Comment: Snyggt, tack så mycket!", user: { email: "info@imseb.com" }, date: 3 },
  { comment_text: "🔎 AI check — Stora Coop …", user: { email: "info@imseb.com" }, date: 2 },
  { comment_text: "📋 Client Review Submitted\n\n✅ Decision: revise\n🖼️ Picked Design(s): Stora-Coop_V48_1080x1080_MVK1.jpg\n📝 Comment: Byt allt rött till gult när det ligger på grönt.\nLägg till julkula med \"Julstöket kan börja! på bild MVK3, MVK9 och tag bort vanliga rubriken där det finns.\nTag bort rubrik på alla där det finns. \nLaxsida i ugnen ska det stå.", user: { email: "info@imseb.com" }, date: 1 },
  { comment_text: "Kund: Pris på kaffe ska vara 39:90", user: { email: "octavian.pop@imseb.com" }, date: 4 },
  { comment_text: "fixed it", user: { email: "octavian.pop@imseb.com" }, date: 5 },
];
const cs = pickClientComments(raw, ["octavian.pop@imseb.com", "info@imseb.com"]);
console.log(cs.map((c) => `${c.date} ${c.author}: ${c.text.slice(0, 50)}`));

// what Claude is expected to return for the revise comment
const changes: ClientChange[] = [
  { quote: "Byt allt rött till gult när det ligger på grönt", date: "", scope: "all", mvks: [], kind: "visual", product: null, newProduct: null, text: null, price: null, info: null, limit: null },
  { quote: "Tag bort rubrik på alla där det finns", date: "", scope: "all", mvks: [], kind: "headline_remove", product: null, newProduct: null, text: null, price: null, info: null, limit: null },
  { quote: "Lägg till julkula med \"Julstöket kan börja!\" på bild MVK3, MVK9", date: "", scope: "mvk", mvks: [3, 9], kind: "text_add", product: null, newProduct: null, text: "Julstöket kan börja!", price: null, info: null, limit: null },
  { quote: "Laxsida i ugnen ska det stå", date: "", scope: "mvk", mvks: [5], kind: "headline_set", product: null, newProduct: null, text: "Laxsida i ugnen", price: null, info: null, limit: null },
];
const base = (headline: string | null, other: string[] = []): any => ({ headline, validity: null, otherText: other, items: [], textIssues: [], unreadable: [] });
function run(mvk: number, manusHeadline: string | null, reading: any) {
  const mine = changes.filter((c) => appliesTo(c, { mvk, poster: false }));
  let h = manusHeadline, forbid = false; const req: any[] = [];
  for (const c of mine) {
    if (c.kind === "headline_remove") { h = null; forbid = true; }
    if (c.kind === "headline_set") { h = c.text; forbid = false; }
    if (c.kind === "text_add") req.push({ text: c.text, quote: c.quote });
  }
  const r = checkFile({ file: `MVK ${mvk}`, kind: "mvk", expected: [], reading, flyerValidity: null, manusHeadline: h, headlineNeedsPeriod: false, forbidHeadline: forbid, requiredTexts: req });
  console.log(`MVK ${mvk}:`, r.issues.map((i) => `${i.severity} ${i.message} ${i.found ?? ""}`).join(" | ") || "OK");
}
run(2, "Julstöket kan börja", base(null));                        // OK: headline removed
run(6, "Matglada middagstips", base("Matglada middagstips"));     // error: should be removed
run(5, "Matglada middagstips", base("Laxsida i ugnen"));          // OK: client headline
run(3, null, base("JULSTÖKET KAN BÖRJA!"));                       // OK: bauble read as headline
run(9, null, base(null));                                         // error: bauble missing
