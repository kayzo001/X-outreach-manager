import { prisma, Tx } from "./db";
import { logActivity } from "./activity";
import type { ConsentStatus } from "@prisma/client";

export interface ConsentInput {
  status: ConsentStatus;
  source: string;          // e.g. "reply-to-lead-magnet", "form:newsletter", "inbound-dm"
  evidence?: string | null; // URL / quote / reference — REQUIRED for OPTED_IN
  scope?: string | null;   // e.g. "product updates by DM"
  xAccountId?: string | null;
  expiresAt?: Date | null;
}

const OPT_OUT_PATTERNS = [
  /^\s*(stop|unsubscribe|optout|opt-out|opt out|cancel|remove me|end|quit)\s*[.!]*\s*$/i,
  /\b(stop (messaging|dm'?ing|contacting|sending)|don'?t (message|dm|contact) me|do not (message|dm|contact)|unsubscribe me|remove me from)\b/i,
];
export const looksLikeOptOut = (text: string) => OPT_OUT_PATTERNS.some((r) => r.test(text));

/** Append-only consent history; keeps Contact.consentStatus (denormalised) in sync. */
export async function recordConsent(contactId: string, input: ConsentInput, db: Tx = prisma) {
  if (input.status === "OPTED_IN" && !input.evidence?.trim()) throw new Error("Opt-in requires evidence (URL, quote or reference)");
  const rec = await db.consentRecord.create({
    data: { contactId, status: input.status, source: input.source, evidence: input.evidence ?? null, scope: input.scope ?? null, xAccountId: input.xAccountId ?? null, expiresAt: input.expiresAt ?? null, lastCheckedAt: new Date() },
  });
  await db.contact.update({ where: { id: contactId }, data: { consentStatus: input.status } });
  await logActivity({ type: "consent.recorded", message: `Consent set to ${input.status} (${input.source})`, contactId, consentRecordId: rec.id, xAccountId: input.xAccountId }, db);
  if (input.status === "OPTED_OUT") await suppressContact(contactId, `consent:${input.source}`, db);
  return rec;
}

/** Permanent suppression + cancel anything still queued. */
export async function suppressContact(contactId: string, reason: string, db: Tx = prisma) {
  const c = await db.contact.findUniqueOrThrow({ where: { id: contactId } });
  await db.suppressionEntry.upsert({
    where: { usernameNormalized: c.usernameNormalized },
    create: { usernameNormalized: c.usernameNormalized, xUserId: c.xUserId, contactId, reason },
    update: { xUserId: c.xUserId ?? undefined },
  }).catch(async () => { /* xUserId unique collision: row already exists for that id */ });
  await db.contact.update({ where: { id: contactId }, data: { consentStatus: "OPTED_OUT", doNotContact: true } });
  const cancelled = await db.messageJob.updateMany({
    where: { contactId, status: { in: ["QUEUED", "PENDING_APPROVAL"] } },
    data: { status: "CANCELLED", lastError: "Contact suppressed / opted out", errorCategory: "OPT_OUT" },
  });
  await logActivity({ type: "contact.suppressed", level: "warn", message: `Contact suppressed (${reason}); ${cancelled.count} pending job(s) cancelled`, contactId }, db);
}

export async function latestConsent(contactId: string, db: Tx = prisma) {
  return db.consentRecord.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" } });
}

export function consentIsValid(
  rec: { status: ConsentStatus; evidence: string | null; grantedAt: Date; expiresAt: Date | null; xAccountId: string | null } | null,
  xAccountId: string, maxAgeDays: number, now = new Date(),
): { ok: true } | { ok: false; code: "NO_CONSENT" | "CONSENT_EXPIRED" | "OPTED_OUT" } {
  if (!rec) return { ok: false, code: "NO_CONSENT" };
  if (rec.status === "OPTED_OUT") return { ok: false, code: "OPTED_OUT" };
  if (rec.status === "EXPIRED") return { ok: false, code: "CONSENT_EXPIRED" };
  if (rec.status !== "OPTED_IN" || !rec.evidence?.trim()) return { ok: false, code: "NO_CONSENT" };
  if (rec.xAccountId && rec.xAccountId !== xAccountId) return { ok: false, code: "NO_CONSENT" };
  if (rec.expiresAt && rec.expiresAt <= now) return { ok: false, code: "CONSENT_EXPIRED" };
  if (maxAgeDays > 0 && now.getTime() - rec.grantedAt.getTime() > maxAgeDays * 86_400_000) return { ok: false, code: "CONSENT_EXPIRED" };
  return { ok: true };
}
