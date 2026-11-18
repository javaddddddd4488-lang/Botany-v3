# Botanical Research Database (v3 — Cloudflare D1)

## Setup
```bash
npm install
npx wrangler login
npx wrangler d1 create botany-db          # copy the printed database_id into wrangler.jsonc
npm run db:migrate:remote                 # creates tables + full-text index
npx wrangler secret put MEMBER_PASSWORD   # long passphrase (12+ chars)
npx wrangler secret put ADMIN_PASSWORD    # a DIFFERENT long passphrase
npm run deploy
```
`SESSION_SECRET` and the KV namespace are no longer used (sessions are stored server-side in D1).

Local dev: copy `.dev.vars.example` to `.dev.vars`, run `npm run db:migrate:local`, then `npm run dev`.

## Excel import
The workbook is parsed in the admin's browser (SheetJS, served from `/vendor`), then uploaded as validated
JSON chunks. The new dataset is staged and swapped in atomically, so a failed import never damages the live data.
Limits: 15 MB file, 50,000 rows, 200 columns, 5,000 characters per cell.

## Backups
D1 Time Travel restores the database to any point in the last 30 days:
`npx wrangler d1 time-travel info botany-db` / `restore botany-db --timestamp=...`.
Also keep the original Excel files.

## Strongly recommended
Put the site behind **Cloudflare Access** (Zero Trust, free for up to 50 users) and add a WAF rate-limiting rule on `/api/login`.
