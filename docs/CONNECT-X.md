# Connecting your X account (OAuth 2.0)

_Checked against docs.x.com on 2026-10-11. X changes plans and prices — your Developer Console is the source of truth._

## 1. Create and configure the X app

1. Go to **https://developer.x.com** → sign in with the X account you'll send from → **Developer Portal**.
2. Open (or create) a **Project**, then **Add App** inside it.
3. Open the app → **User authentication settings** → **Set up**:
   | Field | Value |
   |---|---|
   | App permissions | **Read and write and Direct Messages** (without this, X won't grant `dm.read`/`dm.write`) |
   | Type of App | **Web App, Automated App or Bot** (confidential client — you get a Client Secret) |
   | Callback URI / Redirect URL | `http://localhost:3100/api/x/callback` — must match **exactly** (scheme, host, port, path) |
   | Website URL | anything valid you own, e.g. your agency site |
4. Save. Open **Keys and tokens** → **OAuth 2.0 Client ID and Client Secret** → copy both. (The Secret is shown once; regenerate it if lost.)
   *Not* the "API Key / Secret" or "Bearer Token" — those are for other auth types.

## 2. Save the credentials in the app (no `.env` editing)

Settings → **X Integration** → *Step 1 · App credentials*:
1. Paste the **Client ID** and **Client Secret** → **Save Credentials**. The secret is encrypted (AES-256-GCM, `CREDENTIALS_ENCRYPTION_KEY`) and is never shown again — the page shows a masked ID and “saved”.
2. **Test Configuration**. It sends X's token endpoint a deliberately invalid code: if X rejects the *client* you'll see “X rejected the Client ID / Client Secret”; if X rejects only the fake code you'll see “X accepted…”. That's strong evidence, not proof — the real proof is step 3.
3. To change one value later, fill in just that field and press **Update Credentials** (blank = keep). Any change disconnects OAuth accounts until you click **Reconnect** (their tokens belong to the old app settings).

`X_CLIENT_ID` / `X_CLIENT_SECRET` in `.env` still work as a fallback when nothing is saved in Settings. Delivery mode is never changed by saving credentials — keep it on **dry run** until a supervised test.

## 3. Connect

1. Open the app at **exactly** `http://localhost:3100` (not `127.0.0.1` — cookies are per-host).
2. Sign out and back in once (the login cookie was changed so it survives X's redirect back).
3. Settings → X Integration → **Continue with X** → approve on X.
4. You land back on Settings with **“X account connected and verified”** and the account card shows:
   `✓ can send DMs` `✓ can read DMs` — then click **Sync DMs** to get `✓ history synced` (automation stays blocked until then).

If something fails, Settings shows what X said and the likely fix. Most common:
| Message | Fix |
|---|---|
| `token_failed … redirect uri did not match` | Callback in the portal ≠ `X_REDIRECT_URI`. Make them identical. |
| `token_failed … unauthorized_client` | Wrong Client ID/Secret, or the secret belongs to another app. |
| `state_missing` | You opened the app on a different host/port than the callback, or took >10 min. |
| `config_changed` | You saved/updated credentials while the X approval page was open — click Continue with X again. |
| `connected_limited` | App permissions aren't “Read and write and Direct Messages”. Change, then **Reconnect**. |
| `me_failed` / 402 / 403 | Your X API plan/credits don't cover this call — check the Developer Console billing page. |

If X's portal won't accept an `http://localhost` callback, use `http://127.0.0.1:3100/api/x/callback`, set `APP_URL`/`X_REDIRECT_URI` to `127.0.0.1`, and open the app at `http://127.0.0.1:3100`. In production use your `https://` domain.

## 4. What your X API access supports

I can't see your account's plan from here. Based on X's public docs:

| Feature | Supported by the official API? | How this app uses it | Cost (pay-per-use) |
|---|---|---|---|
| Send a 1:1 DM | ✅ `POST /2/dm_conversations/with/:id/messages` (`dm.write`) | Automated lane, opted-in recipients only | **$0.015 / message** |
| Read DM history | ✅ `GET /2/dm_events` (`dm.read`) — **last 30 days only** | Detect existing threads, replies, opt-outs | **$0.010 / event read** |
| Look up usernames → IDs | ✅ `GET /2/users/by` (`users.read`) | Stable identity for dedupe | **$0.010 / user** |
| Your own profile | ✅ `GET /2/users/me` | Verify connection | small; billed as a user read |
| Refresh access without re-login | ✅ with `offline.access` (access tokens last 2 h) | Automatic | free |

**Rate limits per account:** 15 sends / 15 min and 1,440 / 24 h; 15 DM-history reads / 15 min. The app self-caps at 12 / 15 min and 1,000 / day.

**What this app spends, and how to control it** (Settings → Campaign defaults & message rules):
| Activity | When | Cost |
|---|---|---|
| Send a DM | each approved message to an opted-in lead | $0.015 each → 20/day ≈ **$9/month** |
| First DM history sync | once per account | up to 500 events → **≤ $5 one-off** |
| Incremental sync | every *DM sync interval* (default **60 min**, min 15) | reads ≤ *page size* (default **20**) events and stops at the first already-seen one → **≤ $0.20 per sync, typically less**; worst case ≈ $144/month at the defaults if you get 20+ new DMs every hour |
| Resolve username → ID | automatically for **opted-in leads only** (default) | $0.010 each; cold leads aren't looked up unless you press *Resolve IDs* or change the scope |
| Per-lead history check | once, right after a lead is resolved | ≤ 10 events → ≤ $0.10 |
| Reconcile an uncertain send | rare (timeouts/crashes) | ≤ 10 events per check |

Set a **spending limit** in the X Developer Console as a hard backstop. *Settings → API usage* shows what this app has sent; X's console is the authoritative bill. X advertises $20 of promotional credits after adding a payment card.

### Not available (and what the app does instead)
| Not possible via the official API | Instead |
|---|---|
| DM history older than 30 days | Shown as “no DM in last 30d” — never “never contacted”. Mark older contacts manually. |
| DMing people whose settings block DMs from you | X returns 403 → `RECIPIENT_RESTRICTED`, never retried |
| Sending cold DMs to people who haven't opted in | Not allowed by X rules → Manual queue (you send on X yourself) |
| Read receipts / unread state from X | App tracks its own unread flag |
| Real-time reply push on pay-per-use | Incremental polling, default every 60 min (webhooks need a higher tier) |
| Logging in with cookies (`auth_token`, `ct0`) | Not supported — OAuth only |
