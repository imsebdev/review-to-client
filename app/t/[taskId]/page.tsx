// app/t/[taskId]/page.tsx
"use client";

import Link from "next/link";

type Props = {
  params: { taskId: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

const getParam = (sp: Props["searchParams"], k: string, fallback = "") =>
  typeof sp?.[k] === "string" ? decodeURIComponent(String(sp?.[k])) : fallback;

export default function ReviewPage({ params, searchParams }: Props) {
  const { taskId } = params;

  const title = getParam(searchParams, "title", "Untitled");
  const client = getParam(searchParams, "client", "Client");
  const due = getParam(searchParams, "due", "—");
  const preview = getParam(searchParams, "preview", "");

  const shareHref =
    typeof window !== "undefined"
      ? `mailto:?subject=${encodeURIComponent(`Review: ${title}`)}&body=${encodeURIComponent(
          window.location.href
        )}`
      : "#";

  const copyLink = () => {
    if (typeof window !== "undefined" && navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(window.location.href).catch(() => {});
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-4xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Client Review</h1>
            <p className="text-zinc-400">
              Task ID: <span className="font-mono">{taskId}</span>
            </p>
          </div>
          <Link
            href={`https://app.clickup.com/t/${taskId}`}
            target="_blank"
            className="rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm"
          >
            View in ClickUp
          </Link>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-white/5 border border-white/10 overflow-hidden">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Preview"
              loading="lazy"
              className="w-full max-h-[420px] object-cover border-b border-white/10"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-full h-56 grid place-items-center border-b border-white/10">
              <span className="text-zinc-500">No preview image</span>
            </div>
          )}

          <div className="p-6 space-y-2">
            <h2 className="text-xl font-medium">{title}</h2>
            <p className="text-zinc-400">
              <span className="text-zinc-300">Client:</span> {client}
            </p>
            <p className="text-zinc-400">
              <span className="text-zinc-300">Due:</span> {due}
            </p>
          </div>

          <div className="p-6 pt-0 flex gap-3">
            <a
              href={shareHref}
              className="rounded-lg bg-white text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
            >
              Share Link
            </a>
            <button
              onClick={copyLink}
              className="rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm"
            >
              Copy Link
            </button>
          </div>
        </div>

        {/* Client decision form (posts to Catch Hook via /api/reply) */}
        <form
          method="POST"
          action="/api/reply"
          className="rounded-2xl bg-white/5 border border-white/10 p-6 space-y-4"
        >
          <h3 className="text-lg font-medium">Send your review</h3>

          <fieldset className="space-y-2">
            <legend className="text-sm text-zinc-400 mb-1">Decision</legend>
            <label className="block">
              <input type="radio" name="decision" value="approve" className="mr-2" /> Approve ✅
            </label>
            <label className="block">
              <input type="radio" name="decision" value="needs_changes" className="mr-2" /> Needs
              changes 🔄
            </label>
          </fieldset>

          <div>
            <label className="block text-sm text-zinc-400 mb-1" htmlFor="notes">
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={4}
              placeholder="Optional notes (required if requesting changes)"
              className="w-full rounded-lg border border-white/10 bg-transparent p-3"
            />
          </div>

          {/* Hidden fields for Zapier */}
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="client" value={client} />
          <input type="hidden" name="due" value={due} />
          <input type="hidden" name="preview" value={preview} />

          <button
            type="submit"
            className="rounded-lg bg-white text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Send review
          </button>
        </form>

        <p className="text-xs text-zinc-500">
          Tip: add <code>?title=&client=&due=&preview=</code> query params to control the page.
        </p>
      </div>
    </main>
  );
}
