import { overviewStats, dailySeries, campaignPerformance, funnel, byIndustry, parseRange } from "@/lib/stats";
import { Button, Card, CardHeader, Input, PageHeader, StatCard } from "@/components/ui";
import { CampaignBars, DailyChart, Funnel, IndustryBars } from "@/components/charts";
import { fmt, pct } from "@/lib/utils";

export default async function Analytics({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const r = parseRange(sp, 30);
  const [s, daily, perf, fun, ind] = await Promise.all([overviewStats(r), dailySeries(r), campaignPerformance(), funnel(), byIndustry()]);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return (
    <>
      <PageHeader title="Analytics" desc="Message volume, replies and conversion across campaigns."
        actions={<form className="flex items-center gap-2"><Input type="date" name="from" defaultValue={iso(r.from)} className="h-9 w-40" /><span className="text-muted-foreground">→</span><Input type="date" name="to" defaultValue={iso(r.to)} className="h-9 w-40" /><Button>Apply</Button><a className="inline-flex h-9 items-center rounded-md border bg-muted px-3 text-sm hover:bg-accent" href={`/api/export/messages?from=${iso(r.from)}`}>Export messages</a></form>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Messages sent (range)" value={fmt.format(s.sent)} sub={`${s.sentAuto} automated · ${s.sentManual} manual`} /><StatCard label="Reply rate" value={pct(s.replied, s.contactedPeople)} sub={`${s.replied} of ${s.contactedPeople} contacted`} tone="primary" />
        <StatCard label="Positive reply rate" value={pct(s.interested, s.replied)} sub={`${s.interested} interested`} /><StatCard label="Customers" value={fmt.format(s.customers)} tone="success" />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title="Messages by day" /><div className="p-4"><DailyChart data={daily} series="sent" /></div></Card>
        <Card><CardHeader title="Replies by day" /><div className="p-4"><DailyChart data={daily} series="replies" /></div></Card>
        <Card><CardHeader title="Campaign performance" /><div className="p-4">{perf.length ? <CampaignBars data={perf} /> : <p className="py-10 text-center text-sm text-muted-foreground">No campaigns yet.</p>}</div></Card>
        <Card><CardHeader title="Conversion funnel" desc="Imported → Qualified (score ≥ 40) → Eligible → Contacted → Replied → Interested → Customer" /><div className="p-5"><Funnel data={fun} /></div></Card>
        <Card className="lg:col-span-2"><CardHeader title="Performance by SaaS category" /><div className="p-4">{ind.length ? <IndustryBars data={ind} /> : <p className="py-10 text-center text-sm text-muted-foreground">Add industries to your leads to see this.</p>}</div></Card>
      </div>
    </>
  );
}
