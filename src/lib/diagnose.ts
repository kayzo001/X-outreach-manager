import { prisma } from "./db";
import { getSettings } from "./settings";
import { checkAutomatedEligibility, Blocker, BLOCKER_LABEL } from "./eligibility";
import { scheduleOf } from "./engine";
import { gateSend, nextWindowStart } from "./schedule";

export interface Diagnosis {
  total: number; checked: number; eligible: number;
  jobs: { approval: number; queued: number; sent: number; dryRun: number; failed: number };
  blockers: { code: Blocker; label: string; count: number }[];
  notes: { tone: "danger" | "warning" | "primary"; text: string }[];
  headline: string;
}

/** Plain-English answer to "why isn't this campaign sending?". Read-only. */
export async function diagnoseCampaign(id: string, sample = 500): Promise<Diagnosis> {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id }, include: { xAccount: true } });
  const settings = await getSettings();
  const [total, members, grouped] = await Promise.all([
    prisma.campaignContact.count({ where: { campaignId: id } }),
    prisma.campaignContact.findMany({ where: { campaignId: id, skipped: false, contact: { jobs: { none: { campaignId: id } } } }, select: { contactId: true }, take: sample }),
    prisma.messageJob.groupBy({ by: ["status"], where: { campaignId: id }, _count: true }),
  ]);
  const n = (s: string) => grouped.find((g) => g.status === s)?._count ?? 0;
  const jobs = { approval: n("PENDING_APPROVAL"), queued: n("QUEUED"), sent: n("SENT"), dryRun: n("DRY_RUN"), failed: n("FAILED") };

  const counts = new Map<Blocker, number>();
  let eligible = 0;
  if (c.xAccountId) {
    for (const m of members) {
      const e = await checkAutomatedEligibility(prisma, { contactId: m.contactId, xAccountId: c.xAccountId, settings });
      if (e.ok) eligible++;
      for (const b of e.blockers) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
  }
  // Root causes first; UNRESOLVED/HISTORY_UNKNOWN are usually consequences (we only look up opted-in leads).
  const rank = (b: Blocker) => (["NO_CONSENT", "CONSENT_EXPIRED", "OPTED_OUT", "SUPPRESSED", "DO_NOT_CONTACT"].includes(b) ? 0 : ["UNRESOLVED", "HISTORY_UNKNOWN"].includes(b) ? 2 : 1);
  const blockers = [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]).map(([code, count]) => ({ code, label: BLOCKER_LABEL[code], count }));

  const notes: Diagnosis["notes"] = [];
  if (settings.killSwitch) notes.push({ tone: "danger", text: "The global emergency stop is ON — nothing sends until you release it in Settings." });
  if (!c.xAccount) notes.push({ tone: "primary", text: "No sending account is attached, so this is a manual-only campaign. Edit it to choose your X account." });
  else if (c.xAccount.status !== "ACTIVE") notes.push({ tone: "danger", text: `@${c.xAccount.username} is ${c.xAccount.status.toLowerCase()} — reconnect it in Settings → X Integration.` });
  if (c.status !== "ACTIVE") notes.push({ tone: "warning", text: `The campaign is ${c.status.toLowerCase()}${c.pauseReason ? ` (${c.pauseReason})` : ""}. Press Start/Resume to let it send.` });
  if (jobs.approval) notes.push({ tone: "primary", text: `${jobs.approval} message(s) are waiting for your approval in the Automated Queue.` });
  if (settings.dryRun) notes.push({ tone: "warning", text: "Dry-run mode is on: messages are processed but never transmitted to X." });
  if (c.status === "ACTIVE") {
    const sch = scheduleOf(c);
    const g = gateSend(sch, new Date(), { sentLastHour: 0, sentToday: 0, sentTotal: 0 }, null);
    if (!g.ok && g.reason === "Outside sending window") {
      const next = nextWindowStart(sch, new Date());
      notes.push({ tone: "primary", text: `Outside the sending window right now (${sch.windowStart}–${sch.windowEnd} ${sch.timezone}). Next window: ${next ? next.toLocaleString("en-US", { timeZone: sch.timezone, dateStyle: "medium", timeStyle: "short" }) : "none — check the end date"}.` });
    }
  }

  const optIn = (counts.get("NO_CONSENT") ?? 0) + (counts.get("CONSENT_EXPIRED") ?? 0);
  const headline =
    jobs.queued || jobs.approval ? `${jobs.queued} queued · ${jobs.approval} awaiting approval · ${jobs.sent} sent`
    : eligible ? `${eligible} lead(s) are eligible and will be queued on the next worker tick.`
    : total === 0 ? "This campaign has no leads yet."
    : optIn && optIn >= members.length ? `None of the ${members.length} remaining leads can be messaged automatically — they have no documented opt-in. Work them from the Manual Queue.`
    : `No lead is currently eligible for automated sending — see the reasons below.`;
  return { total, checked: members.length, eligible, jobs, blockers, notes, headline };
}
