// app/api/file/[...path]/route.ts
// GET /api/file/<taskId>/<attachmentId>/<filename>
// Redirects to a freshly signed ClickUp attachment URL (they expire after ~5 min and are single-use).
import { NextRequest, NextResponse } from "next/server";
import { freshAttachmentUrl } from "../../../../lib/attachments";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { path: string[] } }) {
  const [taskId, attId] = params.path || [];
  if (!taskId || !attId) return new NextResponse("Bad file link", { status: 400 });

  try {
    const url = await freshAttachmentUrl(decodeURIComponent(taskId), decodeURIComponent(attId));
    if (!url) return new NextResponse("File not found on task", { status: 404 });
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    console.error("file route error:", e);
    return new NextResponse("Could not fetch file", { status: 502 });
  }
}
