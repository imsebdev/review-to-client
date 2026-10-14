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

/** First non-empty text value among all custom fields whose (normalised) name matches. */
function textValue(task: any, match: (name: string) => boolean): string {
  const fields: any[] = task?.custom_fields || [];
  for (const f of fields) {
    if (!match(norm(f.name))) continue;
    const v = valueOf(f);
    if (v) return v;
  }
  return "";
}

/**
 * Everything the order-confirmation email needs, read from a ClickUp card.
 * Same shape as the JSON the Zapier "Create Task" zap posts to /api/order-confirmation,
 * so the email looks identical whether it comes from the zap or from the "Skicka" button.
 */
export function confirmationFields(task: any) {
  const ms = (v: unknown) => (v && !isNaN(Number(v)) ? new Date(Number(v)).toISOString() : "");
  return {
    name: textValue(task, (n) => n === "name"),
    email: textValue(task, (n) => n.includes("requester email")),
    company: textValue(task, (n) => n.includes("company name")),
    orderDate: ms(task?.date_created),
    deadline: ms(task?.due_date),
    instructions: String(task?.text_content || task?.description || "").trim(),
    adFormat: textValue(task, (n) => n === "ads format"),
    adType: textValue(task, (n) => n === "ads type"),
    someTextAbove: textValue(task, (n) => n.startsWith("some") && n.includes("copy above")),
    someTextUnder: textValue(task, (n) => n.startsWith("some") && n.includes("copy under")),
    displayCopy: textValue(task, (n) => n.startsWith("display") && n.includes("copy under")),
    pmaxCopy: textValue(task, (n) => n.startsWith("google max")),
    website: textValue(task, (n) => n === "company url"),
    facebookUrl: textValue(task, (n) => n.includes("facebook")),
    spiderSource: textValue(task, (n) => n.includes("spiderads source")),
  };
}
