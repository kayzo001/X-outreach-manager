"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser, rateLimit } from "@/lib/auth";
import { saveXCredentials, deleteXCredentials, testXConfiguration } from "@/lib/x-config";
import { CredentialKeyError } from "@/lib/crypto";
import { logActivity } from "@/lib/activity";
import { scheduleSchema } from "@/lib/schedule";
import { planCampaign, setCampaignStatus } from "@/lib/engine";
import { recordConsent } from "@/lib/consent";
import { markDoNotContact, markManual, recordManualSend, setCustomerStatus } from "@/lib/manual";
import { getSettings, setSetting, AppSettings } from "@/lib/settings";
import { filterSchema, buildWhere } from "@/lib/filters";
import { pokeTick } from "@/lib/queue";
import { encrypt } from "@/lib/crypto";
import { syncAccount } from "@/lib/sync";
import { resolvePending } from "@/lib/resolve";
import { rescoreContacts } from "@/lib/scoring";
import { MAX_DM_LENGTH } from "@/lib/template";
import { draftWithClaude } from "@/lib/ai";
import { commitImport } from "@/lib/import";
import { diagnoseCampaign } from "@/lib/diagnose";
import type { ConvStatus, CustomerStatus, ConsentStatus, ManualStatus } from "@prisma/client";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const n = (f: FormData, k: string, d: number) => { const v = Number(f.get(k)); return Number.isFinite(v) && f.get(k) !== "" && f.get(k) !== null ? v : d; };

