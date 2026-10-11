import Link from "next/link";
import { prisma } from "@/lib/db";
import { manualWhere } from "@/lib/stats";
import { renderTemplate } from "@/lib/template";
import { Alert, Card, Empty, PageHeader, Select } from "@/components/ui";
import { ManualRow } from "@/components/manual-row";
import { scoreContact } from "@/lib/scoring";
import { cn } from "@/lib/utils";

const PAGE = 25;
const DEFAULT_TEMPLATE = "Hey {{first_name}}, came across {{company}} and wanted to reach out.";

export default async function ManualQueue({ searchParams }: { searchParams: Promise<{ tab?: string; campaign?: string; page?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab === "done" ? "done" : sp.tab === "skipped" ? "skipped" : "open";
  const page = Math.max(1, Number(sp.page) || 1);
  const where = tab === "open" ? { ...manualWhere } : tab === "done" ? { manualStatus: { in: ["CONTACTED" as const, "REPLIED" as const] } } : { manualStatus: "SKIPPED" as const };
  const full = { ...where, ...(sp.campaign ? { campaigns: { some: { campaignId: sp.campaign } } } : {}) };
  const [campaigns, templates, total, contacts] = await Promise.all([
    prisma.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, include: { template: true }, orderBy: { createdAt: "desc" } }),
    prisma.messageTemplate.findMany({ orderBy: { createdAt: "asc" }, take: 1 }),
    prisma.contact.count({ where: full }),
    prisma.contact.findMany({ where: full, include: { score: true, campaigns: { include: { campaign: { include: { template: true } } }, take: 1 } }, orderBy: [{ score: { score: "desc" } }, { createdAt: "asc" }], take: PAGE, skip: (page - 1) * PAGE }),
  ]);
  const selected = campaigns.find((c) => c.id === sp.campaign);
  const fallback = templates[0]?.body ?? DEFAULT_TEMPLATE;
  const items = contacts.map((c) => {
    const camp = selected ?? c.campaigns[0]?.campaign;
    const tpl = camp?.templateBody ?? camp?.template?.body ?? fallback;
    const r = renderTemplate(tpl, c);
    return { id: c.id, username: c.usernameNormalized, founder: c.founderName, company: c.company, score: c.score?.score ?? scoreContact(c).score, incomplete: c.score?.incomplete ?? true, message: r.text, missing: r.missing, campaignId: camp?.id ?? null, manualStatus: c.manualStatus };
  });
  const tabs = [["open", "To contact"], ["done", "Contacted / replied"], ["skipped", "Skipped"]] as const;
  const q = (o: Record<string, string>) => `/queue/manual?${new URLSearchParams({ ...(sp.campaign ? { campaign: sp.campaign } : {}), ...o })}`;
  return (
    <>
      <PageHeader title="Manual outreach queue" desc="Cold leads — no opt-in needed to prepare or work them. You send each DM yourself on X; the app drafts, de-duplicates and records it." actions={<Link href={`/queue/manual/focus${sp.campaign ? `?campaign=${sp.campaign}` : ""}`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground glow">▶ Start focus mode</Link>} />
      <Alert tone="primary" title="Fastest way through a big list: Focus mode">One lead at a time with keyboard shortcuts (C copy · O open profile · M mark contacted · S skip), daily target and batch tracking. Everything you mark is recorded in the same permanent history the automation uses, so no one is messaged twice.</Alert>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {tabs.map(([k, l]) => <Link key={k} href={q({ tab: k })} className={cn("rounded-md px-3 py-1.5 text-sm", tab === k ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}>{l}</Link>)}
        <form className="ml-auto"><input type="hidden" name="tab" value={tab} /><Select name="campaign" defaultValue={sp.campaign ?? ""} className="h-8 w-56" onChange={undefined}><option value="">All campaigns</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select><button className="ml-2 text-xs text-primary">Filter</button></form>
      </div>
      <Card className="mt-3">
        {items.length ? items.map((i) => <ManualRow key={i.id} item={i} />) : <Empty title={tab === "open" ? "Queue is empty" : "Nothing here"} desc={tab === "open" ? "Import leads, or record consent to move people into automation." : undefined} />}
        {total > PAGE && <div className="flex justify-between px-4 py-3 text-xs text-muted-foreground"><span>{total.toLocaleString()} total · page {page}</span><div className="flex gap-3">{page > 1 && <Link className="text-primary" href={q({ tab, page: String(page - 1) })}>← Prev</Link>}{page * PAGE < total && <Link className="text-primary" href={q({ tab, page: String(page + 1) })}>Next →</Link>}</div></div>}
      </Card>
    </>
  );
}
