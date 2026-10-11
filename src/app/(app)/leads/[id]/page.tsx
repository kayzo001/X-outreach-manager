import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { scoreContact, Factor } from "@/lib/scoring";
import { profileUrl } from "@/lib/username";
import { Alert, Badge, Button, Card, CardHeader, Input, Label, PageHeader, Select, StatusBadge, Textarea, Table, Td, Th } from "@/components/ui";
import { addConsent, addReminder, addTag, customerStatus, doNotContact, eraseContact, manualContacted, manualStatus, removeTag, updateContactFields } from "@/app/actions";
import { checkAutomatedEligibility, BLOCKER_LABEL } from "@/lib/eligibility";
import { dt } from "@/lib/utils";
import { AiDraft } from "@/components/ai-draft";

export default async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.contact.findUnique({
    where: { id },
    include: {
      consents: { orderBy: { createdAt: "desc" } }, tags: { include: { tag: true } }, campaigns: { include: { campaign: true } }, reminders: { where: { done: false } },
      messages: { orderBy: { sentAt: "desc" }, take: 30 }, conversations: true, ledger: true,
    },
  });
  if (!c) notFound();
  const accounts = await prisma.xAccount.findMany({ where: { status: "ACTIVE" } });
  const score = scoreContact(c);
  const elig = accounts[0] ? await checkAutomatedEligibility(prisma, { contactId: c.id, xAccountId: accounts[0].id }) : null;

  return (
    <>
      <PageHeader title={`@${c.usernameNormalized}`} desc={<span>{c.founderName ?? "Unknown founder"}{c.company ? ` · ${c.company}` : ""} · <a className="text-primary hover:underline" target="_blank" rel="noreferrer" href={profileUrl(c.usernameNormalized)}>Open on X ↗</a> · <Link className="text-primary hover:underline" href="/leads">← All leads</Link></span>}
        actions={<><StatusBadge s={c.consentStatus} />{c.doNotContact && <Badge tone="danger">do not contact</Badge>}<StatusBadge s={c.resolveStatus} /></>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card><CardHeader title="Profile" desc="Edit anything you know. Unknown fields stay blank — nothing is guessed." />
            <form action={updateContactFields} className="grid gap-3 p-5 sm:grid-cols-2">
              <input type="hidden" name="id" value={c.id} />
              <div><Label>Founder name</Label><Input name="founderName" defaultValue={c.founderName ?? ""} /></div>
              <div><Label>Company</Label><Input name="company" defaultValue={c.company ?? ""} /></div>
              <div><Label>Product</Label><Input name="product" defaultValue={c.product ?? ""} /></div>
              <div><Label>SaaS category</Label><Input name="industry" defaultValue={c.industry ?? ""} /></div>
              <div><Label>Website</Label><Input name="website" defaultValue={c.website ?? ""} /></div>
              <div><Label>Country</Label><Input name="country" defaultValue={c.country ?? ""} /></div>
              <div><Label hint="USD">MRR</Label><Input name="mrr" type="number" defaultValue={c.mrr ?? ""} /></div>
              <div><Label>Revenue source</Label><Select name="mrrKind" defaultValue={c.mrrKind === "UNKNOWN" ? "SELF_REPORTED" : c.mrrKind}><option value="SELF_REPORTED">Self-reported / historical milestone</option><option value="VERIFIED">Verified current MRR</option></Select></div>
              <div className="sm:col-span-2"><Label hint="link that backs up verified revenue">Revenue source URL</Label><Input name="mrrSourceUrl" defaultValue={c.mrrSourceUrl ?? ""} /></div>
              <div className="sm:col-span-2"><Label hint="only facts you have verified — used for {{custom_hook}}">Custom hook</Label><Input name="customHook" defaultValue={c.customHook ?? ""} /></div>
              <div className="sm:col-span-2"><Label>Notes</Label><Textarea name="notes" rows={3} defaultValue={c.notes ?? ""} /></div>
              <div className="sm:col-span-2"><Button variant="primary">Save</Button></div>
            </form></Card>

          <Card><CardHeader title="Consent" desc="Automated DMs require an explicit, documented opt-in. Imports never imply consent." />
            <div className="p-5">
              <form action={addConsent} className="grid gap-3 sm:grid-cols-6">
                <input type="hidden" name="contactId" value={c.id} />
                <div className="sm:col-span-2"><Label>Status</Label><Select name="status" defaultValue="OPTED_IN"><option value="OPTED_IN">Explicitly opted in</option><option value="NOT_OPTED_IN">Not opted in</option><option value="UNKNOWN">Unknown</option><option value="EXPIRED">Consent expired</option><option value="OPTED_OUT">Opted out</option></Select></div>
                <div className="sm:col-span-2"><Label>Source</Label><Input name="source" placeholder="e.g. newsletter form, inbound DM" required /></div>
                <div className="sm:col-span-2"><Label>Scope</Label><Input name="scope" placeholder="e.g. product updates by DM" /></div>
                <div className="sm:col-span-3"><Label hint="required for opt-in">Evidence / reference</Label><Input name="evidence" placeholder="URL, quote or message ID" /></div>
                <div><Label>Account</Label><Select name="xAccountId"><option value="">Any</option>{accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}</Select></div>
                <div><Label hint="days">Expires in</Label><Input name="expiresInDays" type="number" min={0} placeholder="never" /></div>
                <div className="flex items-end"><Button>Record</Button></div>
              </form>
              <Table className="mt-4"><thead><tr><Th>When</Th><Th>Status</Th><Th>Source</Th><Th>Evidence</Th><Th>Scope</Th></tr></thead>
                <tbody>{c.consents.map((r) => <tr key={r.id}><Td className="text-muted-foreground">{dt(r.createdAt)}</Td><Td><StatusBadge s={r.status} /></Td><Td>{r.source}</Td><Td className="max-w-xs truncate text-xs">{r.evidence ?? "—"}</Td><Td className="text-xs">{r.scope ?? "—"}</Td></tr>)}
                  {!c.consents.length && <tr><Td colSpan={5} className="text-center text-muted-foreground">No consent records — this lead is manual-outreach only.</Td></tr>}</tbody></Table>
            </div></Card>

          <Card><CardHeader title="Message history" />
            <ul className="divide-y">{c.messages.map((m) => <li key={m.id} className="px-5 py-3 text-sm"><div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground"><Badge tone={m.direction === "OUT" ? "primary" : "success"}>{m.direction === "OUT" ? (m.manual ? "sent manually" : "sent") : "reply"}</Badge>{dt(m.sentAt)}</div>{m.text}</li>)}
              {!c.messages.length && <li className="px-5 py-8 text-center text-xs text-muted-foreground">No messages recorded. {c.historyStatus === "UNKNOWN" ? "Prior history is unknown until a DM sync runs." : "No DMs were found in X’s 30-day window — older history isn’t visible to the API."}</li>}</ul></Card>
        </div>

        <div className="space-y-4">
          <Card><CardHeader title={`Lead score: ${score.score}/100`} desc={score.incomplete ? `Based on ${score.knownSignals} of ${score.totalSignals} signals — incomplete` : "All signals known"} />
            <ul className="divide-y text-xs">{score.factors.map((f: Factor) => <li key={f.key} className="flex items-start justify-between gap-3 px-5 py-2.5"><div><div className="font-medium">{f.label}</div><div className="text-muted-foreground">{f.detail}</div></div><Badge tone={f.status === "met" ? "success" : f.status === "unknown" ? "warning" : "neutral"}>{f.status === "unknown" ? "unknown" : `${f.points}/${f.max}`}</Badge></li>)}</ul></Card>

          <Card><CardHeader title="Automation eligibility" />
            <div className="p-5 text-sm">
              {!elig ? <p className="text-muted-foreground">Connect an X account to evaluate.</p>
                : elig.ok ? <Alert tone="success" title="Eligible for automated DM">Documented opt-in, no prior contact found, not suppressed.</Alert>
                : <ul className="space-y-1.5">{elig.blockers.map((b) => <li key={b} className="flex gap-2 text-xs"><span className="text-destructive">✕</span>{BLOCKER_LABEL[b]}</li>)}</ul>}
              <p className="mt-3 text-[11px] text-muted-foreground">History: {c.historyStatus === "UNKNOWN" ? "unknown" : c.historyStatus === "NONE_FOUND" ? "no DMs in X’s 30-day window (older history can’t be seen)" : "contacted"}</p>
            </div></Card>

          <Card><CardHeader title="Actions" />
            <div className="flex flex-wrap gap-2 p-5">
              <form action={manualContacted.bind(null, c.id, null, null)}><Button size="sm">Mark contacted</Button></form>
              <form action={manualStatus.bind(null, c.id, "REPLIED")}><Button size="sm">Mark replied</Button></form>
              <form action={customerStatus.bind(null, c.id, "INTERESTED")}><Button size="sm">Interested</Button></form>
              <form action={customerStatus.bind(null, c.id, "NOT_INTERESTED")}><Button size="sm">Not interested</Button></form>
              <form action={customerStatus.bind(null, c.id, "POTENTIAL_CUSTOMER")}><Button size="sm">Potential customer</Button></form>
              <form action={customerStatus.bind(null, c.id, "CUSTOMER")}><Button size="sm" variant="success">Customer</Button></form>
              <form action={doNotContact.bind(null, c.id)}><Button size="sm" variant="danger">Do not contact</Button></form>
            </div></Card>

          <Card><CardHeader title="Tags & reminders" />
            <div className="space-y-3 p-5">
              <div className="flex flex-wrap gap-1.5">{c.tags.map((t) => <form key={t.tagId} action={removeTag.bind(null, c.id, t.tagId)}><button className="rounded-full border bg-muted px-2 py-0.5 text-[11px] hover:border-destructive">{t.tag.name} ×</button></form>)}</div>
              <form action={async (f: FormData) => { "use server"; await addTag(c.id, String(f.get("tag") ?? "")); }} className="flex gap-2"><Input name="tag" placeholder="Add tag" className="h-8" /><Button size="sm">Add</Button></form>
              <form action={addReminder} className="grid grid-cols-3 gap-2 border-t pt-3"><input type="hidden" name="contactId" value={c.id} />
                <Select name="kind" className="col-span-2 h-8"><option>Check conversation</option><option>Reply to interested lead</option><option>Prepare proposal</option><option>Requested follow-up</option></Select>
                <Input name="days" type="number" defaultValue={3} className="h-8" title="days from now" /><Input name="note" placeholder="Note" className="col-span-2 h-8" /><Button size="sm">Remind me</Button></form>
              {c.reminders.map((r) => <div key={r.id} className="text-xs text-muted-foreground">⏰ {r.kind} — {dt(r.dueAt)}</div>)}
            </div></Card>

          <Card><CardHeader title="Draft a message with Claude" desc="Optional. Uses only the facts stored for this lead." /><AiDraft contactId={c.id} campaigns={c.campaigns.map((m) => ({ id: m.campaignId, name: m.campaign.name }))} /></Card>

          <Card><CardHeader title="Campaigns" />
            <ul className="divide-y text-sm">{c.campaigns.map((m) => <li key={m.id} className="px-5 py-2.5"><Link className="hover:text-primary" href={`/campaigns/${m.campaignId}`}>{m.campaign.name}</Link></li>)}{!c.campaigns.length && <li className="px-5 py-4 text-xs text-muted-foreground">Not in any campaign.</li>}</ul></Card>

          <Card className="border-destructive/30"><CardHeader title="Danger zone" desc="Erases this lead’s data. Only the username is kept on the suppression list so they can’t be cold-messaged again." />
            <form action={eraseContact.bind(null, c.id)} className="p-5"><Button variant="danger" size="sm">Erase all data for this lead</Button></form></Card>
        </div>
      </div>
    </>
  );
}
