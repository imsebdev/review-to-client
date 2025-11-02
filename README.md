# Client Review – Minimal Starter

This is a tiny Next.js app that generates **unique client review pages** and sends decisions back to ClickUp via Zapier.

## What’s here
- `GET /t/[taskId]` — public review page (reads `title`, `client`, `due`, `preview` from query params)
- `POST /api/reply` — forwards form submission to your **Zapier Catch Hook** (`ZAPIER_WEBHOOK_URL`)
- `POST /api/generate` — returns a signed URL for a taskId (use from Zapier in your “Client review” trigger)

> MVP keeps it simple: no DB. Add a KV/DB later if you want persistent storage.

---

## Deploy on Vercel (free)

1. Create a new GitHub repo and upload these files.
2. Go to **vercel.com → Add New Project → Import from GitHub**.
3. In **Environment Variables**, set:
   - `ZAPIER_WEBHOOK_URL` = your Zapier “Catch Hook” URL
   - `HMAC_SECRET` = any long random string (for signing URLs)
   - `PUBLIC_BASE_URL` = `https://your-vercel-domain.vercel.app` (once you have it)
4. Deploy.

### Local dev
```
npm i
npm run dev
```
Open http://localhost:3000/t/86c5w3c3p?title=Homepage%20V2&client=SpiderAds&due=2025-11-07&preview=https://images.unsplash.com/photo-1522202176988-66273c2fd55f?q=80&w=1200

---

## Zapier wiring

### Zap A — ClickUp → Generate link → Update task
- Trigger: ClickUp Task Updated (status becomes “Client review”)
- Action: Webhooks → POST `https://your-vercel-domain.vercel.app/api/generate`
  - JSON: `{ "taskId": "<ClickUp Task ID>", "title": "<Task Name>", "client": "<Client field>", "due":"<Due date>", "preview":"<Image URL>" }`
- Action: ClickUp → Update Task → set **Client Review Link** = `url` from previous step

### Zap B — Webhook Catch → ClickUp
- Trigger: Zapier **Catch Hook** (put the URL in `ZAPIER_WEBHOOK_URL`)
- Actions:
  - ClickUp → Add Comment (Task = `taskId`) with `decision/notes`
  - ClickUp → Update Task (if decision = approve → Approved; else → Revisions)

---

## Notes
- The review page uses **query params**; you can add more (e.g., multiple previews).
- `/api/generate` creates a signed link with 30-day expiry (`sig` + `exp` params).
- To add multiple images, pass `preview` as a comma-separated string and split in the page.