// ─────────── Campaigns ───────────
function scheduleFromForm(f: FormData) {
  const days = f.getAll("days").map(Number).filter(Boolean);
  return scheduleSchema.parse({
    timezone: s(f, "timezone") || "America/New_York",
    startDate: s(f, "startDate") || null, endDate: s(f, "endDate") || null,
    days: days.length ? days : [1, 2, 3, 4, 5],
    allowWeekends: f.get("allowWeekends") === "on", excludeHolidays: f.get("excludeHolidays") === "on",
    holidays: s(f, "holidays").split(/[\s,]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    windowStart: s(f, "windowStart") || "09:00", windowEnd: s(f, "windowEnd") || "17:00",
    maxPerHour: n(f, "maxPerHour", 5), maxPerDay: n(f, "maxPerDay", 20), maxPerCampaign: f.get("maxPerCampaign") ? n(f, "maxPerCampaign", 0) || null : null,
    batchSize: n(f, "batchSize", 5), batchDelayMinMinutes: n(f, "batchDelayMinMinutes", 60), batchDelayMaxMinutes: n(f, "batchDelayMaxMinutes", 60),
    messageDelayMinutes: n(f, "messageDelayMinutes", 3), maxConsecutiveErrors: n(f, "maxConsecutiveErrors", 3),
    autoPauseOnErrors: f.get("autoPauseOnErrors") === "on", stopOnReply: f.get("stopOnReply") === "on",
  });
}

export async function saveCampaign(f: FormData) {
  await requireUser();
  const id = s(f, "id");
  const name = z.string().min(1).max(120).parse(s(f, "name"));
  const body = s(f, "templateBody");
  if (body.length > MAX_DM_LENGTH) throw new Error("Template too long");
  const data = {
    name, description: s(f, "description") || null, audience: s(f, "audience") || null,
    xAccountId: s(f, "xAccountId") || null, templateId: s(f, "templateId") || null, templateBody: body || null,
    requireApproval: f.get("requireApproval") === "on", schedule: scheduleFromForm(f) as Prisma.InputJsonValue,
  };
  const c = id ? await prisma.campaign.update({ where: { id }, data }) : await prisma.campaign.create({ data });
  await logActivity({ type: id ? "campaign.updated" : "campaign.created", message: `${id ? "Updated" : "Created"} campaign “${name}”`, campaignId: c.id });
  revalidatePath("/campaigns");
  redirect(`/campaigns/${c.id}`);
}

export async function duplicateCampaign(id: string) {
  await requireUser();
  const src = await prisma.campaign.findUniqueOrThrow({ where: { id } });
  // Copies configuration only. Contacts are NOT copied and no history is reset — the ledger/consent rules are global.
  const c = await prisma.campaign.create({ data: { name: `${src.name} (copy)`, description: src.description, audience: src.audience, xAccountId: src.xAccountId, templateId: src.templateId, templateBody: src.templateBody, requireApproval: src.requireApproval, schedule: src.schedule as Prisma.InputJsonValue } });
  await logActivity({ type: "campaign.duplicated", message: `Duplicated “${src.name}” (configuration only)`, campaignId: c.id });
  redirect(`/campaigns/${c.id}`);
}

export async function campaignAction(id: string, action: "start" | "pause" | "resume" | "stop" | "archive" | "complete"): Promise<string | null> {
  await requireUser();
  await setCampaignStatus(id, action);
  let summary: string | null = null;
  if (action === "start" || action === "resume") {
    const plan = await planCampaign(id);
    await pokeTick();
    const d = await diagnoseCampaign(id);
    summary = plan.created ? `Started — ${plan.created} message(s) ${d.jobs.approval ? "drafted for your approval (Automated Queue)" : "queued"}.` : `Started, but nothing can be sent automatically yet. ${d.headline}`;
  }
  revalidatePath(`/campaigns/${id}`); revalidatePath("/campaigns");
  return summary;
}

export async function addFilteredToCampaign(campaignId: string, filterJson: string) {
  await requireUser();
  const where = buildWhere(filterSchema.parse(JSON.parse(filterJson || "{}")));
  const ids = (await prisma.contact.findMany({ where, select: { id: true }, take: 50_000 })).map((c) => c.id);
  const r = await prisma.campaignContact.createMany({ data: ids.map((contactId) => ({ campaignId, contactId })), skipDuplicates: true });
  await logActivity({ type: "campaign.contacts_added", message: `Added ${r.count} contacts to campaign`, campaignId });
  revalidatePath(`/campaigns/${campaignId}`); revalidatePath("/leads");
  return r.count;
}

export async function addContactsToCampaign(campaignId: string, contactIds: string[]) {
  await requireUser();
  const r = await prisma.campaignContact.createMany({ data: contactIds.map((contactId) => ({ campaignId, contactId })), skipDuplicates: true });
  revalidatePath(`/campaigns/${campaignId}`); revalidatePath("/leads");
  return r.count;
}

export async function removeFromCampaign(campaignId: string, contactId: string) {
  await requireUser();
  await prisma.messageJob.updateMany({ where: { campaignId, contactId, status: { in: ["QUEUED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED", errorCategory: "REMOVED" } });
  await prisma.campaignContact.delete({ where: { campaignId_contactId: { campaignId, contactId } } }).catch(() => undefined);
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function setCustomMessage(campaignId: string, contactId: string, message: string) {
  await requireUser();
  await prisma.campaignContact.update({ where: { campaignId_contactId: { campaignId, contactId } }, data: { customMessage: message.trim() || null } });
  revalidatePath(`/campaigns/${campaignId}`);
}

// ─────────── Approval queue ───────────
export async function approveJobs(ids: string[]) {
  await requireUser();
  const r = await prisma.messageJob.updateMany({ where: { id: { in: ids }, status: "PENDING_APPROVAL" }, data: { status: "QUEUED" } });
  await logActivity({ type: "job.approved", message: `Approved ${r.count} message(s)` });
  await pokeTick(); revalidatePath("/queue/automated");
}
export async function rejectJobs(ids: string[]) {
  await requireUser();
  const r = await prisma.messageJob.updateMany({ where: { id: { in: ids }, status: { in: ["PENDING_APPROVAL", "QUEUED"] } }, data: { status: "CANCELLED", errorCategory: "REJECTED", lastError: "Rejected by reviewer" } });
  await logActivity({ type: "job.rejected", message: `Rejected ${r.count} message(s)` });
  revalidatePath("/queue/automated");
}
export async function editJobBody(id: string, body: string) {
  await requireUser();
  if (!body.trim() || body.length > MAX_DM_LENGTH) throw new Error("Invalid message");
  await prisma.messageJob.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { body: body.trim() } });
  revalidatePath("/queue/automated");
}
export async function retryFailedJob(id: string) {
  await requireUser();
  const j = await prisma.messageJob.findUniqueOrThrow({ where: { id } });
  if (j.status !== "FAILED") throw new Error("Only failed jobs can be re-queued");
  if (j.errorCategory === "AUTH") throw new Error("Reconnect the X account first");
  // A new attempt must pass the full eligibility gate again at claim time.
  await prisma.messageJob.update({ where: { id }, data: { status: "PENDING_APPROVAL", notBefore: null, errorCategory: null, lastError: null } });
  await logActivity({ type: "job.requeued", message: "Failed job re-queued for approval", jobId: id, contactId: j.contactId, campaignId: j.campaignId });
  revalidatePath("/queue/automated");
}

// ─────────── Contacts / consent / manual ───────────
export async function addConsent(f: FormData) {
  await requireUser();
  const contactId = s(f, "contactId");
  const status = s(f, "status") as ConsentStatus;
  const days = n(f, "expiresInDays", 0);
  await recordConsent(contactId, { status, source: s(f, "source") || "manual", evidence: s(f, "evidence") || null, scope: s(f, "scope") || null, xAccountId: s(f, "xAccountId") || null, expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null });
  revalidatePath(`/leads/${contactId}`); revalidatePath("/leads");
}
export async function manualContacted(contactId: string, campaignId?: string | null, text?: string | null) {
  await requireUser(); await recordManualSend(contactId, { campaignId, text }); revalidatePath("/queue/manual"); revalidatePath("/leads");
}
export async function manualStatus(contactId: string, status: ManualStatus) {
  await requireUser(); await markManual(contactId, status); revalidatePath("/queue/manual"); revalidatePath("/leads"); revalidatePath("/inbox");
}
export async function customerStatus(contactId: string, status: CustomerStatus) {
  await requireUser(); await setCustomerStatus(contactId, status); revalidatePath("/leads"); revalidatePath("/inbox"); revalidatePath(`/leads/${contactId}`);
}
export async function doNotContact(contactId: string) {
  await requireUser(); await markDoNotContact(contactId); revalidatePath("/leads"); revalidatePath("/inbox"); revalidatePath("/queue/manual");
}
export async function updateContactFields(f: FormData) {
  await requireUser();
  const id = s(f, "id");
  const mrr = s(f, "mrr");
  await prisma.contact.update({ where: { id }, data: {
    founderName: s(f, "founderName") || null, company: s(f, "company") || null, product: s(f, "product") || null, industry: s(f, "industry") || null,
    website: s(f, "website") || null, country: s(f, "country") || null, customHook: s(f, "customHook") || null, notes: s(f, "notes") || null,
    mrr: mrr ? Math.round(Number(mrr)) : null, mrrKind: !mrr ? "UNKNOWN" : (s(f, "mrrKind") as "SELF_REPORTED" | "VERIFIED"), mrrSourceUrl: s(f, "mrrSourceUrl") || null,
  } });
  await rescoreContacts([id]);
  revalidatePath(`/leads/${id}`);
}
export async function addTag(contactId: string, name: string) {
  await requireUser();
  const nm = name.trim().toLowerCase().slice(0, 40); if (!nm) return;
  const tag = await prisma.tag.upsert({ where: { name: nm }, create: { name: nm }, update: {} });
  await prisma.contactTag.upsert({ where: { contactId_tagId: { contactId, tagId: tag.id } }, create: { contactId, tagId: tag.id }, update: {} });
  revalidatePath(`/leads/${contactId}`); revalidatePath("/leads");
}
export async function removeTag(contactId: string, tagId: string) {
  await requireUser(); await prisma.contactTag.delete({ where: { contactId_tagId: { contactId, tagId } } }).catch(() => undefined); revalidatePath(`/leads/${contactId}`);
}
export async function rescoreAll() { await requireUser(); const c = await rescoreContacts(); revalidatePath("/leads"); return `Scored ${c} leads`; }

/** Data deletion: erases the contact + history, leaving only a username tombstone so they can never be cold-messaged again. */
export async function eraseContact(contactId: string) {
  await requireUser();
  const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
  await prisma.$transaction(async (tx) => {
    await tx.suppressionEntry.upsert({ where: { usernameNormalized: c.usernameNormalized }, create: { usernameNormalized: c.usernameNormalized, reason: "erased-by-owner (tombstone)" }, update: {} });
    await tx.contact.delete({ where: { id: contactId } });
    await logActivity({ type: "contact.erased", level: "warn", message: `Erased all stored data for @${c.usernameNormalized} (username kept on suppression list)` }, tx);
  });
  redirect("/leads");
}

// ─────────── Saved filters / templates / reminders ───────────
export async function saveFilter(name: string, def: string) {
  await requireUser();
  await prisma.savedFilter.create({ data: { name: name.slice(0, 80), definition: filterSchema.parse(JSON.parse(def)) as Prisma.InputJsonValue } });
  revalidatePath("/leads");
}
export async function deleteFilter(id: string) { await requireUser(); await prisma.savedFilter.delete({ where: { id } }); revalidatePath("/leads"); }

export async function saveTemplate(f: FormData) {
  await requireUser();
  const id = s(f, "id"); const name = s(f, "name"); const body = s(f, "body");
  if (!name || !body) throw new Error("Name and body required");
  if (id) await prisma.messageTemplate.update({ where: { id }, data: { name, body } }); else await prisma.messageTemplate.create({ data: { name, body } });
  revalidatePath("/settings"); revalidatePath("/campaigns");
}
export async function deleteTemplate(id: string) { await requireUser(); await prisma.messageTemplate.delete({ where: { id } }); revalidatePath("/settings"); }

export async function addReminder(f: FormData) {
  await requireUser();
  const contactId = s(f, "contactId");
  const days = n(f, "days", 3);
  await prisma.reminder.create({ data: { contactId, kind: s(f, "kind") || "Check conversation", note: s(f, "note") || null, dueAt: new Date(Date.now() + days * 86_400_000) } });
  revalidatePath("/inbox"); revalidatePath(`/leads/${contactId}`); revalidatePath("/");
}
export async function completeReminder(id: string) { await requireUser(); await prisma.reminder.update({ where: { id }, data: { done: true } }); revalidatePath("/inbox"); revalidatePath("/"); }

// ─────────── Inbox ───────────
export async function updateConversation(id: string, patch: { status?: ConvStatus; notes?: string; tags?: string[]; unread?: boolean }) {
  await requireUser();
  const conv = await prisma.conversation.update({ where: { id }, data: patch });
  if (patch.status === "DO_NOT_CONTACT") await markDoNotContact(conv.contactId);
  if (patch.status === "INTERESTED") await setCustomerStatus(conv.contactId, "INTERESTED");
  if (patch.status === "NOT_INTERESTED") await setCustomerStatus(conv.contactId, "NOT_INTERESTED");
  if (patch.status === "POTENTIAL_CUSTOMER") await setCustomerStatus(conv.contactId, "POTENTIAL_CUSTOMER");
  if (patch.status === "CONVERTED") await setCustomerStatus(conv.contactId, "CUSTOMER");
  revalidatePath("/inbox");
}
export async function markNotificationsRead() { await requireUser(); await prisma.notification.updateMany({ where: { read: false }, data: { read: true } }); revalidatePath("/"); }

// ─────────── Settings / accounts ───────────
export async function setKillSwitch(on: boolean) {
  await requireUser();
  await setSetting("killSwitch", on);
  await logActivity({ type: on ? "killswitch.on" : "killswitch.off", level: on ? "error" : "info", message: on ? "GLOBAL EMERGENCY STOP engaged — all sending halted" : "Global emergency stop released" });
  revalidatePath("/", "layout");
}
export async function saveSettings(f: FormData) {
  await requireUser();
  const cur = await getSettings();
  const next: Partial<AppSettings> = {
    defaultTimezone: s(f, "defaultTimezone") || cur.defaultTimezone,
    defaultMaxPerHour: n(f, "defaultMaxPerHour", cur.defaultMaxPerHour), defaultMaxPerDay: n(f, "defaultMaxPerDay", cur.defaultMaxPerDay), defaultBatchSize: n(f, "defaultBatchSize", cur.defaultBatchSize),
    defaultAllowWeekends: f.get("defaultAllowWeekends") === "on", requireTemplateComplete: f.get("requireTemplateComplete") === "on",
    duplicateSimilarityThreshold: n(f, "duplicateSimilarityThreshold", cur.duplicateSimilarityThreshold), contactFrequencyDays: n(f, "contactFrequencyDays", cur.contactFrequencyDays),
    consentMaxAgeDays: n(f, "consentMaxAgeDays", cur.consentMaxAgeDays), historyMaxStaleDays: n(f, "historyMaxStaleDays", cur.historyMaxStaleDays), notifyEmail: s(f, "notifyEmail") || null,
    dmSyncIntervalMinutes: Math.max(15, n(f, "dmSyncIntervalMinutes", cur.dmSyncIntervalMinutes)), dmSyncPageSize: Math.min(100, Math.max(5, n(f, "dmSyncPageSize", cur.dmSyncPageSize))),
    autoResolveScope: (["opted_in", "campaigns", "all"].includes(s(f, "autoResolveScope")) ? s(f, "autoResolveScope") : cur.autoResolveScope) as AppSettings["autoResolveScope"],
  };
  for (const [k, v] of Object.entries(next)) await setSetting(k as keyof AppSettings, v as never);
  revalidatePath("/settings");
}
export async function setDryRun(on: boolean) {
  await requireUser(); await setSetting("dryRun", on);
  await logActivity({ type: "settings.dry_run", level: on ? "info" : "warn", message: on ? "Dry-run mode ON (nothing is transmitted)" : "LIVE mode ON — messages will be transmitted to X" });
  revalidatePath("/", "layout");
}
export async function disconnectAccount(id: string) {
  await requireUser();
  await prisma.campaign.updateMany({ where: { xAccountId: id, status: "ACTIVE" }, data: { status: "PAUSED", autoPaused: true, pauseReason: "Account disconnected" } });
  await prisma.messageJob.updateMany({ where: { xAccountId: id, status: { in: ["QUEUED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED", errorCategory: "ACCOUNT_DISCONNECTED" } });
  // Tokens are wiped; the row stays so the permanent contact ledger keeps its sender reference.
  await prisma.xAccount.update({ where: { id }, data: { status: "DISCONNECTED", accessTokenEnc: encrypt("revoked"), refreshTokenEnc: null, tokenExpiresAt: null, lastError: null } });
  await logActivity({ type: "oauth.disconnected", message: "X account disconnected; tokens wiped", xAccountId: id });
  revalidatePath("/settings");
}
export async function connectDemoAccount() {
  const user = await requireUser();
  if (process.env.X_PROVIDER === "x") throw new Error("Demo account is only available with X_PROVIDER=mock");
  await prisma.xAccount.upsert({
    where: { xUserId: "900000001" },
    create: { userId: user.id, xUserId: "900000001", username: "demo_sender", accessTokenEnc: encrypt("demo"), scopes: ["dm.read", "dm.write"], status: "ACTIVE" },
    update: { status: "ACTIVE" },
  });
  revalidatePath("/settings");
}
export async function syncNow(accountId: string) {
  await requireUser();
  await resolvePending(accountId, 100);
  const r = await syncAccount(accountId);
  revalidatePath("/settings"); revalidatePath("/inbox");
  return r.ok ? `Synced ${r.events} events, ${r.newReplies} new replies${r.truncated ? " (history truncated)" : ""}` : `Sync skipped: ${r.reason}`;
}
export async function resolveNow(accountId: string) {
  await requireUser(); const r = await resolvePending(accountId, 100); revalidatePath("/leads"); return `Resolved ${r.resolved}, failed ${r.failed}, conflicts ${r.conflicts}`;
}

// ─────────── AI drafting (reviewable only; never auto-sent) ───────────
export async function aiDraft(contactId: string, sender: string, offer: string): Promise<string> {
  await requireUser();
  const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId }, include: { consents: { where: { status: "OPTED_IN" }, orderBy: { createdAt: "desc" }, take: 1 } } });
  const text = await draftWithClaude(c, { sender: sender.slice(0, 200), offer: offer.slice(0, 500), optedInScope: c.consents[0]?.scope ?? null });
  await logActivity({ type: "ai.drafted", message: "Claude drafted a message (pending human review)", contactId });
  return text;
}

// ─────────── X developer credentials (Settings → X Integration) ───────────
// Results carry only human-readable status — never the stored ID/secret.
type CredResult = { ok: boolean | null; message: string };
const safeError = (e: unknown) => (e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : e instanceof CredentialKeyError ? e.message : "Couldn't save credentials — see server logs");

export async function saveXCredentialsAction(f: FormData): Promise<CredResult> {
  const user = await requireUser();
  if (!(await rateLimit(`cred-save:${user.id}`, 20, 3600))) return { ok: false, message: "Too many changes — try again later." };
  try {
    const r = await saveXCredentials({ clientId: s(f, "clientId"), clientSecret: s(f, "clientSecret") || null }, user.email);
    revalidatePath("/settings");
    if (!r.changed) return { ok: true, message: "Nothing changed." };
    return { ok: true, message: `Credentials saved and encrypted.${r.reconnectRequired ? ` ${r.reconnectRequired} connected account(s) must reconnect.` : ""} Next: Test Configuration, then Continue with X.` };
  } catch (e) {
    if (!(e instanceof z.ZodError) && !(e instanceof CredentialKeyError)) console.error("[x-credentials] save failed:", (e as Error).name);
    return { ok: false, message: safeError(e) };
  }
}

export async function testXConfigurationAction(): Promise<CredResult> {
  const user = await requireUser();
  if (!(await rateLimit(`cred-test:${user.id}`, 10, 3600))) return { ok: false, message: "Too many tests — try again later." };
  const r = await testXConfiguration(user.email);
  revalidatePath("/settings");
  return r;
}

export async function deleteXCredentialsAction(): Promise<CredResult> {
  const user = await requireUser();
  const r = await deleteXCredentials(user.email);
  revalidatePath("/settings");
  return { ok: true, message: r.deleted ? `Credentials deleted.${r.reconnectRequired ? ` ${r.reconnectRequired} account(s) disconnected until you reconnect.` : ""}` : "There were no saved credentials." };
}

// ─────────── Campaign ← CSV import ───────────
/**
 * Adds every lead from one CSV import to a campaign. If the import was previewed but never committed,
 * it is committed now (same dedupe rules as the Import page) straight into this campaign.
 * Membership is idempotent (unique campaign+contact), and adding leads never sends anything by itself.
 */
export async function addImportToCampaign(campaignId: string, importId: string): Promise<{ ok: boolean; message: string }> {
  await requireUser();
  const [camp, imp] = await Promise.all([prisma.campaign.findUnique({ where: { id: campaignId } }), prisma.csvImport.findUnique({ where: { id: importId } })]);
  if (!camp || camp.status === "ARCHIVED") return { ok: false, message: "Campaign not found or archived." };
  if (!imp) return { ok: false, message: "Import not found." };
  try {
    if (imp.status === "PREVIEWED") {
      const before = await prisma.campaignContact.count({ where: { campaignId } });
      const r = await commitImport(importId, { campaignId });
      const added = (await prisma.campaignContact.count({ where: { campaignId } })) - before;
      revalidatePath(`/campaigns/${campaignId}`); revalidatePath("/leads"); revalidatePath("/import");
      return { ok: true, message: `Imported ${imp.filename}: ${r.created} new contacts saved, ${added} lead(s) added to this campaign.` };
    }
    if (imp.status !== "COMMITTED") return { ok: false, message: `This import is ${imp.status.toLowerCase()} — open Import CSV to preview it first.` };
    const rows = await prisma.csvImportRow.findMany({ where: { importId, contactId: { not: null } }, select: { contactId: true }, distinct: ["contactId"] });
    const r = await prisma.campaignContact.createMany({ data: rows.map((x) => ({ campaignId, contactId: x.contactId! })), skipDuplicates: true });
    await logActivity({ type: "campaign.contacts_added", message: `Added ${r.count} lead(s) from ${imp.filename} to campaign`, campaignId, meta: { importId } });
    revalidatePath(`/campaigns/${campaignId}`); revalidatePath("/leads");
    return { ok: true, message: r.count ? `Added ${r.count} lead(s) from ${imp.filename}.${rows.length - r.count ? ` ${rows.length - r.count} were already in this campaign.` : ""}` : `All ${rows.length} leads from ${imp.filename} are already in this campaign.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 200) };
  }
}
