import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, Empty, LinkButton, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { pct } from "@/lib/utils";

export default async function Campaigns() {
  const camps = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, include: { xAccount: true, _count: { select: { contacts: true } } } });
  const rows = await Promise.all(camps.map(async (c) => {
    const [sent, failed, replied, done] = await Promise.all([
      prisma.messageJob.count({ where: { campaignId: c.id, status: "SENT" } }),
      prisma.messageJob.count({ where: { campaignId: c.id, status: "FAILED" } }),
      prisma.contact.count({ where: { campaigns: { some: { campaignId: c.id } }, OR: [{ manualStatus: "REPLIED" }, { conversations: { some: { replied: true } } }] } }),
      prisma.campaignContact.count({ where: { campaignId: c.id, contact: { OR: [{ historyStatus: "CONTACTED" }, { doNotContact: true }, { manualStatus: "SKIPPED" }] } } }),
    ]);
    return { c, sent, failed, replied, done };
  }));
  return (
    <>
      <PageHeader title="Campaigns" desc="Independent campaigns share one permanent contact history, so nobody is ever messaged twice." actions={<LinkButton href="/campaigns/new" variant="primary">New campaign</LinkButton>} />
      <Card>
        {!rows.length ? <Empty title="No campaigns yet" desc="Create one, then add leads from the Leads page or an import." action={<LinkButton href="/campaigns/new" variant="primary">Create campaign</LinkButton>} /> : (
          <Table><thead><tr><Th>Campaign</Th><Th>Status</Th><Th>Account</Th><Th>Leads</Th><Th>Sent</Th><Th>Replies</Th><Th>Failed</Th><Th>Progress</Th></tr></thead>
            <tbody>{rows.map(({ c, sent, failed, replied, done }) => { const total = c._count.contacts; const p = total ? Math.round((done / total) * 100) : 0; return (
              <tr key={c.id} className="hover:bg-muted/40">
                <Td><Link href={`/campaigns/${c.id}`} className="font-medium hover:text-primary">{c.name}</Link><div className="max-w-xs truncate text-xs text-muted-foreground">{c.description}</div></Td>
                <Td><StatusBadge s={c.status} />{c.autoPaused && <div className="mt-1 text-[11px] text-warning">auto-paused</div>}</Td>
                <Td className="text-muted-foreground">{c.xAccount ? `@${c.xAccount.username}` : "manual only"}</Td>
                <Td>{total}</Td><Td>{sent}</Td><Td>{replied} <span className="text-xs text-muted-foreground">({pct(replied, sent)})</span></Td><Td className={failed ? "text-destructive" : ""}>{failed}</Td>
                <Td className="w-40"><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${p}%` }} /></div><div className="mt-1 text-[11px] text-muted-foreground">{p}%</div></Td>
              </tr>); })}</tbody></Table>)}
      </Card>
    </>
  );
}
