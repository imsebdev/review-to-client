// lib/checker/website.ts
//
// Reads a client's website (Company url, Source links on the card) as plain text, so the
// general checker can verify brand spelling, offers, prices, phone numbers and tone.
// Cached for a week per URL — sites change slowly and the check shouldn't pay twice.

import { createHash } from "crypto";
import { Redis } from "@upstash/redis";

export type SitePage = { url: string; title: string; text: string; error?: string };

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 9000;
const SKIP = /(facebook|instagram|linkedin|tiktok|figma|youtube|x\.com|twitter|clickup|vercel\.app|drive\.google|dropbox)\./i;

function kv(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

export function normalizeUrl(raw: string): string | null {
  const s = raw.trim().replace(/[)\].,;]+$/, "");
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/\./.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Website-ish links from a text (description, custom fields). Social, Figma and our own tools are skipped. */
export function siteLinks(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.match(/https?:\/\/[^\s"'<>()\]]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:se|fi|no|dk|com|eu|nu|io|net|org|ax)(?:\/[^\s"'<>()\]]*)?/gi) ?? []) {
      const u = normalizeUrl(m);
      if (u && !SKIP.test(u) && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ({ aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö", eacute: "é", uuml: "ü" } as Record<string, string>)[n] ?? m);

/** HTML → readable text: title, meta description, then the body with block breaks kept. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const metas = Array.from(html.matchAll(/<meta[^>]+(?:name|property)=["'](description|og:title|og:description)["'][^>]*>/gi))
    .map((m) => decode(m[0].match(/content=["']([^"']*)["']/i)?.[1] ?? ""))
    .filter(Boolean);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/a)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = decode(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1);
  // drop repeated lines (menus repeated in header + footer)
  const seen = new Set<string>();
  const uniq = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  return { title, text: Array.from(new Set(metas)).join("\n") + "\n" + uniq.join("\n") };
}

async function fetchPage(url: string): Promise<SitePage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ImSebContentChecker/1.0; +https://imseb.com)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "sv,fi,no,en;q=0.8",
      },
    });
    if (!res.ok) return { url, title: "", text: "", error: `HTTP ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (!/html|text/i.test(type)) return { url, title: "", text: "", error: `not a web page (${type})` };
    const buf = new Uint8Array(await res.arrayBuffer());
    const html = new TextDecoder("utf-8").decode(buf.slice(0, MAX_BYTES));
    const { title, text } = htmlToText(html);
    if (text.replace(/\s/g, "").length < 200) return { url, title, text, error: "almost no text (the site may need JavaScript)" };
    return { url, title, text: text.slice(0, MAX_TEXT) };
  } catch (e: any) {
    return { url, title: "", text: "", error: e?.name === "AbortError" ? "timed out" : String(e?.message ?? e).slice(0, 100) };
  } finally {
    clearTimeout(timer);
  }
}

export async function readSite(url: string): Promise<SitePage> {
  const store = kv();
  const key = `aicheck:site:${createHash("sha1").update(url).digest("hex")}`;
  if (store) {
    const hit = await store.get<SitePage>(key).catch(() => null);
    if (hit) return hit;
  }
  const page = await fetchPage(url);
  if (store && !page.error) await store.set(key, page, { ex: 60 * 60 * 24 * 7 }).catch(() => null);
  return page;
}
