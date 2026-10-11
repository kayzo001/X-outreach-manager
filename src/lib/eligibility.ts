import { prisma, Tx } from "./db";
import { consentIsValid } from "./consent";
import { getSettings, AppSettings } from "./settings";

export type Blocker =
  | "KILL_SWITCH" | "DO_NOT_CONTACT" | "SUPPRESSED" | "OPTED_OUT" | "NO_CONSENT" | "CONSENT_EXPIRED"
  | "UNRESOLVED" | "RECIPIENT_UNAVAILABLE" | "ALREADY_MESSAGED" | "EXISTING_CONVERSATION" | "REPLIED"
  | "BLOCKED" | "ALREADY_QUEUED" | "UNCERTAIN_PENDING" | "FREQUENCY_LIMIT" | "HISTORY_STALE" | "HISTORY_UNKNOWN" | "NOT_INTERESTED" | "ACCOUNT_INACTIVE";

export const BLOCKER_LABEL: Record<Blocker, string> = {
  KILL_SWITCH: "Global emergency stop is on",
  DO_NOT_CONTACT: "Marked do-not-contact",
  SUPPRESSED: "On permanent suppression list",
  OPTED_OUT: "Recipient opted out",
  NO_CONSENT: "No documented opt-in for automated DMs",
  CONSENT_EXPIRED: "Opt-in has expired",
  UNRESOLVED: "X user ID not resolved yet",
  RECIPIENT_UNAVAILABLE: "Account not found or suspended",
  ALREADY_MESSAGED: "Already received a message",
  EXISTING_CONVERSATION: "Existing DM conversation",
  REPLIED: "Recipient has replied",
  BLOCKED: "Conversation marked do-not-contact",
  ALREADY_QUEUED: "Already queued in another job",
  UNCERTAIN_PENDING: "Earlier delivery result is unconfirmed",
  FREQUENCY_LIMIT: "Contacted too recently (frequency limit)",
  HISTORY_STALE: "DM history has not been synced recently",
  HISTORY_UNKNOWN: "This lead's DM history hasn't been checked yet",
  NOT_INTERESTED: "Marked not interested",
  ACCOUNT_INACTIVE: "Sending account is not connected",
};

export interface EligibilityResult { ok: boolean; blockers: Blocker[]; consentRecordId: string | null }

/**
 * THE gate for automated sends. Called at planning time and again inside the claim transaction.
 * `ignoreJobId` lets a job ignore itself when re-checked at send time.
 */
export async function checkAutomatedEligibility(
  db: Tx, p: { contactId: string; xAccountId: string; ignoreJobId?: string; now?: Date; settings?: AppSettings },
): Promise<EligibilityResult> {
  const now = p.now ?? new Date();
  const settings = p.settings ?? (await getSettings(db));
  const blockers = new Set<Blocker>();
  if (settings.killSwitch) blockers.add("KILL_SWITCH");

  const [contact, account] = await Promise.all([
    db.contact.findUnique({ where: { id: p.contactId } }),
    db.xAccount.findUnique({ where: { id: p.xAccountId } }),
  ]);
  if (!contact) throw new Error("Contact not found");
  if (!account || account.status !== "ACTIVE") blockers.add("ACCOUNT_INACTIVE");

  if (contact.doNotContact) blockers.add("DO_NOT_CONTACT");
  if (contact.customerStatus === "NOT_INTERESTED") blockers.add("NOT_INTERESTED");
  if (contact.consentStatus === "OPTED_OUT") blockers.add("OPTED_OUT");
  if (!contact.xUserId) blockers.add("UNRESOLVED");
  if (contact.resolveStatus === "NOT_FOUND" || contact.resolveStatus === "SUSPENDED") blockers.add("RECIPIENT_UNAVAILABLE");
  if (contact.manualStatus === "REPLIED") blockers.add("REPLIED");
  if (contact.historyStatus === "CONTACTED") blockers.add("ALREADY_MESSAGED");
  if (contact.historyStatus === "UNKNOWN") blockers.add("HISTORY_UNKNOWN");

  const supp = await db.suppressionEntry.findFirst({
    where: { OR: [{ usernameNormalized: contact.usernameNormalized }, ...(contact.xUserId ? [{ xUserId: contact.xUserId }] : [])] },
  });
  if (supp) blockers.add("SUPPRESSED");

  // Consent: latest record only, must be a documented opt-in.
  const consent = await db.consentRecord.findFirst({ where: { contactId: p.contactId }, orderBy: { createdAt: "desc" } });
  const cv = consentIsValid(consent, p.xAccountId, settings.consentMaxAgeDays, now);
  if (!cv.ok) blockers.add(cv.code);

  // Permanent history: ledger (any state except VOID) for this sender…
  const ledger = await db.outreachLedger.findUnique({ where: { xAccountId_contactId: { xAccountId: p.xAccountId, contactId: p.contactId } } });
  if (ledger && ledger.state !== "VOID") {
    if (ledger.state === "UNCERTAIN") blockers.add("UNCERTAIN_PENDING");
    else if (!(ledger.state === "RESERVED" && ledger.jobId === p.ignoreJobId)) blockers.add("ALREADY_MESSAGED");
  }
  // …and ANY outgoing message to this person from ANY of our accounts / campaigns / manual.
  const lastOut = await db.message.findFirst({ where: { contactId: p.contactId, direction: "OUT" }, orderBy: { sentAt: "desc" } });
  if (lastOut) {
    blockers.add("ALREADY_MESSAGED");
    if (settings.contactFrequencyDays > 0 && now.getTime() - lastOut.sentAt.getTime() < settings.contactFrequencyDays * 86_400_000) blockers.add("FREQUENCY_LIMIT");
  }

  const conv = await db.conversation.findFirst({ where: { contactId: p.contactId, xAccountId: p.xAccountId } });
  if (conv) {
    blockers.add("EXISTING_CONVERSATION");
    if (conv.replied) blockers.add("REPLIED");
    if (conv.status === "DO_NOT_CONTACT") blockers.add("BLOCKED");
  }

  const live = await db.messageJob.findFirst({
    where: { contactId: p.contactId, xAccountId: p.xAccountId, status: { in: ["PENDING_APPROVAL", "QUEUED", "SENDING", "UNCERTAIN"] }, ...(p.ignoreJobId ? { id: { not: p.ignoreJobId } } : {}) },
  });
  if (live) blockers.add(live.status === "UNCERTAIN" ? "UNCERTAIN_PENDING" : "ALREADY_QUEUED");

  // History must have been synced recently, else we can't claim to know about prior threads.
  if (account && settings.historyMaxStaleDays > 0) {
    if (!account.lastSyncAt || now.getTime() - account.lastSyncAt.getTime() > settings.historyMaxStaleDays * 86_400_000) blockers.add("HISTORY_STALE");
  }

  return { ok: blockers.size === 0, blockers: [...blockers], consentRecordId: consent?.id ?? null };
}

/** Lightweight read-only classification for UIs (manual vs automated lanes). */
export function manualLaneReason(c: { consentStatus: string; doNotContact: boolean; historyStatus: string; manualStatus: string | null }) {
  if (c.doNotContact || c.consentStatus === "OPTED_OUT") return "blocked";
  if (c.manualStatus === "CONTACTED" || c.manualStatus === "REPLIED" || c.historyStatus === "CONTACTED") return "done";
  return "open";
}

export { prisma };
