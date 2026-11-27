import { checkJfr, checkSaving, checkWeightSplash } from "../lib/checker/prices";
const jfr: Array<[string, string, string]> = [
  ["Ägg (V47 poster)", "25:-/förp", "Sverige/Coop. Storlek M. Från frigående höns inomhus. 15 st. Jfr-pris 1:67/st."],
  ["Blöjor (V47 poster)", "2 för 169:- 3 för 229:-", "Libero. Välj mellan Comfort och Up&Go strl 3-8. Gäller ej Touch.Gäller ej Megapack. 20-43 st. Jfr-pris vid köp av 2: 1:97-4:23/st, vid köp av 3: 1:78-5:65/st."],
  ["Grötklämmis (V47)", "5 för 55:- 10 för 100:-", "Semper. Välj mellan olika sorter. 120 g. Jfr-pris vid köp av 5: 91:67/kg, vid köp av 10: 83:33/kg."],
  ["Fish & Crisp (V47)", "2 för 99:-", "Findus. Frysta. Välj mellan gourmetfiléer och fish nuggets. 480-490 g. Jfr-pris 101:02-103:13/kg."],
  ["Julmust (V47)", "2 för 26:-", "Apotekarnes. Välj mellan original och sockerfri. 140 cl. Jfr-pris 9:29/liter. Pant tillkommer."],
  ["Pasta (V47)", "3 för 35:-", "Kungsörnen. Välj mellan olika sorter. Gäller ej fullkornsspaghetti. 500-1000 g. Jfr-pris 11:67-23:33/kg."],
  ["Kycklingfilé (V47)", "99:-/st", "Sverige/Kronfågel. Kyld. 900 g. Jfr-pris 110:-/kg."],
  ["Ost (V47, Ca-vikt)", "69:90/kg", "Arla. Fetthalt 23-33%. Välj mellan olika sorter. Ca 375-1200 g."],
  ["Glass (V48 poster)", "2 för 89:-", "Häagen-Dazs. Välj mellan olika sorter. 380-460 ml. Jfr-pris 96:74-117:11/liter."],
  ["Chokladkakor (V48)", "2 för 40:-", "Marabou. Välj mellan olika sorter. 160-180 g. Jfr-pris 111:11-125:-/kg."],
  ["Västerbottensost (V48)", "79:-/st", "Sverige/Västerbottensost. Lagrad i minst 14 månader. Fetthalt 33%. 450 g. Jfr-pris 175:56/kg."],
  ["Potatis (X:TRA MVK1)", "9 90 /st", "Sverige/Coop. Klass 1. Välj mellan fast och mjölig. 900 g. Jfr-pris 11:-/kg."],
  ["Tvättmedel (per tvätt)", "39 90 /st", "A+. Välj mellan flytande 880 ml och pulver 725 g. Jfr-pris 1:60-1:81/tvätt. Tidigare lägsta pris 45:50/st."],
  // drained weight (avrunnen vikt) — X:-TRA V52 false alarms; all should be ✅
  ["Rödbetor (avr. vikt)", "15:-/st", "Felix. Inlagda. 530 g. Avrunnen vikt 350 g. Jfr-pris 42:86/kg."],
  ["Rödbetor (530 g/350 g)", "15:-/st", "Felix. Inlagda. 530 g/350 g. Jfr-pris 42:86/kg."],
  ["Rödbetor (350 g avr.)", "15:-/st", "Felix. Inlagda. 530 g (350 g avrunnen vikt). Jfr-pris 42:86/kg."],
  ["Sill (range, avr.)", "2 för 50:-", "Abba. Välj mellan olika sorter. 430-440 g. Avr. vikt 214-220 g. Jfr-pris 113:64-116:82/kg."],
  ["Räkor (avr.)", "69:90/st", "Handskalade. I lake. 420 g. Avrunnen vikt 240 g. Jfr-pris 291:25/kg."],
  ["Rödbetor WRONG jfr (❌)", "15:-/st", "Felix. Inlagda. 530 g. Avrunnen vikt 350 g. Jfr-pris 39:90/kg."],
  ["Max line ignored", "2 för 40:-", "Marabou. 160-180 g. Max 3 st/hushåll. Jfr-pris 111:11-125:-/kg."],
];
for (const [name, p, i] of jfr) {
  const r = checkJfr(p, i);
  console.log(name.padEnd(26), r.length ? r.map(f => `${f.ok ? "✅" : "❌"} found ${f.found} expected ${f.expected}`).join(" | ") : "– not checkable");
}
console.log();
for (const [name, p, i, s] of [
  ["Tvättmedel du sparar", "39 90 /st", "A+. Tidigare lägsta pris 45:50/st.", "Du sparar 5 60"],
  ["Papper du sparar minst", "2 för 59:-", "Lambi. 484-776 g. Jfr-pris 38:02-60:95/kg. Ord. pris från 37:90/st.", "Du sparar minst 16 80"],
  ["Synthetic wrong saving", "2 för 40:-", "Estrella. Ord. pris 26:50/st.", "Du sparar 11:60"],
] as const) { const f = checkSaving(p, i, s)!; console.log(name.padEnd(26), f.ok ? "✅" : "❌", "found", f.found, "expected", f.expected); }
console.log();
for (const [name, s, i] of [["Potatis splash", "1 KG", "Sverige/Coop. Klass 1. Välj mellan fast och mjölig. 900 g. Jfr-pris 11:-/kg."], ["Brysselkål splash", "500 G", "Sverige/Nederländerna. Klass 1. 500 g. Jfr-pris 29:80/kg."]] as const) {
  const f = checkWeightSplash(s, i)!; console.log(name.padEnd(26), f.ok ? "✅" : "❌", "found", f.found, "expected", f.expected);
}
