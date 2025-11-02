// app/t/[taskId]/page.tsx
import Link from "next/link";

type Props = {
  params: { taskId: string };
  searchParams: {
    title?: string;
    client?: string;
    due?: string;
    preview?: string; // image URL
  };
};

export default function ReviewPage({ params, searchParams }: Props) {
  const { taskId } = params;
  const title = decodeURIComponent(searchParams.title ?? "").trim() || "Untitled";
  const client = decodeURIComponent(searchParams.client ?? "").trim() || "Client";
  const due = decodeURIComponent(searchParams.due ?? "").trim() || "—";
  const preview = decodeURIComponent(searchParams.preview ?? "").trim() || "";

  return (
    <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-4xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Client Review</h1>
            <p className="text-zinc-400">Task ID: <span className="font-mono">{taskId}</span></p>
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
              className="w-full max-h-[420px] object-cover border-b border-white/10"
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
              href={`mailto:?subject=Review: ${encodeURIComponent(title)}&body=${encodeURIComponent(location.href)}`}
              className="rounded-lg bg-white text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90"
            >
              Share Link
            </a>
            <button
              onClick={() => navigator.clipboard.writeText(location.href)}
              className="rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm"
            >
              Copy Link
            </button>
          </div>
        </div>

        <p className="text-xs text-zinc-500">
          Tip: add <code>?title=&client=&due=&preview=</code> query params to control the page.
        </p>
      </div>
    </main>
  );
}
