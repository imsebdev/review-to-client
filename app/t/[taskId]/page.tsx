// app/t/[taskId]/page.tsx
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
import ReviewClient from "./ReviewClient";

type Props = {
  params: { taskId: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

type TaskData = {
  title: string;
  client: string;
  due: string;
  preview: string;
};

const getParam = (sp: Props["searchParams"], k: string, fallback = "") =>
  typeof sp?.[k] === "string" ? decodeURIComponent(String(sp?.[k])) : fallback;

export default async function ReviewPage({ params, searchParams }: Props) {
  const { taskId } = params;

  // Try KV first (new URLs)
  const data = await kv.get<TaskData>(`task:${taskId}`);

  // Fall back to query params (old URLs — keeps them working forever)
  const title   = data?.title   ?? getParam(searchParams, "title", "Untitled");
  const client  = data?.client  ?? getParam(searchParams, "client", "Client");
  const due     = data?.due     ?? getParam(searchParams, "due", "—");
  const preview = data?.preview ?? getParam(searchParams, "preview", "");

  // Only show not found if there's truly nothing at all
  if (!data && !getParam(searchParams, "title")) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <p className="text-zinc-400">Review not found or link has expired.</p>
      </main>
    );
  }

  return (
    <ReviewClient
      taskId={taskId}
      title={title}
      client={client}
      due={due}
      preview={preview}
    />
  );
}
