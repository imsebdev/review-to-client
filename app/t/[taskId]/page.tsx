// app/t/[taskId]/page.tsx
"use client";

type Props = {
  params: { taskId: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

export default function ReviewPage({ params, searchParams = {} }: Props) {
  const { taskId } = params;

  const get = (k: string, fallback = "") =>
    typeof searchParams[k] === "string" ? decodeURIComponent(String(searchParams[k])) : fallback;

  const title = get("title", "Untitled");
  const client = get("client", "Client");
  const due = get("due", "—");
  const preview = get("preview", "");

  return (
    <main className="min-h-screen bg-zinc-950 text-white grid place-items-center p-6">
      <div className="w-full max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold">Client Review</h1>
        <p className="text-zinc-400"><span className="text-zinc-300">Task ID:</span> <span className="font-mono">{taskId}</span></p>

        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="Preview"
            loading="lazy"
            className="w-full max-h-[420px] object-cover rounded-xl border border-white/10"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : null}

        <div className="rounded-xl border border-white/10 p-4 bg-white/5 space-y-1">
          <div><span className="text-zinc-400">Title:</span> {title}</div>
          <div><span className="text-zinc-400">Client:</span> {client}</div>
          <div><span className="text-zinc-400">Due:</span> {due}</div>
        </div>

        <p className="text-xs text-zinc-500">
          Add query params: <code>?title=&client=&due=&preview=</code>
        </p>
      </div>
    </main>
  );
}
