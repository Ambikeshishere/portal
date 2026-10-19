# PW Analytics Ticket Portal

A fast, serverless rebuild of the PW Analytics Ticket Portal. The original
front-end (design + behaviour) is preserved exactly; the backend was moved off
Google Sheets onto **Vercel serverless functions + Turso (libSQL)**, while all
email (workflow notifications, digests) is still sent through a dedicated
**Google Apps Script mail service** using the PW internal Gmail account.

Sign-in uses **Firebase Auth (Google)**: the browser gets an ID token from the
Google popup, the backend verifies it locally (RS256 against Google's JWKS) and
resolves the role from the `users` table — known `ANALYST`/`CBA`/`ADMIN` emails
keep their role, unknown `pw.live` emails are auto-provisioned as `USER`
(admins grant elevated roles later from the web admin panel). The old
email-OTP APIs remain available as a fallback.

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
    db.js             Turso/libSQL client, q()/run()/nextId()
    schema.sql        all tables (snake_case)
    settings.js       roles, DEFAULT_CONFIG, cfg()/cfgNum(), SLA due dates
    helpers.js        now(), randomToken(), randomOtp(), normEmail(), …
    auth.js           signup, requestOtp, verifyOtp, loginWithFirebase, sessions
    firebase.js       Firebase ID-token verification (RS256 + Google JWKS, no deps)
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
  test/smoke2.js      CBA (Manager)/ANALYST/ADMIN flow smoke test (33 assertions)
  test/coverage.js    every exported function across lib/ (163 assertions)
  index.html          front-end: Google sign-in card (no self-signup form)
  js/config.js        API_URL + FIREBASE web config placeholders
  js/api.js           transport (POST + JSONP fallback)
  js/ui.js            all UI logic (Google sign-in wiring)
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
| `FIREBASE_PROJECT_ID` | Firebase project id (Google sign-in audience/issuer checks) |

`lib/config.js` reads all of these from the environment — **no secrets are
committed to the repo**. For local development, copy `.env.example` to
`.env.local` and fill it in (`.env.local` is git-ignored).

## Local development

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # smoke.js + smoke2.js + coverage.js (mail is stubbed)
```

The tests spin up a throwaway `file:` libSQL database, stub the mail service,
and exercise the full API surface — no network, no real email (Firebase tokens
are unit-tested with crafted RS256 JWTs against an injected test key).

## Firebase (Google sign-in) setup

1. **Firebase console** → your project → *Authentication*. If this is the first
   time, click **Get started** (this provisions Firebase Auth for the project —
   without it every sign-in call fails with `auth/configuration-not-found`).
   Then *Sign-in method → Google* → enable it, set the support email.
2. *Authentication → Settings → Authorized domains* → add `localhost` and
   `pw-ticket-portal.vercel.app`.
3. *Project settings → Your apps → SDK setup → Config* → copy the
   `firebaseConfig` values into `js/config.js` (`FIREBASE: { apiKey, authDomain,
   projectId, appId }`). The "Continue with Google" button only works once this
   is filled in.
4. Set `FIREBASE_PROJECT_ID` in `.env.local` (and in Vercel env vars) to the
   same project id. The backend verifies ID tokens locally — no Firebase
   server SDK, no extra npm dependencies.

Roles are **always** read from the `users` table at login time: an email
already saved as `ANALYST`/`CBA`/`ADMIN` keeps that role, everything else is
provisioned as `USER` (with a welcome email; its cluster/phone/department can
be filled in later from the admin *Users* screen).

## Deployment

1. **Turso** — create a database, then initialise the schema + seed by running
   `ensureSetup()` once against it (the first API request does this
   automatically).
2. **Vercel** — import this repo, set the env vars above, deploy.
3. **Apps Script** — in `ref-script-2/Config.js` set `BACKEND_URL` to the Vercel
   URL, `clasp push -f`, then run `installTriggers()` once from the editor.

## API surface

**Public** (no session): `signup`, `requestOtp`, `verifyOtp`,
`loginWithFirebase`, `getClusters`, `getApproval`, `decideApproval`.

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

The `CBA` role is a cluster's **Manager** — the UI labels it `Manager`
everywhere (role dropdown, user/cluster tables, ticket timeline, analytics).

| Role | Can do |
|---|---|
| `USER` | Raise tickets, comment, close/reopen/rate own tickets |
| `CBA` (**Manager**) | Everything a USER can, plus take any ticket in their own cluster for themselves, resolve it directly, close it (even someone else's), assign analysts, request approvals, manage cluster analysts, decide reassignments |
| `ANALYST` | Work assigned tickets, update status, request reassignment |
| `ADMIN` | **Every right**: take any ticket in any cluster for themselves, assign to any manager/analyst, resolve or close any ticket, plus users, clusters, analytics, activity, CSV export |

## Deadlines & SLA

- Default due date comes from the priority: `High` = `SLA_HIGH_HRS` (24h),
  `Medium` = `SLA_MED_HRS` (72h), `Low` = `SLA_LOW_HRS` (168h).
- **Raise a ticket** has an optional **Deadline (date & time)** field. Fill it
  in to fix a custom deadline (SLA) for that ticket; `createTicket` accepts the
  extra `dueAt` (UTC ISO) key. Leave it blank to keep the priority SLA.
- A manual deadline must be a real date-time in the future. It is stored in
  `tickets.due_at`, drives the SLA badge (`ON_TRACK`/`DUE_SOON`/`BREACHED`) and
  the hourly SLA job, and shows up in the ticket timeline as `DEADLINE_SET`.

## Theme (light / dark / auto)

The topbar has a three-way switch (`☀` light, `🌙` dark, `◐` auto); the choice is
kept in `localStorage` under `pw_theme` and `auto` is the default.

`auto` follows the clock like the macOS dynamic wallpaper: the page sits on a
full-screen `.sky` layer whose gradient is interpolated per hour —
night black → sunrise yellow (06:00) → noon white (12:00) → sunset amber
(17:30) → black again by 20:00. The light/dark palette flips with it
(`dawn`/`day`/`dusk` render light, `night` renders dark), and a 60s timer
re-checks so it changes on its own without a reload. On the shell the topbar and
sidebar go translucent over the wallpaper so it stays visible behind the cards.

Preview any time of day from the browser console:

```js
__setAutoHour(18.5)  // 6:30pm — amber sunset
__setAutoHour(2)     // 2am — black night
__setAutoHour(null)  // back to the real clock
```

Sample renders of all four day-parts are in `theme-preview/`.

## Security notes

- Sign-in goes through Firebase (Google) ID tokens: the backend checks the
  RS256 signature against Google's JWKS, the issuer/audience against
  `FIREBASE_PROJECT_ID`, expiry, and `email_verified`, then enforces
  `ALLOWED_DOMAIN` (`pw.live`).
- OTPs, session tokens, and approval tokens are stored as plain values
  (no hashing or salt).
- Signup is locked to the `ALLOWED_DOMAIN` (`pw.live`).
- There is no self-signup form in the UI: a new @pw.live Google account is
  auto-provisioned as `USER` on first sign-in.
- Elevated roles are granted only by an admin
  (or preserved for emails the admin already entered with a role).
- Inactive accounts are rejected at login.
- Cron endpoints reject requests without the correct `x-cron-secret`.
- Secrets live only in Vercel env vars and the Apps Script project — never in
  this repo.

## Migration notes

- The original GitHub repo and the old Apps Script project are **untouched**.
- The front-end (`index.html`, `styles.css`, `js/ui.js`) is copied verbatim;
  only `js/config.js` changed (`API_URL: '/api'`).
- All response shapes were ported 1:1 from the old Apps Script backend so the
  UI needs no changes.
