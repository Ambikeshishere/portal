# PW Analytics Ticket Portal

A fast, serverless rebuild of the PW Analytics Ticket Portal. The original
front-end (design + behaviour) is preserved exactly; the backend was moved off
Google Sheets onto **Vercel serverless functions + Turso (libSQL)**, while all
email (OTP + workflow notifications) is still sent through a dedicated
**Google Apps Script mail service** using the PW internal Gmail account.

```
Browser (index.html + js/ui.js)
        │  POST {api, token, payload}  (text/plain, JSONP fallback)
        ▼
Vercel serverless function  ──►  Turso (libSQL)   ← all portal data
   api/index.js → lib/routes.js
        │
        │  POST {key, base, mails:[…]}   (batch, never throws)
        ▼
Google Apps Script Web App  ──►  Gmail (OTP, notifications, digests)
   (ref-script-2/)  ▲
        │           │  GET /api/cron/{drain,reminders,sla,cleanup}
        └───────────┘  (time-driven triggers ping the backend)
```

## Why this architecture

| Concern | Old | New |
|---|---|---|
| Data store | Google Sheets (slow, ~5M cell limits) | Turso libSQL (fast, scales to 500+ users) |
| API | Apps Script `doPost` | Vercel serverless function |
| Email | Apps Script `MailApp` | Apps Script mail service (unchanged sender) |
| Scheduling | Apps Script triggers | Apps Script triggers → ping Vercel cron endpoints |

The front-end contract is **byte-for-byte identical** to the old backend:
`POST {api, token, payload}` → `{ok:true, data}` / `{ok:false, error}`, sent as
`Content-Type: text/plain` with a JSONP `?callback=` GET fallback. All API
errors return HTTP 200 (the UI reads the `ok` flag).

## Repository layout

```
portal/
  api/index.js        Vercel entry point: routes /api, /api/health, /api/cron/*
  lib/
    config.js         env-driven config (no secrets in code)
    db.js             Turso/libSQL client, q()/run()/sha256()/nextId()
    schema.sql        all tables (snake_case)
    settings.js       roles, DEFAULT_CONFIG, cfg()/cfgNum(), SLA due dates
    helpers.js        now(), randomToken(), randomOtp(), normEmail(), …
    auth.js           signup, requestOtp, verifyOtp, sessions
    tickets.js        create/list/get/assign/updateStatus/close/reopen/rate/comment/dashboard
    approvals.js      request / getInfo / decide (tokenised email links)
    reassign.js       request / list / decide
    admin.js          users, clusters, analysts, analytics, activity, CSV export
    jobs.js           cron: drainMailQueue, dailyReminders, hourlySlaCheck, cleanupExpired
    mail.js           posts mail batches to the Apps Script mail service
    routes.js         PUBLIC_API + PRIVATE_API map with role guards
    setup.js          one-time schema + seed (admin user, Admin cluster, config)
  dev/server.js       local dev server (static + /api)
  test/smoke.js       USER flow smoke test (19 assertions)
  test/smoke2.js      CBA/ANALYST/ADMIN flow smoke test (33 assertions)
  index.html          front-end (unchanged design)
  js/config.js        API_URL = '/api'
  js/api.js           transport (POST + JSONP fallback)
  js/ui.js            all UI logic (unchanged)
  styles.css          styles (unchanged)
  vercel.json         /api/* → serverless function
```

> The Google Apps Script **mail service** is a separate Apps Script project
> (deployed independently with `clasp`). It is not part of this repo because it
> holds the shared `MAIL_KEY` / `CRON_SECRET` and is version-controlled by Apps
> Script itself. Its files are `Config.js`, `Code.js`, `Templates.js`,
> `Triggers.js`, `appsscript.json`.

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (Production):

| Name | Purpose |
|---|---|
| `DB_URL` | Turso database URL, e.g. `libsql://<db>-<org>.aws-ap-south-1.turso.io` |
| `DB_AUTH_TOKEN` | Turso auth token |
| `MAIL_SCRIPT_URL` | Apps Script Web App URL (ends with `/exec`) |
| `MAIL_KEY` | Shared secret; must match `MAIL_KEY` in `ref-script-2/Config.js` |
| `CRON_SECRET` | Shared secret; must match `CRON_SECRET` in `ref-script-2/Config.js` |
| `PORTAL_BASE_URL` | Public portal URL, e.g. `https://pw-ticket-portal.vercel.app` |

`lib/config.js` reads all of these from the environment — **no secrets are
committed to the repo**. For local development, copy `.env.example` to
`.env.local` and fill it in (`.env.local` is git-ignored).

## Local development

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # runs test/smoke.js + test/smoke2.js (mail is stubbed)
```

The smoke tests spin up a throwaway `file:` libSQL database, stub the mail
service, and exercise the full API surface — no network, no real email.

## Deployment

1. **Turso** — create a database, then initialise the schema + seed by running
   `ensureSetup()` once against it (the first API request does this
   automatically).
2. **Vercel** — import this repo, set the env vars above, deploy.
3. **Apps Script** — in `ref-script-2/Config.js` set `BACKEND_URL` to the Vercel
   URL, `clasp push -f`, then run `installTriggers()` once from the editor.

## API surface

**Public** (no session): `signup`, `requestOtp`, `verifyOtp`, `getClusters`,
`getApproval`, `decideApproval`.

**Private** (session + role guard): `logout`, `me`, `createTicket`,
`listTickets`, `getTicket`, `addComment`, `assignTicket`, `updateStatus`,
`closeTicket`, `reopenTicket`, `rateTicket`, `myAnalysts`, `myActivity`,
`requestApproval`, `requestReassign`, `listReassign`, `decideReassign`,
`teamWorkload`, `clusterAnalysts`, `saveAnalyst`, `removeAnalyst`,
`adminUsers`, `adminSaveUser`, `adminClusters`, `adminSaveCluster`,
`adminAnalytics`, `adminActivity`, `adminMailQueue`, `adminExportCsv`,
`dashboard`.

**Cron** (guarded by `x-cron-secret`): `GET /api/cron/drain`,
`/api/cron/reminders`, `/api/cron/sla`, `/api/cron/cleanup`.

## Roles

| Role | Can do |
|---|---|
| `USER` | Raise tickets, comment, close/reopen/rate own tickets |
| `CBA` | Everything a USER can, plus assign tickets, request approvals, manage cluster analysts, decide reassignments |
| `ANALYST` | Work assigned tickets, update status, request reassignment |
| `ADMIN` | Everything, plus users, clusters, analytics, activity, CSV export |

## Security notes

- OTPs, session tokens, and approval tokens are stored as plain values
  (no hashing or salt).
- Signup is locked to the `ALLOWED_DOMAIN` (`pw.live`).
- Signup always creates a `USER`; elevated roles are granted only by an admin.
- Cron endpoints reject requests without the correct `x-cron-secret`.
- Secrets live only in Vercel env vars and the Apps Script project — never in
  this repo.

## Migration notes

- The original GitHub repo and the old Apps Script project are **untouched**.
- The front-end (`index.html`, `styles.css`, `js/ui.js`) is copied verbatim;
  only `js/config.js` changed (`API_URL: '/api'`).
- All response shapes were ported 1:1 from the old Apps Script backend so the
  UI needs no changes.
