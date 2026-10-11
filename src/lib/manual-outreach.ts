import { createHash } from "crypto";
import { DateTime } from "luxon";
import type { Contact, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getSettings, AppSettings } from "./settings";
import { renderTemplate, variablesFor } from "./template";
import { recordManualSend } from "./manual";
import { logActivity } from "./activity";
import { scoreContact } from "./scoring";

/**
 * Manual (human-sent) cold outreach. Nothing here sends a DM: the user sends it on X themselves.
 * Consent is NOT required to view or prepare a cold lead — only suppression, opt-outs and prior contact block it.
 */

/** Leads that belong in the manual lane. Opted-in leads live in the automated lane. */
export const manualCandidateWhere = (campaignId?: string | null): Prisma.ContactWhereInput => ({
  doNotContact: false,
  consentStatus: { notIn: ["OPTED_OUT", "OPTED_IN"] },
  customerStatus: { notIn: ["NOT_INTERESTED", "CUSTOMER"] },
  historyStatus: { not: "CONTACTED" },
  resolveStatus: { notIn: ["NOT_FOUND", "SUSPENDED"] },
  OR: [{ manualStatus: null }, { manualStatus: "QUEUED" }],
  messages: { none: { direction: "OUT" } },
  conversations: { none: {} },
  ...(campaignId ? { campaigns: { some: { campaignId, skipped: false } } } : {}),
});

export interface SafetyCheck { ok: boolean; blockers: string[]; warnings: string[] }

/** Full-database check right before a lead is shown (and again when it's marked contacted). */
export async function checkManualSafety(contactId: string): Promise<SafetyCheck> {
  const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId }, include: { conversations: true, identifiers: true } });
  const blockers: string[] = [], warnings: string[] = [];
  if (c.doNotContact) blockers.push("Marked do-not-contact");
  if (c.consentStatus === "OPTED_OUT") blockers.push("Opted out");
  const supp = await prisma.suppressionEntry.findFirst({ where: { OR: [{ usernameNormalized: c.usernameNormalized }, ...(c.xUserId ? [{ xUserId: c.xUserId }] : [])] } });
  if (supp) blockers.push("On the suppression list");
  const [outMsg, ledger, liveJob] = await Promise.all([
    prisma.message.findFirst({ where: { contactId, direction: "OUT" }, orderBy: { sentAt: "desc" } }),
    prisma.outreachLedger.findFirst({ where: { contactId, state: { not: "VOID" } } }),
    prisma.messageJob.findFirst({ where: { contactId, status: { in: ["PENDING_APPROVAL", "QUEUED", "SENDING", "UNCERTAIN"] } } }),
  ]);
  if (outMsg) blockers.push(`Already messaged ${outMsg.manual ? "(manually) " : ""}on ${outMsg.sentAt.toISOString().slice(0, 10)}`);
  else if (ledger) blockers.push("Already in the permanent contact history");
  if (c.historyStatus === "CONTACTED" && !outMsg && !ledger) blockers.push("Marked as previously contacted");
  if (c.conversations.length) blockers.push(c.conversations.some((v) => v.replied) ? "Has replied — continue in the Inbox" : "Existing DM conversation");
  if (c.manualStatus === "CONTACTED" || c.manualStatus === "REPLIED") blockers.push(`Already ${c.manualStatus.toLowerCase()}`);
  if (liveJob) blockers.push("An automated message is already queued for this person");
  if (c.resolveStatus === "NOT_FOUND" || c.resolveStatus === "SUSPENDED") blockers.push(`X account ${c.resolveStatus === "SUSPENDED" ? "suspended" : "not found"}`);
  // Same X person under another username (renamed account)?
  if (c.xUserId) {
    const twin = await prisma.contactIdentifier.findFirst({ where: { type: "X_USER_ID", value: c.xUserId, contactId: { not: c.id } } });
    if (twin) blockers.push("Same X account exists under another username");
  }
  const conflict = await prisma.activityLog.findFirst({ where: { contactId, type: "contact.identity_conflict" } });
  if (conflict) warnings.push("Possible duplicate identity (renamed account) — check before sending");
  if (c.historyStatus === "UNKNOWN") warnings.push("DMs with this person haven't been checked on X — if you've talked before, it'll show when you open their profile");
  else if (c.historyStatus === "NONE_FOUND") warnings.push("No DM found in X's 30-day window (older history isn't visible)");
  return { ok: blockers.length === 0, blockers, warnings };
}

