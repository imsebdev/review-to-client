// app/t/[taskId]/ReviewClient.tsx
"use client";

import Link from "next/link";

type Props = {
  taskId: string;
  title: string;
  client: string;
  due: string;
  preview: string;
};

export default function ReviewClient({ taskId, title, client, due, preview }: Props) {
  const images = preview
    ? preview.split(",").map((u) => u.trim()).filter(Boolean)
    : [];

  const shareHref =
    typeof window !== "undefined"
      ? `mailto:?subject=${encodeURIComponent(`Review: ${title}`)}&body=${encodeURIComponent(window.location.href)}`
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
          {images.length > 0 ? (
            images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt={`Preview ${i + 1}`}
                loading="lazy"
                className="w-full object-cover border-b border-white/10"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ))
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

        {/* Client decision form */}
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

          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="client" value={client} />
          <input type="hidden" name="due" value={due} />

          <button
            type="submit"
            className="rounded-lg bg-white text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Send review
          </button>
        </form>
      </div>
    </main>
  );
}
