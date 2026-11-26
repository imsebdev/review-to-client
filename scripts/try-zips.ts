// Offline test: zip contents are sorted correctly (nested zips, cut-outs, print PDF, story sizes, duplicates).
import JSZip from "jszip";
import sharp from "sharp";
import { sortFiles, zipSummary } from "../lib/checker/files";

(async () => {
  const png = async (c: string) => new Uint8Array(await sharp({ create: { width: 100, height: 100, channels: 3, background: c } }).png().toBuffer());
  const inner = new JSZip();
  inner.file("Frilagda priser & info/Kaffe.png", await png("#fff"));
  const z = new JSZip();
  z.file("Stora-Coop_V48_1080x1080_MVK1.jpg", await png("#f00"));
  z.file("Stories/Stora-Coop_V48_1080x1920_MVK1.jpg", await png("#0f0"));
  z.file("Stora-Coop_V48 - Jul- 70x100 - Skylt - Tryckfil.pdf", new TextEncoder().encode("%PDF-1.7"));
  z.file("Extra/Facebook-cover.png", await png("#00f"));
  z.file("Frilagda priser & info/Pepparkakor.png", await png("#fff"));
  z.file("cutouts.zip", await inner.generateAsync({ type: "uint8array" }));
  z.file("__MACOSX/._junk", "x");
  const zipData = await z.generateAsync({ type: "uint8array" });
  const files = await sortFiles([
    { name: "Stora Coop - V48.zip", data: zipData, date: 2 },
    { name: "Stora-Coop_V48_1080x1080_MVK1.jpg", data: await png("#f00"), date: 1 },
  ]);
  for (const f of files) console.log(f.kind.padEnd(7), (f.format ?? "").padEnd(10), f.name, f.replaced ? `(replaces ${f.replaced.name})` : "");
  console.log(zipSummary(files, files.map((f) => f.name)));
})();
