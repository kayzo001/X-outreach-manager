import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { buildWhere, filterSchema } from "@/lib/filters";
import { profileUrl } from "@/lib/username";

export const maxDuration = 120;
const csv = (name: string, body: string) => new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  if (!(await currentUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kind } = await params;
  const q = req.nextUrl.searchParams;

  if (kind === "campaign") {
    const id = q.get("id") ?? "";
    const camp = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    const members = await prisma.campaignContact.findMany({ where: { campaignId: id }, include: { contact: { include: { jobs: { where: { campaignId: id }, orderBy: { createdAt: "desc" }, take: 1 }, conversations: true, score: true } } } });
    return csv(`campaign-${camp.name.replace(/\W+/g, "-")}.csv`, toCsv(
      ["username", "profile_url", "founder", "company", "consent", "lead_score", "job_status", "error_category", "sent_at", "replied", "customer_status", "do_not_contact"],
      members.map(({ contact: c }) => [c.usernameNormalized, profileUrl(c.usernameNormalized), c.founderName, c.company, c.consentStatus, c.score?.score, c.jobs[0]?.status ?? "NOT_QUEUED", c.jobs[0]?.errorCategory, c.jobs[0]?.sentAt?.toISOString(), c.conversations.some((v) => v.replied) || c.manualStatus === "REPLIED" ? "yes" : "no", c.customerStatus, c.doNotContact ? "yes" : "no"]),
    ));
  }
  if (kind === "leads") {
    const where = buildWhere(filterSchema.parse(JSON.parse(q.get("filter") || "{}")));
    const rows = await prisma.contact.findMany({ where, include: { score: true }, take: 100_000, orderBy: { createdAt: "desc" } });
    return csv("leads.csv", toCsv(
      ["username", "profile_url", "founder_name", "company", "industry", "mrr", "mrr_kind", "followers", "country", "consent_status", "history_status", "customer_status", "do_not_contact", "score"],
      rows.map((c) => [c.usernameNormalized, profileUrl(c.usernameNormalized), c.founderName, c.company, c.industry, c.mrr, c.mrrKind, c.followers, c.country, c.consentStatus, c.historyStatus, c.customerStatus, c.doNotContact ? "yes" : "no", c.score?.score]),
    ));
  }
  if (kind === "logs") {
    const rows = await prisma.activityLog.findMany({ orderBy: { at: "desc" }, take: 50_000 });
    return csv("activity-log.csv", toCsv(["time", "level", "type", "message", "contact_id", "campaign_id", "job_id", "api_status", "error_category", "retry_count", "consent_record_id"], rows.map((r) => [r.at.toISOString(), r.level, r.type, r.message, r.contactId, r.campaignId, r.jobId, r.apiStatus, r.errorCategory, r.retryCount, r.consentRecordId])));
  }
  if (kind === "messages") {
    const from = q.get("from") ? new Date(q.get("from")!) : new Date(0);
    const rows = await prisma.message.findMany({ where: { sentAt: { gte: from } }, include: { contact: true, campaign: true }, orderBy: { sentAt: "desc" }, take: 100_000 });
    return csv("messages.csv", toCsv(["time", "direction", "username", "campaign", "manual", "text"], rows.map((m) => [m.sentAt.toISOString(), m.direction, m.contact.usernameNormalized, m.campaign?.name, m.manual ? "yes" : "no", m.text])));
  }
  return NextResponse.json({ error: "Unknown export" }, { status: 404 });
}