const pick = <T,>(arr: T[], seed: string) => arr[parseInt(createHash("md5").update(seed).digest("hex").slice(0, 8), 16) % arr.length];

/**
 * First-contact draft from ONLY the data on file. A campaign template wins if every variable it uses is available;
 * otherwise falls back to the most specific built-in shape whose facts we actually have. Never invents details.
 */
export function buildColdDraft(c: Contact, s: Pick<AppSettings, "outreachPitch" | "outreachCta" | "senderName">, campaignTemplate?: string | null) {
  if (campaignTemplate?.trim()) {
    const r = renderTemplate(campaignTemplate, c);
    if (r.complete) return { text: r.text, source: "campaign template" as const, missing: [] as string[] };
  }
  const v = variablesFor(c);
  const hi = v.first_name ? `Hey ${v.first_name}` : "Hey";
  const company = v.company, product = v.product && v.product !== v.company ? v.product : undefined;
  const opener =
    v.custom_hook ? `${v.custom_hook.replace(/[.!\s]+$/, "")}.`
    : company && product ? pick([`Came across ${product} by ${company} and really liked it.`, `Been looking at what you're building with ${product} at ${company}.`], c.id)
    : company && v.industry ? pick([`Came across ${company} while looking at ${v.industry.toLowerCase()} tools.`, `Found ${company} while digging through ${v.industry.toLowerCase()} startups.`], c.id)
    : company ? pick([`Came across ${company} and wanted to reach out.`, `Spotted ${company} and wanted to say hi.`], c.id)
    : "Came across your profile and wanted to reach out.";
  const cta = renderTemplate(s.outreachCta, c);
  const ctaText = cta.complete ? cta.text : s.outreachCta.replace(/\s*for \{\{\s*company\s*\}\}/g, "").replace(/\{\{[^}]+\}\}/g, "").trim();
  const sign = s.senderName.trim() ? `\n\n– ${s.senderName.trim()}` : "";
  return { text: `${hi}, ${opener.charAt(0).toLowerCase()}${opener.slice(1)} ${s.outreachPitch.trim()} ${ctaText}`.replace(/\s+/g, " ").trim() + sign, source: "auto draft" as const, missing: [] as string[] };
}

export interface ManualStats { today: number; target: number; batchSize: number; doneInBatch: number; inHours: boolean; hoursLabel: string; remaining: number }

export async function manualStats(campaignId?: string | null): Promise<ManualStats> {
  const s = await getSettings();
  const now = DateTime.now().setZone(s.defaultTimezone);
  const dayStart = now.startOf("day").toJSDate();
  const [today, remaining] = await Promise.all([
    prisma.activityLog.count({ where: { type: "manual.contacted", at: { gte: dayStart } } }),
    prisma.contact.count({ where: manualCandidateWhere(campaignId) }),
  ]);
  const [sh, sm] = s.manualWorkStart.split(":").map(Number), [eh, em] = s.manualWorkEnd.split(":").map(Number);
  const start = now.set({ hour: sh, minute: sm }), end = now.set({ hour: eh, minute: em });
  const inHours = s.manualWorkDays.includes(now.weekday) && now >= start && now < end;
  return { today, target: s.manualDailyTarget, batchSize: s.manualBatchSize, doneInBatch: s.manualBatchSize ? today % s.manualBatchSize : 0, inHours, hoursLabel: `${s.manualWorkStart}–${s.manualWorkEnd} ${s.defaultTimezone}`, remaining };
}

