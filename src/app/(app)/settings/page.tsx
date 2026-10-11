import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { queueHealth } from "@/lib/queue";
import { Alert, Badge, Button, Card, CardHeader, Input, Label, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { ActionButton } from "@/components/action-button";
import { XCredentialsPanel, IntegrationStatus } from "@/components/x-credentials";
import { getXCredentialSummary } from "@/lib/x-config";
import { isRealOAuthAccount } from "@/lib/provider";
import { connectDemoAccount, deleteTemplate, disconnectAccount, saveSettings, saveTemplate, setDryRun, setKillSwitch, syncNow, resolveNow, rescoreAll } from "../../actions";
import { ago, dt } from "@/lib/utils";
import { usedVariables } from "@/lib/template";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ x?: string; detail?: string }> }) {
  const sp = await searchParams;
  const [s, accounts, templates, workers, qh, dbOk, usage, failed24] = await Promise.all([
    getSettings(),
    prisma.xAccount.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.messageTemplate.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.workerStatus.findMany({ orderBy: { heartbeatAt: "desc" }, take: 5 }),
    queueHealth(),
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    Promise.all([15 * 60_000, 24 * 3600_000].map((ms) => prisma.messageJob.count({ where: { status: { in: ["SENT", "SENDING", "UNCERTAIN"] }, claimedAt: { gte: new Date(Date.now() - ms) } } }))),
    prisma.messageJob.count({ where: { status: "FAILED", updatedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
  ]);
  const provider = process.env.X_PROVIDER === "x" ? "x" : "mock";
  const creds = await getXCredentialSummary();
  const realAccounts = accounts.filter(isRealOAuthAccount);
  const connected = realAccounts.find((a) => a.status === "ACTIVE");
  const broken = realAccounts.find((a) => a.status !== "ACTIVE" && a.status !== "DISCONNECTED" && a.lastError);
  const integrationStatus: IntegrationStatus =
    !creds.configured ? { label: "Not configured", detail: "Paste the OAuth 2.0 Client ID and Secret from your X developer app." }
    : creds.error ? { label: "Connection error", detail: creds.error }
    : connected ? { label: "Connected", detail: `@${connected.username} completed OAuth ${connected.lastVerifiedAt ? ago(connected.lastVerifiedAt) : ""}.` }
    : broken ? { label: "Connection error", detail: `@${broken.username}: ${broken.lastError}` }
    : creds.lastTestOk === false ? { label: "Connection error", detail: "The last configuration test failed — see below." }
    : { label: "Configured", detail: creds.lastTestOk ? "Test passed. Next: Continue with X." : "Not verified yet — Test Configuration, then Continue with X." };
  const xMsg: Record<string, [string, "success" | "danger" | "warning", string?]> = {
    connected: ["X account connected and verified.", "success"],
    connected_limited: ["Connected, but X did not grant every scope.", "warning", "Missing scopes are listed below. In the developer portal set App permissions to “Read and write and Direct Messages”, then reconnect."],
    denied: ["You cancelled, or X refused the authorisation.", "warning"],
    state_missing: ["The security cookie was missing when X sent you back.", "danger", "Usually the app was opened on a different host/port than the callback URL (e.g. 127.0.0.1 vs localhost), or more than 10 minutes passed. Open the app at the callback’s address and try again."],
    state_mismatch: ["Security check failed (state mismatch).", "danger", "Start again from this page — don’t reuse an old X authorisation tab."],
    state_expired: ["The connection attempt expired (10-minute limit).", "danger", "Click Continue with X again."],
    state_tampered: ["Security check failed.", "danger", "Start again from this page."],
    token_failed: ["X rejected the token exchange.", "danger", "Most common causes: the Client Secret is missing, outdated (X issues a new one when app settings change) or from a different app — or the callback URL in the portal doesn’t exactly match the one below. Re-copy both values from Keys and tokens → OAuth 2.0, click Update Credentials, then Test Configuration."],
    me_failed: ["Connected to X but could not read your profile.", "danger", "Check that the app has users.read and that your X API credits/plan allow user lookups."],
    missing_client: ["No X developer credentials are configured.", "warning", "Paste your Client ID and Client Secret in Settings → X Integration → Step 1, then click Continue with X."],
    config_changed: ["Your X credentials changed while you were on X’s approval page.", "warning", "Nothing was saved. Click Continue with X again to connect with the current credentials."],
    config_error: ["The saved X credentials can’t be used.", "danger", "Re-enter the Client Secret in Step 1."],
    host_mismatch: ["You opened the app on a different address than the callback.", "warning"],
  };

  return (
    <>
      <PageHeader title="Settings" desc="Accounts, safety controls, defaults and system health." />
      {sp.x && xMsg[sp.x] && <div className="mb-4"><Alert tone={xMsg[sp.x][1]} title={xMsg[sp.x][0]}>{xMsg[sp.x][2]}{sp.detail && <div className="mt-1.5 font-mono text-[11px] opacity-80">X said: {sp.detail}</div>}</Alert></div>}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="xl:col-span-2"><CardHeader title="System & emergency controls" desc="Applies instantly to the background worker." />
          <div className="grid gap-5 p-5 md:grid-cols-3">
            <div className={`rounded-lg border p-4 ${s.killSwitch ? "border-destructive/40 bg-destructive/10" : ""}`}>
              <div className="text-sm font-medium">Global emergency stop</div><p className="mt-1 text-xs text-muted-foreground">Halts every automated send, across all campaigns, within seconds. Nothing is lost; release it to resume.</p>
              <div className="mt-3"><ActionButton variant={s.killSwitch ? "success" : "danger"} size="md" label={s.killSwitch ? "Release emergency stop" : "ENGAGE EMERGENCY STOP"} confirmText={s.killSwitch ? undefined : "Stop ALL automated sending now?"} action={setKillSwitch} args={[!s.killSwitch]} /></div></div>
            <div className="rounded-lg border p-4"><div className="text-sm font-medium">Delivery mode</div><p className="mt-1 text-xs text-muted-foreground">Dry run records what <em>would</em> be sent without ever calling X. Live mode transmits for real.</p>
              <div className="mt-3 flex items-center gap-3"><Badge tone={s.dryRun ? "warning" : "danger"}>{s.dryRun ? "DRY RUN" : "LIVE"}</Badge><ActionButton size="md" label={s.dryRun ? "Switch to LIVE" : "Switch to dry run"} confirmText={s.dryRun ? "Go live? Approved messages to opted-in recipients will really be sent." : undefined} action={setDryRun} args={[!s.dryRun]} /></div>
              <p className="mt-2 text-[11px] text-muted-foreground">Provider: <b>{provider}</b>{provider === "mock" ? " (no network)" : ""}</p></div>
            <div className="rounded-lg border p-4"><div className="text-sm font-medium">Health</div>
              <ul className="mt-2 space-y-1.5 text-xs">
                <li className="flex justify-between"><span>Database</span><Badge tone={dbOk ? "success" : "danger"}>{dbOk ? "ok" : "down"}</Badge></li>
                <li className="flex justify-between"><span>Redis / queue</span><Badge tone={qh.ok ? "success" : "danger"}>{qh.ok ? `ok · ${qh.counts.waiting ?? 0} waiting · ${qh.counts.failed ?? 0} failed` : "down"}</Badge></li>
                {workers.map((w) => { const alive = Date.now() - w.heartbeatAt.getTime() < 45_000; const i = (w.info ?? {}) as Record<string, unknown>; return <li key={w.id} className="flex justify-between gap-2"><span className="truncate" title={w.id}>Worker {w.id.slice(-8)}</span><Badge tone={alive ? "success" : "danger"}>{alive ? `online · ${i.ticks ?? 0} ticks` : `silent ${ago(w.heartbeatAt)}`}</Badge></li>; })}
                {!workers.length && <li className="flex justify-between"><span>Worker</span><Badge tone="danger">not running</Badge></li>}
              </ul></div>
            <div className="rounded-lg border p-4 md:col-span-3"><div className="text-sm font-medium">API usage (sends counted by this app)</div>
              <div className="mt-2 flex flex-wrap gap-6 text-sm"><div><div className="text-2xl font-semibold">{usage[0]}</div><div className="text-xs text-muted-foreground">last 15 min · X limit 15</div></div><div><div className="text-2xl font-semibold">{usage[1]}</div><div className="text-xs text-muted-foreground">last 24 h · X limit 1,440</div></div><div><div className="text-2xl font-semibold">${(usage[1] * 0.015).toFixed(2)}</div><div className="text-xs text-muted-foreground">est. send cost, 24 h @ $0.015</div></div><div><div className={`text-2xl font-semibold ${failed24 ? "text-destructive" : ""}`}>{failed24}</div><div className="text-xs text-muted-foreground">failed, 24 h</div></div></div>
              <p className="mt-2 text-[11px] text-muted-foreground">Pricing and limits change — confirm in the X Developer Console. The app stays under 12 sends / 15 min and 1,000 / 24 h per account.</p></div>
          </div></Card>

        <Card className="overflow-hidden xl:col-span-2"><CardHeader title="X Integration" desc="Official OAuth 2.0 (PKCE). Your X password and cookies never touch this app; tokens and the Client Secret are AES-256-GCM encrypted at rest." />
          <div className="grid gap-6 p-5 lg:grid-cols-2">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Step 1 · App credentials</div>
              <XCredentialsPanel summary={creds} status={integrationStatus} />
            </div>

            <div className="space-y-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Step 2 · Connect · Step 3 · Sync</div>
              <div className={`rounded-xl border border-dashed p-5 text-center ${creds.configured && !creds.error ? "" : "opacity-60"}`}>
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-foreground text-xl font-bold text-background">𝕏</div>
                <div className="mt-3 text-sm font-semibold">{realAccounts.some((a) => a.status === "ACTIVE") ? "Connect another account" : "Connect your X account"}</div>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{creds.configured && !creds.error ? "You’ll approve read & send DM access on X, then return here." : "Save your developer credentials first."}</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {creds.configured && !creds.error
                    ? <a className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground px-5 text-sm font-semibold text-background transition hover:opacity-90" href="/api/x/connect"><span className="font-bold">𝕏</span>Continue with X</a>
                    : <span className="inline-flex h-10 cursor-not-allowed items-center gap-2 rounded-md bg-foreground/40 px-5 text-sm font-semibold text-background"><span className="font-bold">𝕏</span>Continue with X</span>}
                  {provider === "mock" && <ActionButton size="md" label="Use demo account" action={connectDemoAccount} />}
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">X app settings: permissions <b>Read and write and Direct Messages</b> · type <b>Web App</b> · callback exactly as shown in Step 1 · open this site at that same address.</p>
              </div>

              {accounts.map((a) => {
                const demo = !isRealOAuthAccount(a);
                const canSend = a.status === "ACTIVE" && (demo || a.scopes.includes("dm.write"));
                const canRead = a.status === "ACTIVE" && (demo || a.scopes.includes("dm.read"));
                const pill = (ok: boolean, label: string) => <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${ok ? "border-success/30 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>{ok ? "✓" : "○"} {label}</span>;
                return (
                  <div key={a.id} className="rounded-xl border bg-gradient-to-br from-primary/10 to-transparent p-4">
                    <div className="flex items-center gap-3">
                      <div className="grid h-11 w-11 place-items-center rounded-full bg-foreground text-lg font-bold text-background">𝕏</div>
                      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-base font-semibold">@{a.username}</span><StatusBadge s={a.status} />{demo && <Badge tone="warning">demo</Badge>}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">Verified {a.lastVerifiedAt ? ago(a.lastVerifiedAt) : "—"} · Last DM sync: {a.lastSyncAt ? ago(a.lastSyncAt) : "never"}{a.rateLimitedUntil && a.rateLimitedUntil > new Date() ? ` · rate-limited until ${dt(a.rateLimitedUntil)}` : ""}</div></div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">{pill(canSend, "can send DMs")}{pill(canRead, "can read DMs")}{pill(!!a.lastSyncAt, "history synced")}{pill(!demo, "real X API")}{pill(!s.dryRun, "live mode")}</div>
                    {a.lastError && <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{a.lastError}</div>}
                    {!demo && a.status === "ACTIVE" && !a.scopes.includes("dm.write") && <div className="mt-2 text-xs text-warning">Missing dm.write — set App permissions to “Read and write and Direct Messages” in the portal, then Reconnect.</div>}
                    <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                      {a.status === "ACTIVE" && <><ActionButton label="Sync DMs" action={syncNow} args={[a.id]} /><ActionButton label="Resolve IDs" action={resolveNow} args={[a.id]} /></>}
                      {!demo && creds.configured && <a className="inline-flex h-8 items-center rounded-md border bg-muted px-2.5 text-xs hover:bg-accent" href="/api/x/connect">Reconnect</a>}
                      {a.status !== "DISCONNECTED" && <ActionButton variant="danger" label="Disconnect" confirmText="Disconnect and wipe stored tokens? Active campaigns will pause." action={disconnectAccount} args={[a.id]} />}
                    </div>
                  </div>);
              })}
              {!accounts.length && <p className="text-center text-xs text-muted-foreground">No X account connected yet.</p>}
            </div>
          </div></Card>

        <Card><CardHeader title="Campaign defaults & message rules" />
          <form action={saveSettings} className="grid gap-3 p-5 sm:grid-cols-2">
            <div><Label>Default timezone</Label><Input name="defaultTimezone" defaultValue={s.defaultTimezone} /></div>
            <div><Label>Default batch size</Label><Input name="defaultBatchSize" type="number" defaultValue={s.defaultBatchSize} /></div>
            <div><Label>Default max / hour</Label><Input name="defaultMaxPerHour" type="number" defaultValue={s.defaultMaxPerHour} /></div>
            <div><Label>Default max / day</Label><Input name="defaultMaxPerDay" type="number" defaultValue={s.defaultMaxPerDay} /></div>
            <div><Label hint="days between any two messages to one person">Contact frequency limit</Label><Input name="contactFrequencyDays" type="number" defaultValue={s.contactFrequencyDays} /></div>
            <div><Label hint="0 = never expires">Opt-in valid for (days)</Label><Input name="consentMaxAgeDays" type="number" defaultValue={s.consentMaxAgeDays} /></div>
            <div><Label hint="DM history must be synced this recently">History freshness (days)</Label><Input name="historyMaxStaleDays" type="number" defaultValue={s.historyMaxStaleDays} /></div>
            <div><Label hint="0–1">Duplicate similarity warning</Label><Input name="duplicateSimilarityThreshold" type="number" step="0.01" defaultValue={s.duplicateSimilarityThreshold} /></div>
            <div><Label hint="min 15 · X bills $0.010 per DM event read">DM sync every (minutes)</Label><Input name="dmSyncIntervalMinutes" type="number" min={15} defaultValue={s.dmSyncIntervalMinutes} /></div>
            <div><Label hint="5–100 · stops early at known events">Events per sync read</Label><Input name="dmSyncPageSize" type="number" min={5} max={100} defaultValue={s.dmSyncPageSize} /></div>
            <div className="sm:col-span-2"><Label hint="$0.010 per username lookup">Automatically resolve X IDs for</Label><Select name="autoResolveScope" defaultValue={s.autoResolveScope}><option value="opted_in">Opted-in leads only (cheapest — the only ones automation can message)</option><option value="campaigns">Leads in non-archived campaigns</option><option value="all">All leads</option></Select>
              <p className="mt-1 text-[11px] text-muted-foreground">Est. worst-case DM-history cost: ~${((24 * 60 / Math.max(15, s.dmSyncIntervalMinutes)) * s.dmSyncPageSize * 0.01 * 30).toFixed(0)}/month per account if every read returned a full page; usually far less because reads stop at known events.</p></div>
            <div className="sm:col-span-2"><Label>Notification email (needs SMTP_URL)</Label><Input name="notifyEmail" type="email" defaultValue={s.notifyEmail ?? ""} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="defaultAllowWeekends" defaultChecked={s.defaultAllowWeekends} />Allow weekends by default</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireTemplateComplete" defaultChecked={s.requireTemplateComplete} />Never send with unresolved variables</label>
            <div className="sm:col-span-2 flex gap-2"><Button variant="primary">Save settings</Button></div>
          </form>
          <div className="border-t px-5 py-3"><ActionButton label="Re-score all leads" action={rescoreAll} /></div></Card>

        <Card className="xl:col-span-2"><CardHeader title="Message templates" desc="Variables: {{first_name}} {{company}} {{product}} {{industry}} {{custom_hook}} {{founder_name}} {{username}}" />
          <div className="grid gap-4 p-5 lg:grid-cols-2">
            {templates.map((t) => (
              <form key={t.id} action={saveTemplate} className="space-y-2 rounded-lg border p-3"><input type="hidden" name="id" value={t.id} />
                <Input name="name" defaultValue={t.name} /><Textarea name="body" rows={4} defaultValue={t.body} />
                <div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">uses: {usedVariables(t.body).join(", ") || "no variables"}</span><div className="flex gap-2"><Button size="sm">Save</Button><ActionButton size="sm" variant="danger" label="Delete" confirmText="Delete template?" action={deleteTemplate} args={[t.id]} /></div></div></form>))}
            <form action={saveTemplate} className="space-y-2 rounded-lg border border-dashed p-3"><div className="text-xs font-medium text-muted-foreground">New template</div>
              <Input name="name" placeholder="e.g. Intro — founders" required /><Textarea name="body" rows={4} required defaultValue={"Hey {{first_name}}, came across {{company}} and wanted to reach out."} /><Button size="sm" variant="primary">Add template</Button></form>
          </div></Card>
      </div>
    </>
  );
}
