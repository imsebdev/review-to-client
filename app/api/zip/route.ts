// app/api/zip/route.ts
// GET /api/zip?taskId=<id>&ids=<attId>,<attId>,…&folders=1&name=<zip name>
//
// Streams a zip of the given attachments, fetched fresh from ClickUp at click time, so the zip
// always matches the card (stealth updates included). New route for review page v2; no other
// route is changed. Used by: "Ladda ner alla som zip", the per-group "Zip" buttons and
// "Ladda ner valda som zip".
//
// - ids: attachment ids, exactly as in the page's /api/file/<task>/<attId>/<name> links
// - folders=1: one folder per group inside the zip (group names from public/pitch/v2/groups.mjs)
// - name: zip file name without ".zip" (sanitised)
// Files the client must never get (manus .xlsx, the Tally flyer PDF, old zips) are refused
// here too, not only hidden on the page.

import { NextRequest, NextResponse } from "next/server";
import { fetchTask } from "../../../lib/clickup-task";
import { attachmentIdFromUrl } from "../../../lib/attachments";
import { zipStream, uniquePaths, ZipEntry } from "../../../lib/zip-stream";
// @ts-ignore — plain JS module shared with the review page
import { sortFiles } from "../../../public/pitch/v2/groups.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILES = 200;
const URL_MAX_AGE_MS = 120_000; // ClickUp signed URLs last ~5 min; refresh well before that

type Att = { url: string; title: string };

async function attachmentsOf(taskId: string): Promise<Map<string, Att>> {
  const task = await fetchTask(taskId);
  const map = new Map<string, Att>();
  for (const a of task?.attachments || []) {
    const id = a?.url ? attachmentIdFromUrl(a.url) : null;
    if (id) map.set(id, { url: a.url, title: String(a.title || a.url.split("/").pop() || "fil") });
  }
  return map;
}

function zipFileName(raw: string | null): string {
  const base = (raw || "SpiderAds")
    .normalize("NFC")
    .replace(/\.zip$/i, "")
    .replace(/[^\p{L}\p{N} _.-]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120) || "SpiderAds";
  return base + ".zip";
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const taskId = sp.get("taskId") || "";
  const ids = (sp.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const folders = sp.get("folders") === "1";

  if (!/^[a-z0-9]+$/i.test(taskId)) return new NextResponse("Bad taskId", { status: 400 });
  if (!ids.length) return new NextResponse("No files", { status: 400 });
  if (ids.length > MAX_FILES || ids.some((id) => !/^[a-z0-9-]{8,64}$/i.test(id))) {
    return new NextResponse("Bad file list", { status: 400 });
  }

  let atts: Map<string, Att>;
  let fetchedAt = Date.now();
  try {
    atts = await attachmentsOf(taskId);
  } catch (e) {
    console.error("zip: task fetch failed", e);
    return new NextResponse("Could not fetch files", { status: 502 });
  }

  // Same rules as the page: hide order inputs and old zips, group by group word, sort.
  const wanted = Array.from(new Set(ids)).filter((id) => atts.has(id));
  const fakeUrl = (id: string) => `x/${id}/${encodeURIComponent(atts.get(id)!.title)}`;
  const sorted = sortFiles(wanted.map(fakeUrl));
  const files: { id: string; path: string }[] = [];
  for (const g of sorted.groups) {
    for (const f of g.files) {
      const id = String(f.url).split("/")[1];
      files.push({ id, path: (folders && sorted.groups.length > 1 ? g.title + "/" : "") + f.name });
    }
  }
  if (!files.length) return new NextResponse("No downloadable files", { status: 404 });

  const paths = uniquePaths(files.map((f) => f.path));
  const entries: ZipEntry[] = files.map((f, k) => ({
    name: paths[k],
    open: async () => {
      // Each signed URL works once and expires: refresh the whole set when it gets old,
      // and after a URL has been used.
      let att = atts.get(f.id);
      if (!att || Date.now() - fetchedAt > URL_MAX_AGE_MS) {
        atts = await attachmentsOf(taskId);
        fetchedAt = Date.now();
        att = atts.get(f.id);
      }
      if (!att) throw new Error("attachment gone");
      atts.delete(f.id);
      const res = await fetch(att.url, { cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`ClickUp file ${res.status}`);
      return res.body as ReadableStream<Uint8Array>;
    },
  }));

  const name = zipFileName(sp.get("name"));
  const ascii = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const stream = zipStream(entries, (n, e) => console.error(`zip ${taskId}: skipped ${n}:`, e));

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
