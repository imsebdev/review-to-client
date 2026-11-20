// lib/checker/report.ts
//
// Turns a CheckReport into a Slack message (#content-checker) and a ClickUp comment.

import type { CheckReport } from "./run";
import type { FileResult, Issue } from "./compare";

// ClickUp assignee email → Slack member id, so the right people get tagged.
// Override/extend with env AI_CHECK_SLACK_IDS='{"email":"Uxxxx"}'.
const DEFAULT_SLACK_IDS: Record<string, string> = {
  "octavian.pop@imseb.com": "U1Z6XTWLX",
  "omotoshomicaiah@gmail.com": "U098V5PKQM6",
  "info@imseb.com": "U1Z6N3B08",
};

function slackIds(): Record<string, string> {
  try {
    return { ...DEFAULT_SLACK_IDS, ...JSON.parse(process.env.AI_CHECK_SLACK_IDS || "{}") };
  } catch {
    return DEFAULT_SLACK_IDS;
  }
}

const STATUS_LINE: Record<CheckReport["status"], string> = {
  passed: "✅ *Passed* — everything matches the manus and the flyer",
  warnings: "⚠️ *Passed with warnings* — no errors, but have a look at the notes",
  failed: "❌ *Needs fixing*",
  incomplete: "⚠️ *Couldn't check everything* — see below; nothing here counts as approved",
  skipped: "⏭️ *Skipped* — not a Coop order",
};

function changeLine(c: CheckReport["clientChanges"][number]): string {
  const where = c.scope === "all" ? "all" : c.scope === "poster" ? "poster" : (c.mvks || []).map((n) => `MVK ${n}`).join(", ");
  const tag = c.kind === "visual" || c.kind === "other" ? "👀 check by eye" : "✔︎ checked";
  return `• ${tag} (${where}): “${c.quote}”`;
}

function issueLine(i: Issue): string {
  const icon = i.severity === "error" ? "❌" : "⚠️";
  const who = i.product ? `*${i.product}*: ` : "";
  let s = `${icon} ${who}${i.message}`;
  if (i.found) s += `\n      found: “${i.found}”`;
  if (i.expected) s += `\n      should be: “${i.expected}”`;
  return s;
}

function fileBlock(f: FileResult): string {
  const errors = f.issues.filter((i) => i.severity === "error").length;
  const head =
    f.kind === "poster"
      ? `*Poster* ${f.file} — ${f.matchedCount}/${f.expectedCount} products`
      : `*${f.file}* — ${f.matchedCount}/${f.expectedCount} products`;
  if (!f.issues.length) return `✅ ${head}`;
  return `${errors ? "❌" : "⚠️"} ${head}\n${f.issues.map((i) => "   " + issueLine(i)).join("\n")}`;
}

export function slackText(r: CheckReport, opts: { live: boolean }): string {
  const ids = slackIds();
  const mentions =
    opts.live && r.status !== "passed"
      ? r.assigneeEmails
          .map((e) => ids[e])
          .filter(Boolean)
          .map((id) => `<@${id}>`)
          .join(" ")
      : "";
  const lines: string[] = [];
  lines.push(`${opts.live ? "" : "[TEST] "}🔎 *AI check* — <${r.url}|${r.title.replace(/[<>|]/g, "")}>`);
  lines.push(STATUS_LINE[r.status] + (mentions ? `  ${mentions}` : ""));
  const meta = [r.sheet && `manus: ${r.sheet}`, r.flyer && `flyer: ${r.flyer}`].filter(Boolean).join(" · ");
  if (meta) lines.push(`_${meta}_`);
  if (r.clientChanges?.length)
    lines.push("", `💬 *Client feedback on the card* (overrides the manus):`, ...r.clientChanges.map(changeLine));
  if (r.orderIssues.length) lines.push("", ...r.orderIssues.map(issueLine));

  const bad = r.files.filter((f) => f.issues.length);
  const good = r.files.filter((f) => !f.issues.length);
  if (bad.length) lines.push("", ...bad.map(fileBlock));
  if (good.length) lines.push("", `✅ OK: ${good.map((f) => (f.kind === "poster" ? "poster " + f.file : f.file)).join(", ")}`);
  lines.push("", `_${Math.round(r.ms / 1000)} s · ${r.tokens.input + r.tokens.output} tokens_`);
  return lines.join("\n");
}

/** ClickUp comments are plain text: drop Slack markup. */
export function clickupText(r: CheckReport): string {
  return slackText(r, { live: false })
    .replace(/^\[TEST\] /, "")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/[*_]/g, "");
}

export async function postSlack(text: string): Promise<string> {
  const hook = process.env.SLACK_WEBHOOK_COOP_QA;
  if (!hook) return "skipped (SLACK_WEBHOOK_COOP_QA not set)";
  // Slack caps a message around 40k chars; split on blank lines if needed
  const chunks: string[] = [];
  let cur = "";
  for (const part of text.split("\n\n")) {
    if ((cur + "\n\n" + part).length > 3500 && cur) {
      chunks.push(cur);
      cur = part;
    } else cur = cur ? `${cur}\n\n${part}` : part;
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    const res = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: c }) });
    if (!res.ok) return `failed ${res.status}`;
  }
  return "ok";
}

export async function postClickUpComment(taskId: string, text: string): Promise<string> {
  const key = process.env.CLICKUP_API_KEY;
  if (!key) return "skipped (no CLICKUP_API_KEY)";
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ comment_text: text, notify_all: false }),
  });
  return res.ok ? "ok" : `failed ${res.status}`;
}
