import Link from "next/link";
import { prisma } from "@/lib/db";
import { Badge, Button, Card, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { dt } from "@/lib/utils";
import type { Prisma } from "@prisma/client";

const PAGE = 100;
export default async function Logs({ searchParams }: { searchParams: Promise<{ level?: string; type?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const where: Prisma.ActivityLogWhereInput = { ...(sp.level ? { level: sp.level } : {}), ...(sp.type ? { type: { startsWith: sp.type } } : {}), ...(sp.q ? { message: { contains: sp.q, mode: "insensitive" } } : {}) };
  const [total, logs] = await Promise.all([prisma.activityLog.count({ where }), prisma.activityLog.findMany({ where, orderBy: { at: "desc" }, take: PAGE, skip: (page - 1) * PAGE })]);
  const contactIds = [...new Set(logs.map((l) => l.contactId).filter(Boolean))] as string[];
  const names = new Map((await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, usernameNormalized: true } })).map((c) => [c.id, c.usernameNormalized]));
  const q = (p: number) => `/logs?${new URLSearchParams({ ...(sp.level ? { level: sp.level } : {}), ...(sp.type ? { type: sp.type } : {}), ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`;
  return (
    <>
      <PageHeader title="Activity logs" desc="Append-only audit trail of every important event. Tokens and secrets are never written here." actions={<a className="inline-flex h-9 items-center rounded-md border bg-muted px-3 text-sm hover:bg-accent" href="/api/export/logs">Export CSV</a>} />
      <form className="mb-3 flex flex-wrap gap-2"><Input name="q" defaultValue={sp.q} placeholder="Search messages…" className="w-64" />
        <Select name="level" defaultValue={sp.level ?? ""} className="w-32"><option value="">All levels</option><option>info</option><option>warn</option><option>error</option></Select>
        <Select name="type" defaultValue={sp.type ?? ""} className="w-44"><option value="">All types</option>{["job", "campaign", "consent", "contact", "import", "sync", "reply", "manual", "oauth", "killswitch", "auth"].map((t) => <option key={t} value={t}>{t}.*</option>)}</Select><Button>Filter</Button></form>
      <Card>
        <Table><thead><tr><Th>Time</Th><Th>Event</Th><Th>Detail</Th><Th>Contact</Th><Th>API</Th><Th>Category</Th></tr></thead>
          <tbody>{logs.map((l) => (
            <tr key={l.id}><Td className="whitespace-nowrap text-xs text-muted-foreground">{dt(l.at)}</Td>
              <Td><Badge tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "neutral"}>{l.type}</Badge></Td>
              <Td className="max-w-xl text-sm">{l.message}</Td>
              <Td className="text-xs">{l.contactId && names.get(l.contactId) ? <Link className="text-primary hover:underline" href={`/leads/${l.contactId}`}>@{names.get(l.contactId)}</Link> : "—"}</Td>
              <Td className="text-xs">{l.apiStatus ?? "—"}{l.retryCount ? ` · try ${l.retryCount}` : ""}</Td><Td className="text-xs text-muted-foreground">{l.errorCategory ?? "—"}</Td></tr>))}
            {!logs.length && <tr><Td colSpan={6} className="py-10 text-center text-muted-foreground">No log entries.</Td></tr>}</tbody></Table>
        {total > PAGE && <div className="flex justify-between border-t px-4 py-3 text-xs text-muted-foreground"><span>{total.toLocaleString()} entries</span><div className="flex gap-3">{page > 1 && <Link className="text-primary" href={q(page - 1)}>← Newer</Link>}{page * PAGE < total && <Link className="text-primary" href={q(page + 1)}>Older →</Link>}</div></div>}
      </Card>
    </>
  );
}
