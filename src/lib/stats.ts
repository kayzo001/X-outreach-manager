import { prisma } from "./db";
import { Prisma } from "@prisma/client";

export interface Range { from: Date; to: Date }
export const defaultRange = (days = 30): Range => ({ from: new Date(Date.now() - days * 86_400_000), to: new Date() });
export function parseRange(sp: { from?: string; to?: string }, days = 30): Range {
  const d = defaultRange(days);
  const from = sp.from ? new Date(sp.from) : d.from; const to = sp.to ? new Date(`${sp.to}T23:59:59Z`) : d.to;
  return { from: isNaN(+from) ? d.from : from, to: isNaN(+to) ? d.to : to };
}

const ELIGIBLE: Prisma.ContactWhereInput = { consentStatus: "OPTED_IN", doNotContact: false, historyStatus: { not: "CONTACTED" }, resolveStatus: { notIn: ["NOT_FOUND", "SUSPENDED"] } };
const MANUAL: Prisma.ContactWhereInput = { consentStatus: { notIn: ["OPTED_IN", "OPTED_OUT"] }, doNotContact: false, historyStatus: { not: "CONTACTED" }, OR: [{ manualStatus: null }, { manualStatus: "QUEUED" }] };
export const eligibleWhere = ELIGIBLE;
export const manualWhere = MANUAL;
const REPLIED: Prisma.ContactWhereInput = { OR: [{ manualStatus: "REPLIED" }, { conversations: { some: { replied: true } } }] };

export async function overviewStats(r?: Range) {
  const inRange = r ? { sentAt: { gte: r.from, lte: r.to } } : {};
  const [imported, unique, eligible, manual, sentAuto, sentManual, contactedPeople, replied, interested, optOuts, failed, activeCampaigns, scheduled, customers] = await Promise.all([
    prisma.csvImport.aggregate({ _sum: { committedRows: true } }),
    prisma.contact.count(),
    prisma.contact.count({ where: ELIGIBLE }),
    prisma.contact.count({ where: MANUAL }),
    prisma.message.count({ where: { direction: "OUT", manual: false, ...inRange } }),
    prisma.message.count({ where: { direction: "OUT", manual: true, ...inRange } }),
    prisma.contact.count({ where: { historyStatus: "CONTACTED" } }),
    prisma.contact.count({ where: REPLIED }),
    prisma.contact.count({ where: { AND: [REPLIED, { customerStatus: { in: ["INTERESTED", "POTENTIAL_CUSTOMER", "CUSTOMER"] } }] } }),
    prisma.contact.count({ where: { OR: [{ consentStatus: "OPTED_OUT" }, { doNotContact: true }] } }),
    prisma.messageJob.count({ where: { status: "FAILED" } }),
    prisma.campaign.count({ where: { status: "ACTIVE" } }),
    prisma.messageJob.count({ where: { status: "QUEUED" } }),
    prisma.contact.count({ where: { customerStatus: "CUSTOMER" } }),
  ]);
  return { imported: imported._sum.committedRows ?? 0, unique, eligible, manual, sentAuto, sentManual, sent: sentAuto + sentManual, contactedPeople, replied, interested, optOuts, failed, activeCampaigns, scheduled, customers };
}

export async function dailySeries(r: Range) {
  const rows = await prisma.$queryRaw<{ day: Date; direction: string; n: bigint }[]>`
    SELECT date_trunc('day', "sentAt") AS day, direction::text AS direction, count(*) AS n FROM messages
    WHERE "sentAt" >= ${r.from} AND "sentAt" <= ${r.to} GROUP BY 1, 2 ORDER BY 1`;
  const map = new Map<string, { day: string; sent: number; replies: number }>();
  for (let t = new Date(r.from); t <= r.to; t = new Date(t.getTime() + 86_400_000)) { const k = t.toISOString().slice(0, 10); map.set(k, { day: k.slice(5), sent: 0, replies: 0 }); }
  for (const x of rows) { const k = x.day.toISOString().slice(0, 10); const e = map.get(k) ?? { day: k.slice(5), sent: 0, replies: 0 }; if (x.direction === "OUT") e.sent = Number(x.n); else e.replies = Number(x.n); map.set(k, e); }
  return [...map.values()];
}

export async function campaignPerformance() {
  const camps = await prisma.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { createdAt: "desc" }, take: 12 });
  return Promise.all(camps.map(async (c) => {
    const [sent, replied] = await Promise.all([
      prisma.messageJob.count({ where: { campaignId: c.id, status: "SENT" } }),
      prisma.contact.count({ where: { campaigns: { some: { campaignId: c.id } }, ...REPLIED } }),
    ]);
    return { name: c.name.slice(0, 22), sent, replied };
  }));
}

export async function funnel(campaignId?: string) {
  const scope: Prisma.ContactWhereInput = campaignId ? { campaigns: { some: { campaignId } } } : {};
  const [imported, qualified, eligible, contacted, replied, interested, customer] = await Promise.all([
    prisma.contact.count({ where: scope }),
    prisma.contact.count({ where: { ...scope, score: { score: { gte: 40 } } } }),
    prisma.contact.count({ where: { ...scope, ...ELIGIBLE } }),
    prisma.contact.count({ where: { ...scope, historyStatus: "CONTACTED" } }),
    prisma.contact.count({ where: { AND: [scope, REPLIED] } }),
    prisma.contact.count({ where: { AND: [scope, REPLIED, { customerStatus: { in: ["INTERESTED", "POTENTIAL_CUSTOMER", "CUSTOMER"] } }] } }),
    prisma.contact.count({ where: { ...scope, customerStatus: "CUSTOMER" } }),
  ]);
  return [
    { stage: "Imported", n: imported }, { stage: "Qualified", n: qualified }, { stage: "Eligible", n: eligible },
    { stage: "Contacted", n: contacted }, { stage: "Replied", n: replied }, { stage: "Interested", n: interested }, { stage: "Customer", n: customer },
  ];
}

export async function byIndustry() {
  const rows = await prisma.$queryRaw<{ industry: string; leads: bigint; contacted: bigint; replied: bigint }[]>`
    SELECT COALESCE(NULLIF(c.industry, ''), 'Unknown') AS industry, count(*) AS leads,
      count(*) FILTER (WHERE c."historyStatus" = 'CONTACTED') AS contacted,
      count(*) FILTER (WHERE c."manualStatus" = 'REPLIED' OR EXISTS (SELECT 1 FROM conversations v WHERE v."contactId" = c.id AND v.replied)) AS replied
    FROM contacts c GROUP BY 1 ORDER BY 2 DESC LIMIT 12`;
  return rows.map((r) => ({ industry: r.industry.slice(0, 24), leads: Number(r.leads), contacted: Number(r.contacted), replied: Number(r.replied) }));
}
