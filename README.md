# X Outreach Manager

A consent-aware DM campaign manager for X. Import CSVs of founders, organise and score them, run **automated delivery only to people who opted in** through the official X API, and manage everyone else through a **manual outreach queue** — with one permanent contact history so nobody is ever messaged twice.

> **Connecting X:** step-by-step guide, what your API access supports and what it costs → [docs/CONNECT-X.md](docs/CONNECT-X.md).
>
> Read [docs/PHASE1-RESEARCH.md](docs/PHASE1-RESEARCH.md) first: it states what the X API can and cannot do, the pricing/limits found, and the policy that shapes the design.

## What's inside

| Area | Highlights |
|---|---|
| **Import** | CSV/XLSX drag-and-drop · auto header mapping + manual mapping · `@`/URL → username · case-insensitive dedupe (in-file **and** in-DB) · preview with total/valid/new/existing/duplicate/invalid · download rejected rows · server-side chunked staging (10,000 rows ≈ 5 s, tested) · never overwrites history · CSV "consent" columns are **never** treated as consent |
| **Never-twice engine** | Permanent first-contact ledger · unique constraints (live job per pair, ledger per pair, idempotency key, username, X ID) · advisory-lock atomic claim · `UNCERTAIN` state + reconciliation · crash recovery · same protection for manual sends |
| **Consent** | unknown / not opted-in / opted-in / expired / opted-out · source, evidence (required), scope, account, expiry · opt-out keyword detection on replies · permanent suppression list |
| **Campaigns** | unlimited · draft/active/paused/completed/archived · create/edit/duplicate (config only — history never resets)/pause/resume/**stop** · approval gate · export results |
| **Scheduling** | timezone, start/end date, weekdays, weekends, holiday list, window, per-hour/day/campaign caps, batch size, message & batch delays, error limit + auto-pause — deterministic (no jitter) |
| **Worker** | separate 24/7 process · BullMQ repeatable jobs · heartbeat · 429 backoff to `x-rate-limit-reset` · no retry of auth/permanent errors · **global emergency stop** |
| **Inbox** | DM sync (30-day API window) · reply detection · auto-cancel pending messages on reply · unread/status/tags/notes · notifications (+ optional email) · reminders |
| **Leads** | AND/OR filter builder + saved presets · lead score 0–100 with per-factor explanation and "incomplete data" flag · self-reported vs verified MRR · tags · per-lead eligibility explanation |
| **Analytics** | dashboard stats, messages/replies by day, campaign performance, funnel, by-category, date range, CSV exports |
| **Security** | bcrypt login + signed httpOnly SameSite=Strict session · Redis rate limiting · Origin (CSRF) check · AES-256-GCM token encryption · secrets scrubbed from logs · CSV formula-injection-safe exports · security headers · data erasure |
| **Safety modes** | **Dry-run** (never calls `sendDm`; verified by tests) · mock X provider · kill switch |

## Run it locally (Mac/Linux)

Prereqs: Node 20+, PostgreSQL 14+, Redis 6+ (or `docker compose up`, see below).

```bash
npm install
cp .env.example .env              # then edit — see "Environment variables"
openssl rand -hex 32              # → ENCRYPTION_KEY
openssl rand -base64 48           # → SESSION_SECRET
createdb xom
npm run db:migrate                # applies prisma/migrations
npm run db:seed                   # creates the owner login from ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev                       # web on :3000
npm run worker                    # in a 2nd terminal — the background engine
```

With `X_PROVIDER=mock` and `DRY_RUN=true` (the defaults) nothing ever touches X: Settings → **Connect demo account**, then import `samples/founders-300.csv` (`npm run sample:csv` regenerates it).

### See a dry run end-to-end
With web + worker running: `npm run demo:dryrun`. It resolves usernames (mock), records documented opt-ins for 10 leads, starts a campaign, and watches the real worker process it. Expected: `10 dry-run jobs · 0 messages transmitted · 0 jobs for the cold lead`.

### Tests
```bash
createdb xom_test && DATABASE_URL=postgresql://localhost:5432/xom_test npx prisma migrate deploy
npm test        # 95 tests against a real Postgres: normalisation, dedupe, DB constraints, scheduling,
                # pause/resume, kill switch, consent, opt-out, 429, failures, restarts, concurrent
                # workers, reply sync, reconciliation, 10k import, and the 300-row acceptance scenario
```

## Deploy (24/7, laptop off)

Architecture = **web** + **worker** (same Docker image) + **Postgres** + **Redis**. Both web and worker need the same env vars.

### Option A — Render (blueprint included) — step-by-step: [docs/DEPLOY.md](docs/DEPLOY.md)
1. Push this folder to a private GitHub repo.
2. Render → **New → Blueprint** → pick the repo (`render.yaml` creates web, worker, Postgres, Redis).
3. In the dashboard set the `sync: false` variables (below). Generate secrets locally with the `openssl` commands above — **never paste them in chat or commit them**.
4. After first deploy, open the **web** service shell and run `npm run db:seed` once to create your login.
5. Keep `DRY_RUN=true` until you've completed "Go live" below.

### Option B — Railway
1. New project → **Deploy from GitHub repo** (uses the `Dockerfile`). Add **PostgreSQL** and **Redis** plugins.
2. Duplicate the service: service 1 start command default (web), service 2 start command `npm run worker`.
3. Reference `DATABASE_URL`/`REDIS_URL` from the plugins and add the other variables to both services (no volume needed — all state lives in Postgres/Redis).
4. Run `npm run db:seed` once in the web service shell.

### Option C — one VPS
`docker compose up -d --build` (Postgres + Redis with AOF + web + worker). Put Caddy/nginx in front for HTTPS. Set `POSTGRES_PASSWORD` in your shell.

> The Dockerfile/compose/render files were written but **not built here** (Docker isn't installed on the machine this was developed on). The app itself builds and runs with `next build` / `npm run worker`.

### Environment variables
| Var | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres / Redis (Redis must use `noeviction`) |
| `APP_URL` | public https URL of the web service |
| `ENCRYPTION_KEY` | 64 hex chars; encrypts OAuth tokens. **Losing it = reconnecting the X account** |
| `SESSION_SECRET` | 32+ chars; signs login cookies |
| `CREDENTIALS_ENCRYPTION_KEY` | 64 hex chars; encrypts the X Client Secret you save in Settings. Keep it separate from `ENCRYPTION_KEY`; if it changes you must re-enter the secret |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | owner login (used by `db:seed`; use a long passphrase) |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | **optional fallback** — normally you paste these in Settings → X Integration (database wins) |
| `X_REDIRECT_URI` | `https://<APP_URL>/api/x/callback` (defaults to `APP_URL` + that path) |
| `X_PROVIDER` | provider for the **demo** account only (`mock`/`x`). Accounts connected via OAuth always use the real X API |
| `DRY_RUN` | initial default only; the Settings toggle overrides it |
| `ANTHROPIC_API_KEY` | optional AI drafting (always human-reviewed) |
| `SMTP_URL`, `NOTIFY_EMAIL` | optional email notifications |

## Connect X
1. https://developer.x.com → create a Project + App. Enable **OAuth 2.0**, type *Web App / confidential client*, permissions **Read and write and Direct Messages**.
2. Callback URL: `https://<your-domain>/api/x/callback` (must match `X_REDIRECT_URI` exactly).
3. Put Client ID/Secret into the host's env vars, set `X_PROVIDER=x`, redeploy.
4. Settings → **Connect X account** → authorise → **Sync DMs** (this unlocks automation: history must be fresh).
5. Check your plan/credits cover DM endpoints (see research doc).

## Go live (do this in order)
1. `DRY_RUN` on. Import a small list, record opt-ins for **yourself or a friend's test account** (with their permission), start a campaign. Review the dry-run queue.
2. Turn dry-run off (Settings → Delivery mode). Keep **approval required** on. Send 1–3 messages, check them on X, check Activity Logs.
3. Raise limits gradually. Watch Settings → API usage and the failure categories. If anything looks wrong, hit **Emergency stop**.

## Operations
* **Health:** `GET /api/health` (DB + Redis) — point an uptime monitor at it. Settings → System shows worker heartbeat, queue counts, DB status.
* **Logs:** worker writes JSON lines to stdout; hosts capture them. Business events are in Activity Logs (append-only; secrets scrubbed).
* **Backups:** `npm run db:backup` (pg_dump custom format, keeps 30). Schedule it (Render cron job / GitHub Action / `cron`) **and** enable your host's managed Postgres backups. The contact ledger + consent records are what protect you — treat them as critical. Restore: `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" file.dump`.
* **If the worker dies:** nothing is lost; on restart stale `SENDING` jobs become `UNCERTAIN` and are reconciled against X before anything else happens.
* **Upgrading:** deploy → `prisma migrate deploy` runs automatically on web start.
* **Data deletion:** lead page → *Erase all data* (keeps only the bare username on the suppression list).

## Design decisions worth knowing
* **Imports ≠ consent.** Everything imported is `unknown` → manual lane.
* **"No history found" ≠ "never contacted"** — X only exposes 30 days.
* **`batchDelayMax` is a ceiling, not randomisation:** the scheduler always uses the *min* delay (deterministic). No jitter, proxies, or account rotation anywhere.
* Editing a campaign's template affects *future* drafts; already-drafted messages keep the text you approved.
* Per-lead custom messages: `message` column on import, or **Draft with Claude → Use as message**, or edit in the approval queue.
* Campaigns don't auto-complete while leads still need your action (e.g. consent); use **Mark complete**.

## Layout
```
prisma/            schema + migration (incl. hand-written partial unique index & constraints)
src/lib/engine.ts  planner · atomic claim · send · outcomes · recovery · reconciliation · tick
src/lib/eligibility.ts  the single gate for automated sends
src/lib/provider/  X client, mock provider, dry-run wrapper
src/lib/import.ts  staged, chunked CSV/XLSX import
worker/index.ts    BullMQ worker process
src/app/           12 pages + API routes + server actions
tests/             vitest suite (real Postgres)
```
