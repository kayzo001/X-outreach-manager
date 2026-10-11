# Deploy to Render (runs 24/7, laptop off)

What you get: web app + background worker + Postgres + Redis, ≈ **$20/month**
(web $7, worker $7, Postgres ~$6, Key Value free). Secrets are generated automatically by Render.

## 1. Put the code on GitHub (2 min)
1. Go to https://github.com/new → name `x-outreach-manager` → **Private** → don't add a README → Create.
2. In Terminal, in this folder:
   ```
   git remote add origin https://github.com/<your-username>/x-outreach-manager.git
   git push -u origin main
   ```
   (GitHub will ask you to sign in the first time.)

## 2. Create the services on Render (5 min + ~10 min build)
1. https://render.com → sign up with GitHub → add a payment card (Billing).
2. Dashboard → **New → Blueprint** → select `x-outreach-manager`. Render reads `render.yaml`.
3. It asks for:
   * `ADMIN_EMAIL` / `ADMIN_PASSWORD` — the login for your deployed app (password 10+ chars).
   * `ANTHROPIC_API_KEY` — optional, leave blank.
4. **Apply**. Wait until `xom-web` and `xom-worker` show **Live**. On first boot the web service runs database migrations and creates your login automatically.

## 3. Connect X in the deployed app
1. Open the `xom-web` URL (e.g. `https://xom-web.onrender.com`) and sign in.
2. developer.x.com → your app → **User authentication settings** → add a second callback:
   `https://<your-xom-web-url>/api/x/callback` (exactly as shown in Settings → X Integration → Callback URL). Keep the localhost one if you still use it locally.
3. Settings → X Integration → paste **Client ID** + **Client Secret** → **Save** → **Test Configuration** → **Continue with X** → **Sync DMs**.

## 4. Load your data
The cloud database starts empty. **Import CSV** again, then on each campaign use **Add leads from your CSV imports**.

## 5. Go live (only when ready)
Delivery mode starts as **dry run**. Automated DMs only go to leads with a documented opt-in; everyone else is in the **Manual Queue**. Switch to live in Settings → System after a supervised test.

## Updating later
`git commit` + `git push` → Render redeploys both services automatically. Migrations run on boot.

## If something fails
* Build fails → Render → `xom-web` → Logs → copy the error.
* `/api/health` shows `db:false` or `redis:false` → the database/Key Value service isn't ready yet; wait or check its page.
* Login loop → make sure you open the `https://` URL.
* Backups: Render Postgres has daily backups on paid plans; you can also run `npm run db:backup` with the external connection string.
