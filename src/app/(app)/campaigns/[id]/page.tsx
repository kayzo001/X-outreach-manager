import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { scoreContact } from "@/lib/scoring";
import { scheduleOf } from "@/lib/engine";
import { checkAutomatedEligibility, BLOCKER_LABEL } from "@/lib/eligibility";
import { eligibleWhere, manualWhere, funnel } from "@/lib/stats";
import { Alert, Badge, Card, CardHeader, PageHeader, StatCard, StatusBadge, Table, Td, Th, Empty } from "@/components/ui";
import { CampaignControls } from "@/components/campaign-controls";
import { AddLeadsFromImport } from "@/components/add-leads-from-import";
import { importOptionsFor } from "@/lib/campaign-imports";
import { diagnoseCampaign } from "@/lib/diagnose";
import { Funnel } from "@/components/charts";
import { ago, dt, fmt, pct } from "@/lib/utils";

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.campaign.findUnique({ where: { id }, include: { xAccount: true, template: true } });
  if (!c) notFound();
  const inCamp = { campaigns: { some: { campaignId: id } } };
  const [total, eligible, manual, sent, failed, uncertain, pending, queued, replied, optOuts, done, fun, members, logs] = await Promise.all([
    prisma.campaignContact.count({ where: { campaignId: id } }),
    prisma.contact.count({ where: { ...inCamp, ...eligibleWhere } }),
    prisma.contact.count({ where: { ...inCamp, ...manualWhere } }),
    prisma.messageJob.count({ where: { campaignId: id, status: "SENT" } }),
    prisma.messageJob.count({ where: { campaignId: id, status: "FAILED" } }),
    prisma.messageJob.count({ where: { campaignId: id, status: "UNCERTAIN" } }),
    prisma.messageJob.count({ where: { campaignId: id, status: "PENDING_APPROVAL" } }),
    prisma.messageJob.count({ where: { campaignId: id, status: "QUEUED" } }),
    prisma.contact.count({ where: { ...inCamp, OR: [{ manualStatus: "REPLIED" }, { conversations: { some: { replied: true } } }] } }),
    prisma.contact.count({ where: { ...inCamp, OR: [{ consentStatus: "OPTED_OUT" }, { doNotContact: true }] } }),
    prisma.campaignContact.count({ where: { campaignId: id, contact: { OR: [{ historyStatus: "CONTACTED" }, { doNotContact: true }, { manualStatus: "SKIPPED" }] } } }),
    funnel(id),
    prisma.campaignContact.findMany({ where: { campaignId: id }, take: 50, orderBy: { addedAt: "desc" }, include: { contact: { include: { score: true, jobs: { where: { campaignId: id }, take: 1, orderBy: { createdAt: "desc" } } } } } }),
    prisma.activityLog.findMany({ where: { campaignId: id }, orderBy: { at: "desc" }, take: 12 }),
  ]);
  const sch = scheduleOf(c);
  const importOptions = c.status === "ARCHIVED" ? [] : await importOptionsFor(id);
  const diag = c.status === "ARCHIVED" || c.status === "COMPLETED" ? null : await diagnoseCampaign(id);
  const progress = total ? Math.round((done / total) * 100) : 0;
  const rows = await Promise.all(members.map(async (m) => ({ m, e: c.xAccountId ? await checkAutomatedEligibility(prisma, { contactId: m.contactId, xAccountId: c.xAccountId }) : null })));

  return (
    <>
      <PageHeader title={c.name} desc={c.description ?? c.audience ?? undefined} actions={<><StatusBadge s={c.status} /><CampaignControls id={c.id} status={c.status} /></>} />
      {diag && (
        <Card className="mb-5">
          <CardHeader title="Delivery status" desc={diag.headline} right={diag.jobs.approval ? <Link className="text-xs text-primary hover:underline" href="/queue/automated">Review approvals →</Link> : diag.blockers.some((b) => b.code === "NO_CONSENT") ? <Link className="text-xs text-primary hover:underline" href="/queue/manual">Open Manual Queue →</Link> : null} />
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <div className="space-y-2">
              {diag.notes.map((n, i) => <div key={i} className={`rounded-md border px-3 py-2 text-xs ${n.tone === "danger" ? "border-destructive/30 bg-destructive/10 text-destructive" : n.tone === "warning" ? "border-warning/30 bg-warning/10 text-warning" : "border-primary/30 bg-primary/10 text-primary"}`}>{n.text}</div>)}
              {!diag.notes.length && <div className="text-xs text-success">No global blockers — the worker can send whenever leads are eligible.</div>}
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Leads not yet queued{diag.checked < diag.total ? ` (checked ${diag.checked})` : ""}: {diag.eligible} eligible</div>
              <ul className="space-y-1.5 text-xs">{diag.blockers.slice(0, 6).map((b) => <li key={b.code} className="flex justify-between gap-3"><span className="text-muted-foreground">{b.label}</span><span className="font-medium tabular-nums">{b.count}</span></li>)}</ul>
              {diag.blockers.some((b) => b.code === "NO_CONSENT") && <p className="mt-3 text-[11px] text-muted-foreground">X only allows automated DMs to people who opted in. Record a documented opt-in on a lead’s page to make them eligible — otherwise message them yourself from the Manual Queue.</p>}
            </div>
          </div>
        </Card>
      )}
      <div className="mb-5 space-y-3">
        {c.autoPaused && c.pauseReason && <Alert tone="danger" title="Campaign auto-paused">{c.pauseReason}</Alert>}
        {!c.xAccountId && <Alert tone="primary" title="Manual-only campaign">No sending account is attached, so nothing sends automatically. Use the manual queue.</Alert>}
        {uncertain > 0 && <Alert tone="warning" title={`${uncertain} delivery result(s) unconfirmed`}>These are being reconciled against X and will never be retried blindly.</Alert>}
        {pending > 0 && <Alert tone="primary" title={`${pending} message(s) waiting for your approval`}><Link className="underline" href="/queue/automated">Review in the Automated Queue →</Link></Alert>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Total leads" value={fmt.format(total)} /><StatCard label="Eligible" value={fmt.format(eligible)} tone="success" /><StatCard label="Manual review" value={fmt.format(manual)} tone="warning" />
        <StatCard label="Sent" value={fmt.format(sent)} sub={`${queued} queued`} /><StatCard label="Replies" value={fmt.format(replied)} sub={pct(replied, sent)} tone="primary" />
        <StatCard label="Failed" value={fmt.format(failed)} tone={failed ? "danger" : undefined} /><StatCard label="Opt-outs" value={fmt.format(optOuts)} /><StatCard label="Complete" value={`${progress}%`} />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
        {c.status !== "ARCHIVED" && <Card><CardHeader title="Add leads from your CSV imports" desc="Pick a file you imported — all of its leads join this campaign. Duplicates are skipped automatically." /><AddLeadsFromImport campaignId={c.id} imports={importOptions} /></Card>}
        <Card>
          <CardHeader title="Leads" desc="First 50 shown. Blockers explain exactly why a lead won’t be sent automatically." />
          {!rows.length ? <Empty title="No leads in this campaign yet" desc="Use “Add leads from your CSV imports” above, or All Leads → Add to campaign." /> : (
            <Table><thead><tr><Th>Lead</Th><Th>Score</Th><Th>Consent</Th><Th>Delivery</Th><Th>Automation</Th></tr></thead>
              <tbody>{rows.map(({ m, e }) => { const j = m.contact.jobs[0]; const sc = m.contact.score?.score ?? scoreContact(m.contact).score; return (
                <tr key={m.id}><Td><Link className="font-medium hover:text-primary" href={`/leads/${m.contactId}`}>@{m.contact.usernameNormalized}</Link><div className="text-xs text-muted-foreground">{m.contact.company ?? ""}</div></Td>
                  <Td>{sc}</Td><Td><StatusBadge s={m.contact.consentStatus} /></Td>
                  <Td>{j ? <><StatusBadge s={j.status} />{j.errorCategory && <div className="mt-0.5 text-[11px] text-muted-foreground">{j.errorCategory}</div>}</> : <span className="text-xs text-muted-foreground">not queued</span>}</Td>
                  <Td className="text-xs">{!e ? "—" : j?.status === "SENT" ? <span className="text-success">sent</span> : e.ok ? <span className="text-success">eligible</span> : <span className="text-muted-foreground">{e.blockers.slice(0, 2).map((b) => BLOCKER_LABEL[b]).join(" · ")}{e.blockers.length > 2 ? ` +${e.blockers.length - 2}` : ""}</span>}</Td></tr>); })}</tbody></Table>)}
        </Card>
        </div>
        <div className="space-y-4">
          <Card><CardHeader title="Funnel" /><div className="p-5"><Funnel data={fun} /></div></Card>
          <Card><CardHeader title="Schedule" />
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-5 text-xs">
              <dt className="text-muted-foreground">Timezone</dt><dd>{sch.timezone}</dd>
              <dt className="text-muted-foreground">Window</dt><dd>{sch.windowStart}–{sch.windowEnd}</dd>
              <dt className="text-muted-foreground">Days</dt><dd>{["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].filter((_, i) => sch.days.includes(i)).join(" ")}</dd>
              <dt className="text-muted-foreground">Limits</dt><dd>{sch.maxPerHour}/h · {sch.maxPerDay}/day{sch.maxPerCampaign ? ` · ${sch.maxPerCampaign} total` : ""}</dd>
              <dt className="text-muted-foreground">Batches</dt><dd>{sch.batchSize} msgs, {sch.messageDelayMinutes}m apart, {sch.batchDelayMinMinutes}m between</dd>
              <dt className="text-muted-foreground">Next send</dt><dd>{c.status === "ACTIVE" ? (c.nextSendAt ? `${dt(c.nextSendAt)} (${ago(c.nextSendAt)})` : "as soon as eligible") : "—"}</dd>
              <dt className="text-muted-foreground">Approval</dt><dd>{c.requireApproval ? "required" : "not required"}</dd>
            </dl></Card>
          <Card><CardHeader title="Activity" /><ul className="divide-y text-xs">{logs.map((l) => <li key={l.id} className="flex gap-2 px-5 py-2"><Badge tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "neutral"}>{ago(l.at)}</Badge><span className="flex-1">{l.message}</span></li>)}{!logs.length && <li className="px-5 py-6 text-center text-muted-foreground">No activity yet.</li>}</ul></Card>
        </div>
      </div>
    </>
  );
}
