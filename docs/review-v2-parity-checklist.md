# Review page v2: feature-parity checklist

Source of truth: `public/pitch/index.html` on `main` @ e3d1500 (frozen, not to be edited).
v2 target: `public/pitch/v2/index.html` (served at `/pitch/v2/index.html?taskId=…`).
Line numbers below refer to the live page.

Status 26 Nov 2026: built in `public/pitch/v2/index.html` + `public/pitch/v2/groups.mjs`; payload verified identical with `scripts/check-v2-payload.mjs`.

Legend: [ ] = to build in v2 · (keep) = copy behaviour as-is · (change) = deliberate v2 change from the build plan · (ask) = needs Seb's call

## A. Data loading
- [ ] (keep) Read `?taskId=`; default `DEMO-123` when missing (L350).
- [ ] (keep) Fetch `/api/pitch-data?taskId=` (Redis `pitch:<id>`); its `preview` URLs already come rewritten to `/api/file/<task>/<att>/<name>` (L355–361).
- [ ] (keep) Fall back to URL params `client`, `created`, `preview`, `framerLink` when Redis has nothing (L365–368). Cheap to keep, and harmless.
- [ ] (keep) Treat `framerLink` values `null` / `undefined` / blank as empty (L370).
- [ ] (keep) Date formatting: epoch ms → `sv-SE` long date; ISO string → same; else shown raw (L375–380).
- [ ] (keep) Live fetch `/api/task?taskId=` after first render: `message` → banner; `companyName` → overrides project name **and** `taskData.client` (which goes into the payload) (L417–433).
- [ ] (keep) Demo fallback: 5 Unsplash images when there are no files at all (L399–407).
- [ ] (keep) Stealth updates need no client code: the page re-reads Redis on every load and `/api/file` hands out a fresh signed ClickUp URL per request. v2 gets this for free by using the same two routes.

## B. File sorting (where v2 changes the most)
Live rule (L321–396): split on file extension only.
- hidden: `xls xlsx xlsm csv numbers`
- download cards: `zip rar 7z gz tar pdf`
- everything else → image (slideshow + pick grid)
- both lists sorted by the **last number in the file name** only (L326).

v2 rule (build plan §3):
- [ ] (change) Group by group word: `MVK, LABEL, POSTER, PRINT, BANNER, BACKUP, CAROUSEL, STORY, REEL, FLYER, TABLE`, one list in one place in the code. Legacy matches: `SKYLT`/`SKYLLT`/`70x100` → POSTER, `ETIKETT` → LABEL, `Frilagda priser` → LABEL.
- [ ] Matching must be case-insensitive and work without separators: real names include `xtra-coop-v48-mvk6.jpg` and `…_MVK7.jpg`. Reuse the regexes in `lib/checker/files.ts#classify` so the page and the AI checker agree.
- [ ] (change) Exclude `.xlsx`/sheets (as today), the Tally flyer PDF (`^[a-z]{2}_\d{4}_.*\.pdf`, same regex as `classify`), and `.zip` except `BANNER` zips. **Today the live page offers the flyer PDF and old zips as downloads; v2 stops that.**
- [ ] (change) No group word on any file → one "Alla filer" group. Some files grouped, others not → those go to "Övrigt" (team warning comes later with Språkkoll/checker, not shown to the client).
- [ ] Sort within a group by trailing number (same as today), so `_01`–`_05` keep their order.

## C. Slideshow ("Designförhandsvisning") + lightbox
Live (L202–222, L482–520):
- [ ] (keep) Counter "FIL x AV y".
- [ ] (keep) Prev/next arrows (hidden when only 1 file), thumbnails, click thumbnail → jump.
- [ ] (keep) Click the big image → lightbox; click backdrop or × closes it.
- [ ] (keep) Keyboard: ← / → change slide, Esc closes lightbox.
- [ ] (keep) Stage shows the original file (full quality).
- [ ] (change) Group chips (Alla + one per non-empty group; no chips when only one group), counter "FIL 3 AV 30 · 3 av 10 i MVK", thumbnail rows labelled per group, caption (name, type, size, "Ladda ner den här filen"), labels on dark-green backdrop, non-image files as a file card with a download button, stage up to ~76vh. UI copied from the "Zip-knappar prototyp" artifact.
- **Decided:** no file sizes in the caption for now (would cost one ClickUp request per file).

