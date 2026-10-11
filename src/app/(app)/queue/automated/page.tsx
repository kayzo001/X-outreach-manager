import Link from "next/link";
import { prisma } from "@/lib/db";
import { Alert, Badge, Card, Empty, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ApprovalBar, JobRowActions } from "@/components/job-actions";
import { ago, cn, dt } from "@/lib/utils";
import type { JobStatus } from "@prisma/client";

const TABS: [string, string, JobStatus[]][] = [
  ["approval", "Awaiting approval", ["PENDING_APPROVAL"]], ["scheduled", "Scheduled", ["QUEUED", "SENDING"]], ["unconfirmed", "Unconfirmed", ["UNCERTAIN"]],
  ["sent", "Sent", ["SENT"]], ["failed", "Failed", ["FAILED"]], ["dry", "Dry run", ["DRY_RUN"]], ["other", "Skipped / cancelled", ["SKIPPED", "CANCELLED"]],
];
const PAGE = 30;

export default async function AutomatedQueue({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const sp = await searchParams;
  const tab = TABS.find((t) => t[0] === sp.tab) ?? TABS[0];
  const page = Math.max(1, Number(sp.page) || 1);
  const [counts, jobs, total] = await Promise.all([
    prisma.messageJob.groupBy({ by: ["status"], _count: true }),
    prisma.messageJob.findMany({ where: { status: { in: tab[2] } }, orderBy: { updatedAt: "desc" }, take: PAGE, skip: (page - 1) * PAGE, include: { contact: true, campaign: true } }),
    prisma.messageJob.count({ where: { status: { in: tab[2] } } }),
  ]);
  const count = (s: JobStatus[]) => counts.filter((c) => s.includes(c.status)).reduce((a, b) => a + b._count, 0);
  return (
    <>
      <PageHeader title="Automated delivery queue" desc="Only recipients with a documented opt-in appear here. Each message is re-checked against consent, history and suppression at the moment it would send." actions={tab[0] === "approval" ? <ApprovalBar ids={jobs.map((j) => j.id)} /> : null} />
      <div className="mb-3 flex flex-wrap gap-1">{TABS.map(([k, l, s]) => <Link key={k} href={`/queue/automated?tab=${k}`} className={cn("rounded-md px-3 py-1.5 text-sm", tab[0] === k ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}>{l} <span className="ml-1 text-xs opacity-70">{count(s)}</span></Link>)}</div>
      {tab[0] === "unconfirmed" && <div className="mb-3"><Alert tone="warning" title="Delivery uncertain">After a timeout or crash the app can’t know if X accepted the message. These are reconciled against your DM history — never blindly retried.</Alert></div>}
      <Card>
        {!jobs.length ? <Empty title="Nothing in this view" /> : (
          <Table><thead><tr><Th>Recipient</Th><Th>Campaign</Th><Th>Message</Th><Th>Status</Th><Th>Updated</Th><Th /></tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.id} className="align-top">
                <Td><Link className="font-medium hover:text-primary" href={`/leads/${j.contactId}`}>@{j.contact.usernameNormalized}</Link></Td>
                <Td className="text-muted-foreground">{j.campaign.name}</Td>
                <Td className="max-w-md"><div className="whitespace-pre-wrap text-sm">{j.body}</div><div className="mt-1 text-[11px] text-muted-foreground">{j.body.length} chars</div></Td>
                <Td><StatusBadge s={j.status} />{j.errorCategory && <div className="mt-1"><Badge tone={j.status === "FAILED" ? "danger" : "neutral"}>{j.errorCategory}</Badge></div>}{j.lastError && <div className="mt-1 max-w-[220px] text-[11px] text-muted-foreground">{j.lastError}</div>}{j.attempts > 0 && <div className="text-[11px] text-muted-foreground">attempts: {j.attempts}</div>}{j.notBefore && j.status === "QUEUED" && j.notBefore > new Date() && <div className="text-[11px] text-warning">waiting until {dt(j.notBefore)}</div>}</Td>
                <Td className="whitespace-nowrap text-xs text-muted-foreground">{ago(j.updatedAt)}</Td>
                <Td className="min-w-52"><JobRowActions id={j.id} status={j.status} body={j.body} /></Td>
              </tr>))}</tbody></Table>)}
        {total > PAGE && <div className="flex justify-between border-t px-4 py-3 text-xs text-muted-foreground"><span>{total} total</span><div className="flex gap-3">{page > 1 && <Link className="text-primary" href={`/queue/automated?tab=${tab[0]}&page=${page - 1}`}>← Prev</Link>}{page * PAGE < total && <Link className="text-primary" href={`/queue/automated?tab=${tab[0]}&page=${page + 1}`}>Next →</Link>}</div></div>}
      </Card>
    </>
  );
}
