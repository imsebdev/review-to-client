// Hand-written readings (what I read from the real files) to test the comparison logic offline.
import { checkFile, productsFromPosterName } from "../lib/checker/compare";
import type { FlyerProduct } from "../lib/checker/flyer";
import type { AdItem, AdReading } from "../lib/checker/ad";

const fp = (heading: string, price: string, info: string, o: Partial<FlyerProduct> = {}): FlyerProduct => ({
  manusName: heading, manusPage: null, found: true, page: 1, heading, price, memberPrice: false, klipp: false, limit: null, info, note: null, ...o });
const it = (name: string, price: string, info: string, o: Partial<AdItem> = {}): AdItem => ({
  name, photoShows: name, labelMatchesPhoto: true, price, memberPrice: false, klipp: false, limit: null, info, splashes: [], ...o });
const reading = (items: AdItem[], o: Partial<AdReading> = {}): AdReading => ({
  headline: null, validity: null, otherText: [], items, textIssues: [], unreadable: [], usage: { input_tokens: 0, output_tokens: 0 }, ...o });

// 1) Stora Coop V48 poster — clementine text on the chicken (3 of 19 products, enough to show the logic)
const expected = [
  fp("Clementiner", "20:-/kg", "Spanien. Klass 1.", { memberPrice: true, klipp: true }),
  fp("Färsk hel kyckling", "49:90/kg", "Sverige/Guldfågeln. Kyld. Ca 1400 g."),
  fp("Glass", "2 för 89:-", "Häagen-Dazs. Välj mellan olika sorter. 380-460 ml. Jfr-pris 96:74-117:11/liter."),
];
const poster = reading([
  it("Clementiner", "20:-/kg", "Spanien. Klass 1.", { memberPrice: true, klipp: true }),
  it("Clementiner", "49:90/kg", "Spanien. Klass 1.", { photoShows: "hel kyckling i Guldfågeln-påse", labelMatchesPhoto: false }),
  it("Glass", "2 för 89:-", "Häagen-Dazs. Välj mellan olika sorter. 380-460 ml. Jfr-pris 96:74-117:11/liter."),
], { validity: "23/11–29/11" });
const name = "Stora-Coop_V48 - Päron conference- 70x100 - Skyllt.jpg";
const r1 = checkFile({ file: name, kind: "poster", expected, reading: poster, flyerValidity: "23/11–29/11", manusHeadline: null, headlineNeedsPeriod: false, fileNameProducts: productsFromPosterName(name) });
console.log("### Poster", r1.matchedCount, "/", r1.expectedCount); r1.issues.forEach(i => console.log(` ${i.severity === "error" ? "❌" : "⚠️"} [${i.product ?? "-"}] ${i.message}${i.expected ? ` | expected: ${i.expected}` : ""}${i.found ? ` | found: ${i.found}` : ""}`));

// 2) X:-TRA V48 MVK1 — "1 KG" splash vs 900 g
const r2 = checkFile({ file: "MVK 1", kind: "mvk",
  expected: [fp("Potatis i påse", "9:90/st", "Sverige/Coop. Klass 1. Välj mellan fast och mjölig. 900 g. Jfr-pris 11:-/kg."),
             fp("Brysselkål i nät", "14:90/st", "Sverige/Nederländerna. Klass 1. 500 g. Jfr-pris 29:80/kg.")],
  reading: reading([
    it("Potatis i påse", "9:90/st", "Sverige/Coop. Klass 1. Välj mellan fast och mjölig. 900 g. Jfr-pris 11:-/kg.", { splashes: ["1 KG"] }),
    it("Brysselkål i nät", "14:90/st", "Sverige/Nederländerna. Klass 1. 500 g. Jfr-pris 29:80/kg.", { splashes: ["500 G"] })]),
  flyerValidity: null, manusHeadline: null, headlineNeedsPeriod: false });
console.log("\n### X:TRA MVK1"); r2.issues.forEach(i => console.log(` ${i.severity === "error" ? "❌" : "⚠️"} [${i.product}] ${i.message} | expected: ${i.expected} | found: ${i.found}`));

// 3) X:-TRA V48 MVK6 — the original detergent error (reconstructed from Pernilla's comment)
const r3 = checkFile({ file: "MVK 6", kind: "mvk",
  expected: [fp("Tvättmedel", "39:90/st", "A+. Välj mellan flytande 880 ml och pulver 725 g. Jfr-pris 1:60-1:81/tvätt. Tidigare lägsta pris 45:50/st.")],
  reading: reading([it("Tvättmedel", "39:90/st", "Via. Välj mellan olika sorter. 1,2 liter. Jfr-pris 1:33/tvätt. Tidigare lägsta pris 49:90/st.", { splashes: ["Du sparar 5:60"] })]),
  flyerValidity: null, manusHeadline: null, headlineNeedsPeriod: false });
console.log("\n### X:TRA MVK6 (reconstructed wrong version)"); r3.issues.forEach(i => console.log(` ${i.severity === "error" ? "❌" : "⚠️"} [${i.product}] ${i.message} | expected: ${i.expected} | found: ${i.found}`));
