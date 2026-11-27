// app/api/preview/route.ts
// GET /api/preview?taskId=<id>&id=<attId>&page=<n>&size=stage|full
// GET /api/preview?taskId=<id>&id=<attId>&info=1        → { pages, sizes } as JSON
//
// A JPG picture of one page of a PDF on the card (e.g. the poster's print file), for the review
// page v2 slideshow. New route; no other route is changed, and nothing is written to the card.
//
// - size=stage: the lighter slideshow version (150 dpi, longest side at most 2400 px)
// - size=full:  the full 150 dpi picture (≈ 4170 × 5941 px for a 70×100 poster), for the lightbox
// The client still downloads the original PDF through /api/file; this is only a picture of it.
//
// Speed: the first request renders (a few seconds) and the answer is cached on Vercel's CDN.
// The URL holds the attachment id, and a stealth update uploads a new file (new id), so a cached
// picture can never belong to an older version of the file.
// Files the client must never see (the Tally flyer, manus, old zips) are refused here too.

import { NextRequest, NextResponse } from "next/server";
import { fetchTask } from "../../../lib/clickup-task";
import { attachmentIdFromUrl } from "../../../lib/attachments";
import { pdfInfo, renderPageJpg } from "../../../lib/pdf-render";
// @ts-ignore — plain JS module shared with the review page
import { hiddenReason, extOf } from "../../../public/pitch/v2/groups.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DPI = 150;
const STAGE_MAX_EDGE = 2400;
const QUALITY = 82;
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PAGES = 20;

// Cache: browsers for a day, Vercel's CDN for 30 days (the URL changes when the file changes).
const CACHE_OK = {
  "Cache-Control": "public, max-age=86400",
  "Vercel-CDN-Cache-Control": "public, s-maxage=2592000",
};

// Keep the last few PDFs in memory, so "info" + "stage" + "full" for the same file on a warm
// function instance download it from ClickUp only once.
const recent = new Map<string, Uint8Array>();
const RECENT_MAX = 3;

function fail(status: number, msg: string) {
  return new NextResponse(msg, { status, headers: { "Cache-Control": "no-store" } });
}

async function loadPdf(taskId: string, attId: string): Promise<Uint8Array | Response> {
  const key = taskId + "/" + attId;
  const hit = recent.get(key);
  if (hit) return hit;

  const task = await fetchTask(taskId);
  const att = (task?.attachments || []).find((a: any) => a?.url && attachmentIdFromUrl(a.url) === attId);
  if (!att) return fail(404, "File not found on task");
  const title = String(att.title || att.url.split("/").pop() || "");
  if (extOf(title) !== "pdf") return fail(400, "Not a PDF");
  if (hiddenReason(title)) return fail(404, "File not found on task"); // never preview order inputs
  if (Number(att.size) > MAX_PDF_BYTES) return fail(413, "PDF too large to preview");

  const res = await fetch(att.url, { cache: "no-store" });
  if (!res.ok) return fail(502, `ClickUp file ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_PDF_BYTES) return fail(413, "PDF too large to preview");

  recent.set(key, data);
  while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
  return data;
}

// Stream the JPG out in pieces: a full 150 dpi poster is ~5 MB, above Vercel's 4.5 MB limit
// for answers sent in one go.
function streamOf(buf: Buffer): ReadableStream<Uint8Array> {
  const CHUNK = 256 * 1024;
  let pos = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (pos >= buf.length) { ctrl.close(); return; }
      ctrl.enqueue(new Uint8Array(buf.subarray(pos, Math.min(pos + CHUNK, buf.length))));
      pos += CHUNK;
    },
  });
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const taskId = sp.get("taskId") || "";
  const attId = sp.get("id") || "";
  const info = sp.get("info") === "1";
  const size = sp.get("size") === "full" ? "full" : "stage";
  const page = parseInt(sp.get("page") || "1", 10);

  if (!/^[a-z0-9]+$/i.test(taskId)) return fail(400, "Bad taskId");
  if (!/^[a-z0-9-]{8,64}$/i.test(attId)) return fail(400, "Bad file id");
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) return fail(400, "Bad page");

  let data: Uint8Array;
  try {
    const got = await loadPdf(taskId, attId);
    if (got instanceof Response) return got;
    data = got;
  } catch (e) {
    console.error("preview: fetch failed", taskId, attId, e);
    return fail(502, "Could not fetch file");
  }

  try {
    if (info) {
      const i = await pdfInfo(data);
      return NextResponse.json(
        { pages: Math.min(i.pages, MAX_PAGES), totalPages: i.pages, sizes: i.sizes.slice(0, MAX_PAGES) },
        { headers: CACHE_OK },
      );
    }

    const r = await renderPageJpg(data, page, { dpi: DPI, maxEdge: size === "stage" ? STAGE_MAX_EDGE : undefined, quality: QUALITY });
    console.log(`preview ${taskId}/${attId} p${page} ${size}: ${r.width}x${r.height}, ${(r.jpg.length / 1e6).toFixed(2)} MB, ${r.ms} ms`);
    return new Response(streamOf(r.jpg), {
      headers: {
        ...CACHE_OK,
        "Content-Type": "image/jpeg",
        "Content-Length": String(r.jpg.length),
        "X-Page-Count": String(r.pages),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof RangeError) return fail(404, "No such page");
    console.error("preview: render failed", taskId, attId, page, e);
    return fail(500, "Could not render preview");
  }
}
