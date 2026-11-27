// lib/pdf-render.ts
// Turns one page of a PDF into a JPG, for the review page v2 slideshow (/api/preview).
// pdf.js does the PDF work, @napi-rs/canvas is the canvas it draws on (both run on Vercel, no
// Ghostscript/poppler needed). The original PDF is never changed: this only makes a picture of it.

import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const PT_PER_INCH = 72;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;

/** Load pdf.js once per function instance. The worker module is imported here on purpose:
 *  pdf.js then runs it in this thread, and Vercel's file tracing sees the import. */
function pdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    // @ts-ignore — the worker module has no types
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as any).pdfjsWorker = worker;
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return pdfjsPromise;
}

// Font and image-decoder data that ships with pdf.js (included in the function by
// outputFileTracingIncludes in next.config.mjs). Needed for PDFs that use the 14 standard
// fonts without embedding them, and for JPEG 2000 images.
function assetDir(sub: string): string {
  return path.join(process.cwd(), "node_modules", "pdfjs-dist", sub) + path.sep;
}

async function open(data: Uint8Array) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: data.slice(), // pdf.js takes ownership of the buffer; keep the caller's copy intact
    standardFontDataUrl: assetDir("standard_fonts"),
    cMapUrl: assetDir("cmaps"),
    cMapPacked: true,
    wasmUrl: assetDir("wasm"),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

export type PdfInfo = { pages: number; sizes: { widthMm: number; heightMm: number }[] };

export async function pdfInfo(data: Uint8Array): Promise<PdfInfo> {
  const { doc, close } = await open(data);
  try {
    const sizes: PdfInfo["sizes"] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
      sizes.push({ widthMm: Math.round((vp.width / PT_PER_INCH) * 25.4), heightMm: Math.round((vp.height / PT_PER_INCH) * 25.4) });
    }
    return { pages: doc.numPages, sizes };
  } finally {
    await close();
  }
}

export type RenderOptions = {
  /** Pixels per inch of the page's real size. 150 = the agreed preview resolution. */
  dpi: number;
  /** Optional cap on the longest side in pixels (the lighter slideshow version). */
  maxEdge?: number;
  /** JPG quality 1–100. */
  quality: number;
};

export type Rendered = { jpg: Buffer; width: number; height: number; pages: number; ms: number };

export async function renderPageJpg(data: Uint8Array, pageNo: number, opt: RenderOptions): Promise<Rendered> {
  const t0 = Date.now();
  const { doc, close } = await open(data);
  try {
    if (pageNo < 1 || pageNo > doc.numPages) throw new RangeError(`page ${pageNo} of ${doc.numPages}`);
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 }); // 1 unit = 1 pt = 1/72 inch
    let scale = opt.dpi / PT_PER_INCH;
    if (opt.maxEdge) scale = Math.min(scale, opt.maxEdge / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const width = Math.max(1, Math.round(vp.width));
    const height = Math.max(1, Math.round(vp.height));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // JPG has no transparency: transparent areas become white, like on paper
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx as any, canvas: canvas as any, viewport: vp, background: "#ffffff" } as any).promise;
    const jpg = await canvas.encode("jpeg", opt.quality);
    page.cleanup();
    return { jpg, width, height, pages: doc.numPages, ms: Date.now() - t0 };
  } finally {
    await close();
  }
}