export interface FocusLead {
  id: string; username: string; founder: string | null; company: string | null; product: string | null; industry: string | null; website: string | null;
  bio: string | null; followers: number | null; mrr: number | null; mrrKind: string; score: number; scoreIncomplete: boolean; tags: string[];
  campaignId: string | null; campaignName: string | null; draft: string; draftSource: string; checks: SafetyCheck;
}

/** Next lead to work, highest score first. Leads that fail the safety check are repaired/skipped, never shown. */
export async function nextManualLead(opts: { campaignId?: string | null; excludeIds?: string[] } = {}): Promise<FocusLead | null> {
  const s = await getSettings();
  const exclude = new Set(opts.excludeIds ?? []);
  for (let attempt = 0; attempt < 25; attempt++) {
    const c = await prisma.contact.findFirst({
      where: { ...manualCandidateWhere(opts.campaignId), id: { notIn: [...exclude] } },
      orderBy: [{ score: { score: "desc" } }, { createdAt: "asc" }],
      include: { score: true, tags: { include: { tag: true } }, campaigns: { include: { campaign: { include: { template: true } } }, orderBy: { addedAt: "desc" } } },
    });
    if (!c) return null;
    const checks = await checkManualSafety(c.id);
    if (!checks.ok) {
      // Keep the queue truthful: anything already contacted/blocked gets its status corrected so it never resurfaces.
      if (checks.blockers.some((b) => /Already|previously|conversation|replied/i.test(b))) await prisma.contact.update({ where: { id: c.id }, data: { historyStatus: "CONTACTED" } });
      exclude.add(c.id);
      continue;
    }
    const membership = opts.campaignId ? c.campaigns.find((m) => m.campaignId === opts.campaignId) : c.campaigns.find((m) => m.campaign.status !== "ARCHIVED");
    const camp = membership?.campaign;
    const custom = membership?.customMessage?.trim();
    const d = custom ? { text: custom, source: "custom message" } : buildColdDraft(c, s, camp?.templateBody ?? camp?.template?.body);
    const sc = c.score ? { score: c.score.score, incomplete: c.score.incomplete } : (() => { const r = scoreContact(c); return { score: r.score, incomplete: r.incomplete }; })();
    return {
      id: c.id, username: c.usernameNormalized, founder: c.founderName, company: c.company, product: c.product, industry: c.industry, website: c.website,
      bio: c.bio, followers: c.followers, mrr: c.mrr, mrrKind: c.mrrKind, score: sc.score, scoreIncomplete: sc.incomplete, tags: c.tags.map((t) => t.tag.name),
      campaignId: camp?.id ?? null, campaignName: camp?.name ?? null, draft: d.text, draftSource: d.source, checks,
    };
  }
  return null;
}

/** Records a manual send permanently (same ledger/history as automation) and schedules the reply check. */
export async function markManualContacted(contactId: string, o: { campaignId?: string | null; text: string }) {
  const s = await getSettings();
  const before = await checkManualSafety(contactId);
  await recordManualSend(contactId, { campaignId: o.campaignId, text: o.text });
  if (s.manualFollowupDays > 0) {
    await prisma.reminder.create({ data: { contactId, kind: "Check for reply", note: "Manual first-contact sent — see if they replied.", dueAt: new Date(Date.now() + s.manualFollowupDays * 86_400_000) } });
  }
  if (!before.ok) await logActivity({ type: "manual.duplicate_warning", level: "warn", message: `Marked contacted although: ${before.blockers.join("; ")}`, contactId });
  return { warning: before.ok ? null : `Recorded — but note: ${before.blockers.join("; ")}` };
}

export async function skipManualLead(contactId: string, reason: "skip" | "not_fit") {
  await prisma.contact.update({ where: { id: contactId }, data: reason === "not_fit" ? { manualStatus: "SKIPPED", customerStatus: "NOT_INTERESTED" } : { manualStatus: "SKIPPED" } });
  await logActivity({ type: "manual.skipped", message: reason === "not_fit" ? "Skipped — not a fit" : "Skipped in focus mode", contactId });
}
