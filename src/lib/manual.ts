import { prisma } from "./db";
import { logActivity } from "./activity";
import { suppressContact } from "./consent";
import type { CustomerStatus, ManualStatus } from "@prisma/client";

/** Records a message the user sent by hand on X. Feeds the SAME dedupe data as automated sends. */
export async function recordManualSend(contactId: string, o: { campaignId?: string | null; text?: string | null; xAccountId?: string | null } = {}) {
  const now = new Date();
  const acc = o.xAccountId ? { id: o.xAccountId } : await prisma.xAccount.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    await tx.message.create({ data: { contactId, campaignId: o.campaignId ?? null, xAccountId: acc?.id ?? null, direction: "OUT", text: o.text?.trim() || "(sent manually on X)", manual: true, sentAt: now } });
    await tx.contact.update({ where: { id: contactId }, data: { manualStatus: "CONTACTED", historyStatus: "CONTACTED" } });
    if (acc) await tx.outreachLedger.upsert({ where: { xAccountId_contactId: { xAccountId: acc.id, contactId } }, create: { xAccountId: acc.id, contactId, state: "MANUAL", campaignId: o.campaignId ?? null }, update: { state: "MANUAL" } });
    // Anything automated still queued for this person must not fire.
    await tx.messageJob.updateMany({ where: { contactId, status: { in: ["QUEUED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED", errorCategory: "MANUAL_CONTACT", lastError: "Contacted manually" } });
    await logActivity({ type: "manual.contacted", message: "Marked contacted (manual send)", contactId, campaignId: o.campaignId }, tx);
  });
}

export async function markManual(contactId: string, status: ManualStatus) {
  await prisma.contact.update({ where: { id: contactId }, data: { manualStatus: status, ...(status === "REPLIED" ? { historyStatus: "CONTACTED" } : {}) } });
  if (status === "REPLIED") await prisma.messageJob.updateMany({ where: { contactId, status: { in: ["QUEUED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED", errorCategory: "REPLIED" } });
  await logActivity({ type: `manual.${status.toLowerCase()}`, message: `Marked ${status.toLowerCase()}`, contactId });
}

export async function setCustomerStatus(contactId: string, status: CustomerStatus) {
  await prisma.contact.update({ where: { id: contactId }, data: { customerStatus: status } });
  if (status === "NOT_INTERESTED") await prisma.messageJob.updateMany({ where: { contactId, status: { in: ["QUEUED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED", errorCategory: "NOT_INTERESTED" } });
  await logActivity({ type: "contact.status", message: `Status set to ${status}`, contactId });
}

export async function markDoNotContact(contactId: string) {
  await suppressContact(contactId, "manual do-not-contact");
}
