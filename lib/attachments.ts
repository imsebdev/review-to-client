// lib/attachments.ts
// ClickUp now returns attachment URLs with a signed `authz_token` that expires after
// ~5 minutes and can be used only once. Those URLs must never be stored or handed to
// the client directly. Instead the page gets stable links to /api/file/<taskId>/<attId>/<name>,
// and that route asks ClickUp for a fresh signed URL on every request and redirects to it.

import { fetchTask } from "./clickup-task";

const ATT_HOST = /clickup-attachments\.com$|attachments\.clickup\.com$/;

/** Extract the attachment UUID (the path segment before the filename) from a ClickUp attachment URL. */
export function attachmentIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!ATT_HOST.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean); // [t9015…, uuid, filename]
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  } catch {
    return null;
  }
}

/** Turn a (possibly expired) ClickUp attachment URL into a stable link to our own file route. */
export function toFileRoute(origin: string, taskId: string, url: string): string {
  const id = attachmentIdFromUrl(url);
  if (!id) return url;
  const name = new URL(url).pathname.split("/").pop() || "file"; // already URL-encoded
  return `${origin}/api/file/${encodeURIComponent(taskId)}/${encodeURIComponent(id)}/${name}`;
}

/** Rewrite every ClickUp attachment URL inside a comma-separated preview string. */
export function rewritePreview(origin: string, taskId: string, preview: string): string {
  return preview
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => toFileRoute(origin, taskId, u))
    .join(",");
}

// One ClickUp task fetch returns a fresh single-use URL for every attachment.
// Hand each one out at most once, and only while it is still clearly valid,
// so a page load with many images costs one or two API calls instead of one per file.
const pool = new Map<string, { at: number; urls: Map<string, string> }>();
const POOL_TTL_MS = 120_000;

async function refill(taskId: string) {
  const task = await fetchTask(taskId);
  const urls = new Map<string, string>();
  for (const a of task?.attachments || []) {
    const id = a?.url ? attachmentIdFromUrl(a.url) : null;
    if (id) urls.set(id, a.url);
  }
  const entry = { at: Date.now(), urls };
  pool.set(taskId, entry);
  return entry;
}

/** Get a fresh, unused signed URL for one attachment of a task. */
export async function freshAttachmentUrl(taskId: string, attId: string): Promise<string | null> {
  let entry = pool.get(taskId);
  if (!entry || Date.now() - entry.at > POOL_TTL_MS || !entry.urls.has(attId)) {
    entry = await refill(taskId);
  }
  const url = entry.urls.get(attId) || null;
  entry.urls.delete(attId); // single-use: never hand out the same token twice
  return url;
}
