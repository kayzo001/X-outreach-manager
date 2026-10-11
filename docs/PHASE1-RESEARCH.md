# Phase 1 — X API research & architecture decisions

_Researched 2026-10-11 against docs.x.com. X changes pricing, limits and policy often — re-verify anything marked **verify** in your own Developer Console before going live._

## 1. What the official API actually supports

| Need | Endpoint (official, OAuth 2.0 user context) | Notes |
|---|---|---|
| Send a DM to a user ID | `POST /2/dm_conversations/with/:participant_id/messages` | Body `{ "text": "…" }`. Returns `dm_conversation_id` + `dm_event_id`. |
| Send into an existing conversation | `POST /2/dm_conversations/:dm_conversation_id/messages` | |
| Read DM events | `GET /2/dm_events`, `GET /2/dm_conversations/with/:id/dm_events`, `GET /2/dm_conversations/:id/dm_events` | **Only the last 30 days are available.** |
| Resolve usernames → numeric IDs | `GET /2/users/by?usernames=a,b,c` (≤100) | Needs `users.read`. |
| Token refresh | `POST /2/oauth2/token` (`grant_type=refresh_token`) | Needs `offline.access`. |

**Scopes requested:** `tweet.read users.read dm.read dm.write offline.access` (the minimum for resolve + send + read + refresh). **verify** — the docs page I could load did not enumerate scopes; confirm in the Developer Console.

**Rate limits (docs.x.com/x-api/fundamentals/rate-limits):**

| | per user | per app |
|---|---|---|
| DM create (all three POST endpoints) | 15 / 15 min and 1,440 / 24 h | 1,440 / 24 h |
| DM lookup (GET) | 15 / 15 min | — |

The app stays well under these (hard caps: 12 sends / 15 min, 1,000 / 24 h per account) and honours `x-rate-limit-reset` on any 429.

**Pricing (docs.x.com/x-api/getting-started/pricing):** pay-per-usage credits, no subscription. DM create ≈ **$0.015 / request**, DM event read ≈ **$0.010 / resource**. **verify** whether your account/tier has DM endpoint access and current prices — the page did not state tier requirements. Settings → System shows an estimated send cost.

## 2. Policy — and the design consequence

* X's developer guidelines/automation rules permit automated DMs **only to people who have opted in** (or who DM you first), require an easy opt-out, and say that if someone replies "stop" you must stop. Unsolicited bulk/automated DMs and identical-message blasts are prohibited and can get the app/account suspended.
* I could **not** open X's help-centre automation page (HTTP 403 from the fetcher) — please read https://help.x.com/en/rules-and-policies/x-automation and the Developer Agreement yourself.

**Therefore the app is built as two lanes:**

1. **Automated lane** — only contacts with a *documented* opt-in (source, evidence, scope, timestamp). Every send re-checks consent, history, suppression, rate limits and schedule inside a DB transaction.
2. **Manual lane** — everything else (all CSV imports start here). Suggested message, copy button, open-profile link, "mark contacted". **The app never sends these.** Recording a manual send writes to the same permanent dedupe store.

## 3. Hard limitations (stated plainly, not worked around)

| Limitation | What the app does instead |
|---|---|
| DM history is visible for only **30 days** | Contacts with no thread in the window are labelled **"no DM in last 30d"**, never "never messaged". Automation also requires a DM sync within `historyMaxStaleDays` (default 7). You can mark older contacts manually. |
| X has no idempotency key on DM create | App-side idempotency (unique key per campaign/contact/account), a permanent first-contact ledger, and **UNCERTAIN → reconcile** instead of retry. |
| Recipients may restrict who can DM them | A 403 is classed `RECIPIENT_RESTRICTED`, never retried, counted toward auto-pause. |
| Replies arrive by polling (default every 60 min, configurable) | Webhook delivery needs a higher X tier. Polling is incremental (stops at known events) because X bills per event read. |
| Cannot verify "currently active", follower counts, revenue from X alone | Fields stay blank/unknown and scoring marks the lead *incomplete*. Revenue is `self-reported` unless you mark it `verified` with a source URL. |
| Real X OAuth/send could not be exercised here (no credentials) | Everything was tested against the mock provider + dry-run. Do a supervised first live send (see README §Go live). |

## 4. Architecture

```
 Browser ──HTTPS──► Next.js (web)  ──► PostgreSQL  ◄── source of truth: contacts, ledger, jobs, consent, logs
                        │                  ▲
                        │ poke             │ atomic claim (advisory lock + FOR UPDATE SKIP LOCKED)
                        ▼                  │
                  Redis (BullMQ) ──► Worker process (separate, 24/7)
                  repeatable jobs:     tick 15s · reconcile 60s · resolve 2m · sync (default 60m) · reminders 60s
                                       └─► X API (or mock / dry-run)
```

* **Postgres is the source of truth**, Redis only *wakes* the worker (repeatable schedulers persist in Redis; AOF enabled). Losing Redis can't cause a duplicate send — worst case sends pause until it's back.
* **Send protocol** (all in `src/lib/engine.ts`):
  1. One transaction under a per-campaign advisory lock: kill switch → campaign/account state → schedule gate (window/day/hour/total/batch) → pick job `FOR UPDATE SKIP LOCKED` → per-contact advisory lock → **full eligibility re-check** → insert into `outreach_ledger` (unique `(account, contact)`) → job `SENDING` → advance `nextSendAt`.
  2. Re-read stop conditions, then call X **outside** the transaction.
  3. Outcome → `SENT` / `QUEUED` (429, until reset) / `FAILED` (auth, permanent) / **`UNCERTAIN`** (timeout, 5xx, crash).
  4. `UNCERTAIN` is reconciled by looking up the DM in X; never re-sent. Stale `SENDING` jobs (worker crash) are converted to `UNCERTAIN` by recovery.
* **DB-level guarantees** (migration): partial unique index → only one live job per sender/recipient; unique ledger row per sender/recipient; unique idempotency key; unique normalised username & X ID; CHECK that usernames are lowercase; activity-log rows immutable (UPDATE blocked).
* **Deployment shape:** one image, two roles (web, worker) + managed Postgres + managed Redis. ≈ $20–35 / month on Render or Railway.