## D. Framer embed
- **Decided (Seb, 26 Nov): removed from v2.** Never used. The live page keeps it.

## E. Downloads
Live (L224–228, L449–459): one card per zip/pdf with "⬇ Ladda ned", `download target=_blank`.
- [ ] (change) "Ladda ner" block directly under the slideshow: "Ladda ner alla som zip" + one zip button per group; a single-file job gets just one "Ladda ner" button. Single-file downloads keep using `/api/file/…` links like today.
- **Decided:** zip buttons hidden until `/api/zip` exists (`ZIP_ENABLED = false` in the page). Until then the section lists the files the slideshow can't show (PDF, banner zips, video); images download one by one from the caption button.

## F. PDF / print
Live (L216–221, L523–579):
- [ ] (keep) "Spara som PDF" button: loads jsPDF 2.5.1 from cdnjs, fetches each design through `/api/proxy` (CORS-safe), A4 portrait, 10 mm margin, one image per page, progress overlay "Genererar PDF… / Bearbetar bild x av y", file name `SpiderAds-Pitch-<client>-<taskId>.pdf`, alerts on 0 images / partial failure. Hidden when there are no designs.
- Note: the `@media print` CSS (L11–25) references `.print-pages`, which is never filled, so Ctrl+P prints an almost empty page today. "Print" in practice = the jsPDF button. v2: keep the button, leave out the dead print CSS. (ask if real browser printing is wanted)
- [ ] v2 decision: which files go into the PDF: all images, or only the current group? Default: all images, like today.

## G. Pick grid ("Välj designer att gå vidare med")
Live (L240–246, L582–596):
- [ ] (keep) Card per image: checkbox + file name + thumbnail; clicking the thumbnail opens the lightbox; selected card highlighted.
- [ ] (keep) Counter "✅ Du har valt x av y designer", highlighted when > 0.
- [ ] (keep) Selection order = click order (JS `Set`); this order ends up in `selectedDesigns`.
- [ ] (change) Grouped grid + "Ladda ner valda som zip" bar when something is selected (bar depends on `/api/zip`).
- [ ] **Payload safety:** the value sent for each pick must stay `decodeURIComponent(last path segment of the URL)`, the same string as today (L340–342, L411).
- **Decided:** images only, as today.
- Display-only change: tiles show the part of the name that differs ("MVK_1080x1080_01.jpg"); the full name is in the tooltip and in the payload.

## H. Decision form
Live (L250–288, L599–663):
- [ ] (keep) **Three** options: Godkänn ✅ / Revidera 🔄 / Avböj ❌ (the handoff only mentions approve/revise, but decline exists and must stay).
- [ ] (keep) "👤 Ditt namn (obligatoriskt)": max 80 chars, `autocomplete=name`, prefilled from `localStorage['reviewerName']`, saved on successful validation. **Same key in v2** so returning clients get the name prefilled on both pages.
- [ ] (keep) Comment box (always visible) + live "N tecken" counter.
- [ ] (keep) Validation, in this order, with these exact texts: no decision → "Välj ett beslut (Godkänn, Revidera eller Avböj)"; approve with 0 picks → "Välj minst en design att godkänna"; name < 2 chars → "Skriv ditt namn så vi vet vem som svarat" (+ focus). Error box hides when a decision is clicked.
- [ ] (keep) Buttons "SKICKA BESLUT" / "ÅTERSTÄLL" (**decided:** reset confirm now Swedish: "Vill du verkligen återställa formuläret?"). Status line "Status: Väntar på ditt svar".

