// lib/clickup-task.ts
// Read a ClickUp task and pull out the custom fields the review system cares about.

const CLICKUP = "https://api.clickup.com/api/v2";

export async function fetchTask(taskId: string): Promise<any> {
  const key = process.env.CLICKUP_API_KEY;
  if (!key) throw new Error("CLICKUP_API_KEY not configured");
  const res = await fetch(`${CLICKUP}/task/${taskId}?include_subtasks=false`, {
    headers: { Authorization: key, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status} ${res.statusText}`);
  return res.json();
}

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/[:\s]+$/g, "");
}

function findField(task: any, match: (name: string) => boolean): any | null {
  const fields: any[] = task?.custom_fields || [];
  return fields.find((f) => match(norm(f.name))) || null;
}

function valueOf(f: any | null): string {
  const v = f?.value;
  return typeof v === "string" ? v.trim() : "";
}

export function taskFields(task: any) {
  const name = findField(task, (n) => n === "name");
  const requester = findField(task, (n) => n.includes("requester email"));
  const company = findField(task, (n) => n.includes("company name"));
  const framer = findField(task, (n) => n.includes("framer"));
  const reviewLink = findField(task, (n) => n.includes("client review link"));
  return {
    name: valueOf(name),
    requesterEmail: valueOf(requester),
    company: valueOf(company),
    framerLink: valueOf(framer),
    reviewLinkFieldId: (reviewLink?.id as string) || "",
  };
}

export function attachmentUrls(task: any): string[] {
  const list: Array<{ url?: string }> = task?.attachments || [];
  return list.map((a) => a.url).filter((u): u is string => !!u);
}
