import Link from "next/link";
import { prisma } from "@/lib/db";
import { buildWhere, filterSchema } from "@/lib/filters";
import { Card, PageHeader, LinkButton } from "@/components/ui";
import { FilterBar } from "@/components/leads/filter-bar";
import { LeadsTable } from "@/components/leads/leads-table";

const PAGE = 50;
export default async function Leads({ searchParams }: { searchParams: Promise<{ f?: string; page?: string }> }) {
  const sp = await searchParams;
  let def = filterSchema.parse({});
  try { if (sp.f) def = filterSchema.parse(JSON.parse(sp.f)); } catch { /* ignore bad filter */ }
  const where = buildWhere(def);
  const page = Math.max(1, Number(sp.page) || 1);
  const [total, contacts, presets, campaigns] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE, include: { score: true, tags: { include: { tag: true } }, conversations: { select: { replied: true } }, _count: { select: { campaigns: true } } } }),
    prisma.savedFilter.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const rows = contacts.map((c) => ({
    id: c.id, username: c.usernameNormalized, founder: c.founderName, company: c.company, industry: c.industry, mrr: c.mrr, mrrKind: c.mrrKind, consent: c.consentStatus, history: c.historyStatus,
    customer: c.customerStatus, dnc: c.doNotContact, replied: c.manualStatus === "REPLIED" || c.conversations.some((v) => v.replied), score: c.score?.score ?? null, incomplete: c.score?.incomplete ?? true, tags: c.tags.map((t) => t.tag.name), campaigns: c._count.campaigns,
  }));
  const filterJson = JSON.stringify(def);
  const pages = Math.ceil(total / PAGE);
  const link = (p: number) => `/leads?${new URLSearchParams({ ...(sp.f ? { f: sp.f } : {}), page: String(p) })}`;
  return (
    <>
      <PageHeader title="All leads" desc={`${total.toLocaleString()} lead${total === 1 ? "" : "s"} · one identity per X account, shared across every campaign.`} actions={<LinkButton href="/import" variant="primary">Import CSV</LinkButton>} />
      <FilterBar initial={def as never} presets={presets.map((p) => ({ id: p.id, name: p.name, definition: p.definition as never }))} campaigns={campaigns} />
      <Card><LeadsTable rows={rows} total={total} campaigns={campaigns} filterJson={filterJson} />
        {pages > 1 && <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground"><span>Page {page} of {pages}</span><div className="flex gap-3">{page > 1 && <Link className="text-primary" href={link(page - 1)}>← Prev</Link>}{page < pages && <Link className="text-primary" href={link(page + 1)}>Next →</Link>}</div></div>}</Card>
    </>
  );
}
