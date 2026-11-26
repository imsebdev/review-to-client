// scripts/check-v2-payload.mjs
// Loads the live page and the v2 page in jsdom with the same fake card, makes the same choices
// on both, and compares the exact bytes each page sends to /api/feedback, /api/upload and,
// on the fallback paths, the Zapier hook. Must print ALL SCENARIOS IDENTICAL before any v2 deploy.
//   npm i --no-save jsdom@24 && node scripts/check-v2-payload.mjs
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2] || new URL("..", import.meta.url).pathname;
const G = await import(pathToFileURL(path.join(repo, "public/pitch/v2/groups.mjs")).href);
const LIVE = fs.readFileSync(path.join(repo, "public/pitch/index.html"), "utf8");
const V2 = fs.readFileSync(path.join(repo, "public/pitch/v2/index.html"), "utf8")
  // jsdom can't do dynamic import(); hand the page the same module directly
  .replace("G = await import('/pitch/v2/groups.mjs');", "G = window.__G;");
if (V2.includes("await import('/pitch/v2/groups.mjs')")) throw new Error("patch failed");

const ORIGIN = "https://review.test";
const NAMES = [
  "xtra-coop-v40-mvk1.png", "xtra-coop-v40-mvk3.png", "xtra-coop-v40-mvk2.png", "xtra-coop-v40-mvk10-old",
  "Stora-Coop_V48 - Jul- 70x100 - Skyllt.jpg", "Bl%C3%B6mk%C3%A5l LABEL.png", "X-TRA - Veckoboost 40.zip",
  "Manus_Veckoboost_X-tra.xlsx", "cx_2640_mandag_grund_s1-8_godkand_Original.pdf",
];
const PREVIEW = NAMES.map((n, i) => `${ORIGIN}/api/file/TEST123/att${i}/${n.includes("%") ? n : encodeURIComponent(n)}`).join(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, html, file, scenario) {
  const log = [];
  const vc = new VirtualConsole(); // keep page noise out
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) log.push("jsdomError: " + e.message); });
  const dom = new JSDOM(html, {
    url: `${ORIGIN}/${file}?taskId=TEST123${scenario.query || ""}`,
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.__G = G;
      w.Element.prototype.scrollTo = function () {};
      w.Element.prototype.scrollIntoView = function () {};
      w.confirm = () => true; w.alert = () => {};
      const fixed = "2026-11-26T18:00:00.000Z";
      w.Date.prototype.toISOString = function () { return fixed; };
      w.HTMLFormElement.prototype.submit = function () {
        const fields = Array.from(this.querySelectorAll("input")).map((i) => [i.name, i.value]);
        log.push({ to: "zapier-form", action: this.action, fields });
      };
      w.fetch = async (url, init = {}) => {
        const u = new URL(url, ORIGIN);
        const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
        if (u.pathname === "/api/pitch-data") return json({ ok: true, data: { taskId: "TEST123", client: "Test Client AB", created: "1795182599319", framerLink: "", preview: PREVIEW } });
        if (u.pathname === "/api/task") return json({ message: "Hej! Test.", companyName: "Testbolaget – V48" });
        if (u.pathname === "/api/upload") {
          const fd = init.body; const entries = [];
          for (const [k, v] of fd.entries()) entries.push([k, typeof v === "string" ? v : `FILE:${v.name}:${v.type}:${v.size}`]);
          log.push({ to: "upload", entries });
          return json({ success: true, uploaded: 1, failed: [] });
        }
        if (u.pathname === "/api/feedback") {
          log.push({ to: "feedback", headers: init.headers, keepalive: init.keepalive, body: init.body });
          return scenario.feedbackFails ? json({ ok: false }, 502) : json({ ok: true });
        }
        log.push("unexpected fetch " + u.pathname);
        return json({}, 404);
      };
    },
  });
  const w = dom.window, d = w.document;
  await sleep(300); // init + /api/task

  // reviewer name remembered from an earlier visit
  // (the localStorage prefill runs on DOMContentLoaded; set the field directly like a returning visitor)
  d.getElementById("reviewerName").value = "Anna Test";
  d.getElementById("comments").value = "Byt färg på rubriken, tack!\nRad två.";

  // pick designs by file name, in this click order
  const designs = [...d.querySelectorAll('input[type="checkbox"]')];
  const fullName = (cb) => { const l = d.querySelector(`label[for="${cb.id}"]`); const sp = l.querySelector("span[title]"); return sp ? sp.title : l.textContent.trim(); };
  const byName = (n) => designs.find((cb) => fullName(cb) === n);
  for (const n of scenario.picks) {
    const cb = byName(n);
    if (!cb) throw new Error(`${label}: no design called ${n}. Have: ${designs.map(fullName).join(", ")}`);
    cb.click();
  }

  d.querySelector(`.radio-option input[value="${scenario.decision}"]`).closest(".radio-option").click();

  if (scenario.upload) {
    const f = new w.File([new Uint8Array(2048)], "referens.png", { type: "image/png" });
    const input = d.getElementById("fileUpload");
    Object.defineProperty(input, "files", { value: [f], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await sleep(50);
  }

  d.getElementById("submitBtn").click();
  await sleep(900);
  const success = d.getElementById("successScreen").classList.contains("visible");
  const error = d.getElementById("errorMessage").classList.contains("visible") ? d.getElementById("errorMessage").textContent : "";
  dom.window.close();
  return { log, success, error, designCount: designs.length };
}

const scenarios = [
  { name: "approve, 2 picks, upload, default path", decision: "approve", picks: ["xtra-coop-v40-mvk3.png", "xtra-coop-v40-mvk1.png"], upload: true, query: "&test=1" },
  { name: "revise, no picks, default path", decision: "revise", picks: [], query: "" },
  { name: "decline, ?direct=0 (straight to Zapier)", decision: "decline", picks: ["Stora-Coop_V48 - Jul- 70x100 - Skyllt.jpg"], query: "&direct=0" },
  { name: "approve, feedback route fails -> Zapier fallback", decision: "approve", picks: ["Blömkål LABEL.png", "xtra-coop-v40-mvk10-old"], feedbackFails: true, query: "&test=1" },
  { name: "approve with 0 picks -> validation error", decision: "approve", picks: [], query: "" },
];

let allSame = true;
for (const sc of scenarios) {
  const a = await run("live", LIVE, "pitch/index.html", sc);
  const b = await run("v2", V2, "pitch/v2/index.html", sc);
  const ja = JSON.stringify(a.log), jb = JSON.stringify(b.log);
  const same = ja === jb && a.success === b.success && a.error === b.error;
  allSame &&= same;
  console.log(`\n${same ? "SAME" : "DIFFERENT"}  ${sc.name}`);
  console.log(`  success screen: live=${a.success} v2=${b.success}${a.error || b.error ? `  error: live="${a.error}" v2="${b.error}"` : ""}`);
  for (const e of a.log) console.log("  live sent:", typeof e === "string" ? e : JSON.stringify(e).slice(0, 400));
  if (!same) for (const e of b.log) console.log("  v2   sent:", typeof e === "string" ? e : JSON.stringify(e).slice(0, 400));
}
console.log(allSame ? "\nALL SCENARIOS IDENTICAL" : "\nDIFFERENCES FOUND");
process.exit(allSame ? 0 : 1);
