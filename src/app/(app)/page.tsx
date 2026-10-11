import Link from "next/link";
import { prisma } from "@/lib/db";
import { overviewStats, dailySeries, campaignPerformance, funnel, parseRange } from "@/lib/stats";
import { Card, CardHeader, StatCard, PageHeader, LinkButton, Alert, Badge } from "@/components/ui";
import { CampaignBars, DailyChart, Funnel } from "@/components/charts";
import { ago, fmt, pct } from "@/lib/utils";
import { getSettings } from "@/lib/settings";

export default async function Overview() {
  const range = parseRange({}, 14);
  const [s, daily, perf, fun, settings, accounts, recent, reminders, notes] = await Promise.all([
    overviewStats(), dailySeries(range), campaignPerformance(), funnel(), getSettings(),
    prisma.xAccount.findMany({ where: { status: "ACTIVE" } }),
    prisma.activityLog.findMany({ orderBy: { at: "desc" }, take: 8 }),
    prisma.reminder.findMany({ where: { done: false, dueAt: { lte: new Date(Date.now() + 86_400_000) } }, include: { contact: true }, orderBy: { dueAt: "asc" }, take: 5 }),
    prisma.notification.findMany({ where: { read: false }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  return (
    <>
      <PageHeader title="Overview" desc="Everything across your imported leads, campaigns and conversations."
        actions={<><LinkButton href="/import" variant="secondary">Import CSV</LinkButton><LinkButton href="/campaigns/new" variant="primary">New campaign</LinkButton></>} />
      <div className="mb-6 space-y-3">
        {!accounts.length && <Alert tone="primary" title="Connect your X account">Automated delivery needs an authorised X account. Cold leads still work through the manual queue. <Link className="underline" href="/settings">Open settings →</Link></Alert>}
        {settings.dryRun && <Alert tone="warning" title="Dry-run mode is on">The worker records what it would send but never transmits anything to X. Switch to live mode in Settings → System when you are ready.</Alert>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatCard label="Imported rows" value={fmt.format(s.imported)} sub="across all files" />
        <StatCard label="Unique leads" value={fmt.format(s.unique)} />
        <StatCard label="Eligible for automation" value={fmt.format(s.eligible)} sub="documented opt-in" tone="success" />
        <StatCard label="Manual review queue" value={fmt.format(s.manual)} sub="no opt-in on file" tone="warning" />
        <StatCard label="Messages sent" value={fmt.format(s.sent)} sub={`${s.sentAuto} auto · ${s.sentManual} manual`} />
        <StatCard label="Scheduled" value={fmt.format(s.scheduled)} sub={`${s.activeCampaigns} active campaign${s.activeCampaigns === 1 ? "" : "s"}`} />
        <StatCard label="Replies" value={fmt.format(s.replied)} tone="primary" />
        <StatCard label="Reply rate" value={pct(s.replied, s.contactedPeople)} sub={`of ${s.contactedPeople} contacted`} />
        <StatCard label="Interested" value={fmt.format(s.interested)} />
        <StatCard label="Positive reply rate" value={pct(s.interested, s.replied)} />
        <StatCard label="Opt-outs / DNC" value={fmt.format(s.optOuts)} tone={s.optOuts ? "warning" : undefined} />
        <StatCard label="Failed deliveries" value={fmt.format(s.failed)} tone={s.failed ? "danger" : undefined} sub={`${s.customers} customers`} />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Messages — last 14 days" /><div className="p-4"><DailyChart data={daily} series="sent" /></div></Card>
        <Card><CardHeader title="Conversion funnel" /><div className="p-5"><Funnel data={fun} /></div></Card>
        <Card className="lg:col-span-2"><CardHeader title="Campaign performance" />
          <div className="p-4">{perf.length ? <CampaignBars data={perf} /> : <p className="py-10 text-center text-sm text-muted-foreground">No campaigns yet.</p>}</div></Card>
        <Card>
          <CardHeader title="Needs attention" right={<Badge>{notes.length + reminders.length}</Badge>} />
          <ul className="divide-y text-sm">
            {notes.map((n) => <li key={n.id} className="px-5 py-3"><div className="font-medium">{n.title}</div>{n.body && <div className="truncate text-xs text-muted-foreground">{n.body}</div>}<div className="text-[11px] text-muted-foreground">{ago(n.createdAt)}</div></li>)}
            {reminders.map((r) => <li key={r.id} className="px-5 py-3"><div className="font-medium">{r.kind} — @{r.contact.usernameNormalized}</div><div className="text-[11px] text-muted-foreground">due {ago(r.dueAt)}</div></li>)}
            {!notes.length && !reminders.length && <li className="px-5 py-8 text-center text-xs text-muted-foreground">All clear.</li>}
          </ul>
        </Card>
      </div>
      <Card className="mt-4"><CardHeader title="Recent activity" right={<Link href="/logs" className="text-xs text-primary hover:underline">View all</Link>} />
        <ul className="divide-y text-sm">{recent.map((l) => <li key={l.id} className="flex items-center gap-3 px-5 py-2.5"><span className={`h-1.5 w-1.5 rounded-full ${l.level === "error" ? "bg-destructive" : l.level === "warn" ? "bg-warning" : "bg-success"}`} /><span className="flex-1 truncate">{l.message}</span><span className="text-xs text-muted-foreground">{ago(l.at)}</span></li>)}
          {!recent.length && <li className="px-5 py-8 text-center text-xs text-muted-foreground">No activity yet.</li>}</ul></Card>
    </>
  );
}
