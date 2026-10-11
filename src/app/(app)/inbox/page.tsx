import Link from "next/link";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, Input, PageHeader, StatusBadge } from "@/components/ui";
import { ConversationControls } from "@/components/conversation-controls";
import { ago, cn, dt } from "@/lib/utils";
import type { Prisma } from "@prisma/client";

export default async function Inbox({ searchParams }: { searchParams: Promise<{ c?: string; filter?: string; q?: string }> }) {
  const sp = await searchParams;
  const filter = sp.filter ?? "all";
  const where: Prisma.ConversationWhereInput = {
    ...(filter === "replied" ? { replied: true } : filter === "unanswered" ? { replied: false } : filter === "unread" ? { unread: true } : {}),
    ...(sp.q ? { contact: { usernameNormalized: { contains: sp.q.replace(/^@/, "").toLowerCase() } } } : {}),
  };
  const convs = await prisma.conversation.findMany({ where, include: { contact: true }, orderBy: [{ unread: "desc" }, { updatedAt: "desc" }], take: 100 });
  const active = sp.c ? await prisma.conversation.findUnique({ where: { id: sp.c }, include: { contact: true, messages: { orderBy: { sentAt: "asc" }, take: 200 } } }) : null;
  if (active?.unread) await prisma.conversation.update({ where: { id: active.id }, data: { unread: false } });
  const reminders = active ? await prisma.reminder.findMany({ where: { contactId: active.contactId, done: false } }) : [];
  const href = (o: Record<string, string | undefined>) => `/inbox?${new URLSearchParams(Object.entries({ filter: sp.filter, q: sp.q, ...o }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <>
      <PageHeader title="Inbox" desc="Authorised conversations synced from X (the API exposes roughly the last 30 days). Replies pause every pending automated message to that person." />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="overflow-hidden">
          <div className="space-y-2 border-b p-3">
            <form><Input name="q" defaultValue={sp.q} placeholder="Search username…" className="h-8" />{sp.filter && <input type="hidden" name="filter" value={sp.filter} />}</form>
            <div className="flex gap-1">{["all", "replied", "unanswered", "unread"].map((f) => <Link key={f} href={href({ filter: f, c: undefined })} className={cn("rounded-md px-2.5 py-1 text-xs capitalize", filter === f ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted")}>{f}</Link>)}</div>
          </div>
          <ul className="max-h-[70vh] divide-y overflow-y-auto scroll-thin">
            {convs.map((c) => (
              <li key={c.id}><Link href={href({ c: c.id })} className={cn("block px-4 py-3 hover:bg-muted/50", active?.id === c.id && "bg-muted")}>
                <div className="flex items-center justify-between"><span className={cn("text-sm", c.unread ? "font-semibold" : "font-medium")}>@{c.contact.usernameNormalized}</span><span className="text-[11px] text-muted-foreground">{ago(c.lastIncomingAt ?? c.lastOutgoingAt)}</span></div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{c.lastPreview ?? "—"}</div>
                <div className="mt-1.5 flex gap-1">{c.unread && <Badge tone="primary">unread</Badge>}{c.replied && <Badge tone="success">replied</Badge>}{c.status !== "OPEN" && <StatusBadge s={c.status} />}</div></Link></li>))}
            {!convs.length && <li><Empty title="No conversations" desc="Connect an X account and run a sync from Settings." /></li>}
          </ul>
        </Card>
        {active ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
            <Card className="flex min-h-[420px] flex-col">
              <div className="flex items-center justify-between border-b px-5 py-3"><div><Link href={`/leads/${active.contactId}`} className="font-semibold hover:text-primary">@{active.contact.usernameNormalized}</Link><div className="text-xs text-muted-foreground">{active.contact.founderName} {active.contact.company ? `· ${active.contact.company}` : ""}</div></div>
                <a className="text-xs text-primary hover:underline" target="_blank" rel="noreferrer" href={active.xConversationId ? `https://x.com/messages/${active.xConversationId}` : `https://x.com/${active.contact.usernameNormalized}`}>Continue on X ↗</a></div>
              <div className="flex-1 space-y-3 overflow-y-auto p-5">
                {active.messages.map((m) => <div key={m.id} className={cn("flex", m.direction === "OUT" ? "justify-end" : "justify-start")}><div className={cn("max-w-[75%] rounded-2xl px-3.5 py-2 text-sm", m.direction === "OUT" ? "bg-primary/20" : "bg-muted")}><div className="whitespace-pre-wrap">{m.text}</div><div className="mt-1 text-[10px] text-muted-foreground">{dt(m.sentAt)}{m.manual ? " · manual" : ""}</div></div></div>)}
                {!active.messages.length && <Empty title="No synced messages yet" />}
              </div>
              {reminders.length > 0 && <div className="border-t px-5 py-2 text-xs text-warning">⏰ {reminders.map((r) => `${r.kind} (${dt(r.dueAt)})`).join(" · ")}</div>}
              <div className="border-t px-5 py-3 text-xs text-muted-foreground">Replies are written on X itself so they come from you, in your voice. This app never auto-replies or auto-follows-up without permission.</div>
            </Card>
            <Card className="p-5"><ConversationControls id={active.id} status={active.status} tags={active.tags} notes={active.notes ?? ""} unread={false} /></Card>
          </div>
        ) : <Card><Empty title="Select a conversation" desc="Replies appear here as soon as the worker syncs them." /></Card>}
      </div>
    </>
  );
}
