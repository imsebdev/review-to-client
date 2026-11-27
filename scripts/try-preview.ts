// Try the /api/preview renderer on local PDFs (writes <file>.stage.jpg / <file>.full.jpg next to each).
//   npx tsx scripts/try-preview.ts path/to/file.pdf …
import { readFileSync, writeFileSync } from "node:fs";
import { pdfInfo, renderPageJpg } from "../lib/pdf-render";
(async () => {
  for (const f of process.argv.slice(2)) {
    const data = new Uint8Array(readFileSync(f));
    console.log(f.split("/").pop(), await pdfInfo(data));
    for (const [label, o] of [["stage", { dpi: 150, maxEdge: 2400, quality: 82 }], ["full", { dpi: 150, quality: 82 }]] as const) {
      const r = await renderPageJpg(data, 1, o);
      writeFileSync(`${f}.${label}.jpg`, r.jpg);
      console.log(" ", label, `${r.width}x${r.height}`, (r.jpg.length/1e6).toFixed(2)+" MB", r.ms+" ms", "rss", (process.memoryUsage().rss/1e6|0)+" MB");
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