## I. Image upload with feedback
Live (L271–280, L610–645, L665–713, L724–750):
- [ ] (keep) "📎 Bifoga bilder (valfritt)", `accept=image/*`, multiple; rejects non-images ("Välj endast bildfiler") and > 25 MB.
- [ ] (keep) Preview tiles with name, size, × remove.
- [ ] (keep) On submit: resize in the browser (keep ≤ 1.5 MB jpeg/png/webp/gif as-is; else JPEG at 2000/0.85 → 1600/0.75 → 1200/0.7 until ≤ 4 MB, white background).
- [ ] (keep) One file per POST to `/api/upload` with `taskId, fileCount=1, skipComment=1, comments, decision, file_0`; 2 attempts; button shows "LADDAR UPP BILD n AV m...".
- [ ] (keep) Uploaded files are removed from the list (no double upload on retry); failures → confirm dialog (send without / cancel and show error).

## J. Submit + webhook payload (must be byte-identical)
Live (L753–810):
- [ ] (keep) Payload object, **same keys in the same order**:
  `taskId, client, reviewer, company, decision, selectedDesigns, comments, fileCount, attachedFiles, failedFiles, timestamp`
  - `client` = `reviewerName + (taskData.client ? ' (' + taskData.client + ')' : '')`
  - `reviewer` = name; `company` = `taskData.client || ''`
  - `selectedDesigns` = picked file names joined with `', '` (via the array → join step)
  - `fileCount` = number of uploaded images (a number in JSON); `attachedFiles` / `failedFiles` = names joined with `', '`
  - `timestamp` = `new Date().toISOString()`
- [ ] (keep) Default path: JSON POST to `/api/feedback` with `direct: 'true'` added (+ `test: '1'` when the page has `?test=1`), `keepalive: true`.
- [ ] (keep) If `/api/feedback` fails → delete `direct`/`test` and post the same fields as a hidden form to the Zapier hook `hooks.zapier.com/hooks/catch/24121388/uivwvnj/` (PITCH zap).
- [ ] (keep) `?direct=0` → skip the route, go straight to Zapier.
- [ ] (keep) Success screen after 500 ms regardless of the response (fire-and-forget).
- **Note for Seb:** the live page already sends to `/api/feedback` in direct mode by default; the Zapier PITCH zap only gets the payload as a fallback or with `?direct=0`. Both paths must keep the same payload, and the plan is to copy `submitReview` / `sendToWebhook` / `legacyWebhookPost` into v2 unchanged, with a script that compares the two pages' payloads on the same inputs.

## K. Success screen
- [ ] (keep) Main card hidden; "✅ BESLUT SKICKAT", thank-you text, "Din referens: TASK <id>".

## L. Header / chrome
- [ ] (keep) SpiderAds logo SVG, "TASK: <id>" badge, title "PITCH FÖRHANDSVISNING", "Projekt: <name> - Review" (strips `http(s)://` and trailing `/`; falls back to "SpiderAds"), "Skapad: <date>".
- [ ] (keep) "💬 MEDDELANDE FRÅN SPIDERADS" banner, only when there is a message.
- [ ] (keep) Inter font, dark gradient theme, mobile breakpoint at 768 px (single-column grid, stacked buttons, 600 px Framer).

## M. Small fixes v2 can include without changing behaviour
- Escape file names before putting them into `innerHTML` (live page injects them raw in L455, L585, L628). **Decided: yes.**
- No dead print CSS.

## N. Things v2 must NOT do
- Edit `public/pitch/index.html` or any existing route under `app/api/`.
- Change the `/pitch/index.html` link built by `save-pitch` / `send-to-seller` (that becomes the env-var switch in build step 5).
- Touch real client cards. (The X:-TRA V40 card 123kvxea315 is a real job in Incoming Jobs: read-only. Its file names are copied into the test data instead.) Test only on test cards, using `?test=1` (Slack → test webhook, comment not assigned). Note that direct mode still sets the ClickUp status on the test card.

## Test setup needed for build step 4
- A test list + test card with sample files (group-word names, an old-style card without group words, a flyer PDF + manus xlsx to check they are hidden).
- A `pitch:<testTaskId>` record in Redis: `/api/send-to-seller?taskId=<test>&test=1` writes it without overwriting existing records, and emails only `EMAIL_TEST_TO`.
