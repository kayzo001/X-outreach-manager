import { prisma } from "./db";
import { logActivity } from "./activity";
import { providerFor, DmProvider, DmEvent } from "./provider";
import { looksLikeOptOut, suppressContact } from "./consent";
import { notify } from "./notify";
import { getSettings } from "./settings";

/**
 * Pull DM events from X (≈30-day window), link them to known contacts, and record:
 * existing threads, last in/out messages, replies, opt-outs.
 * Events involving people we don't have a resolved contact for are counted, not guessed at.
 */
export async function syncAccount(accountId: string, providerOverride?: DmProvider) {
  const acc = await prisma.xAccount.findUniqueOrThrow({ where: { id: accountId } });
  const provider = providerOverride ?? providerFor(acc);
  if (acc.status !== "ACTIVE") return { ok: false as const, reason: "account inactive" };
  // First sync: up to 5×100 events (one-off). Afterwards: small pages, stop at the first already-known event.
  const known = new Set((await prisma.message.findMany({ where: { xAccountId: acc.id, xEventId: { not: null }, sentAt: { gte: new Date(Date.now() - 31 * 86_400_000) } }, select: { xEventId: true } })).map((m) => m.xEventId!));
  const first = !acc.lastSyncAt;
  const res = await provider.listDmEvents({ id: acc.id, xUserId: acc.xUserId, username: acc.username }, first ? { maxPages: 5, pageSize: 100 } : { maxPages: 5, pageSize: (await getSettings()).dmSyncPageSize, isKnown: (id) => known.has(id) });
  if ("error" in res) {
    if (res.error === "rate_limited") { await prisma.xAccount.update({ where: { id: acc.id }, data: { rateLimitedUntil: res.resetAt } }); return { ok: false as const, reason: "rate limited" }; }
    await prisma.xAccount.update({ where: { id: acc.id }, data: { status: "REVOKED" } });
    return { ok: false as const, reason: "auth" };
  }
  const stats = newStats(res.events.length);
  const ordered = [...res.events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const ev of ordered) {
    const otherId = otherParticipant(ev, acc.xUserId);
    const contact = otherId ? await prisma.contact.findUnique({ where: { xUserId: otherId } }) : null;
    if (!contact) { stats.unmatched++; continue; }
    await ingestEvent(acc, contact, ev, stats);
  }
  // Only a complete first read proves "no thread in the 30-day window" for every resolved contact.
  // Contacts resolved later get a targeted per-contact check (checkContactHistory). "None found" ≠ "never contacted".
  if (first && !res.truncated) await prisma.contact.updateMany({ where: { historyStatus: "UNKNOWN", xUserId: { not: null }, conversations: { none: {} } }, data: { historyStatus: "NONE_FOUND" } });
  await prisma.xAccount.update({ where: { id: acc.id }, data: { lastSyncAt: new Date() } });
  await logActivity({ type: "sync.completed", message: `DM sync: ${stats.events} events, ${stats.linked} linked, ${stats.newReplies} new replies${res.truncated ? " (history truncated)" : ""}`, xAccountId: acc.id, meta: stats });
  return { ok: true as const, truncated: res.truncated, ...stats };
}

type Stats = ReturnType<typeof newStats>;
const newStats = (events: number) => ({ events, linked: 0, inbound: 0, newReplies: 0, optOuts: 0, unmatched: 0, externalOutbound: 0 });

/** Records one DM event for a known contact. Idempotent on the X event id. */
async function ingestEvent(acc: { id: string; xUserId: string }, contact: { id: string; usernameNormalized: string }, ev: DmEvent, stats: Stats) {
  stats.linked++;
  const inbound = ev.senderId !== acc.xUserId;
  if (await prisma.message.findUnique({ where: { xEventId: ev.id } })) return;
  const conv = await prisma.conversation.upsert({
    where: { xAccountId_contactId: { xAccountId: acc.id, contactId: contact.id } },
    create: { xAccountId: acc.id, contactId: contact.id, xConversationId: ev.conversationId },
    update: { xConversationId: ev.conversationId },
  });
  // An outgoing DM we already recorded as "marked contacted" (manual, no X id yet) is the same message — link it, don't double count.
  const manualTwin = inbound ? null : await prisma.message.findFirst({ where: { contactId: contact.id, direction: "OUT", manual: true, xEventId: null, sentAt: { gte: new Date(ev.createdAt.getTime() - 3 * 86_400_000), lte: new Date(ev.createdAt.getTime() + 3 * 86_400_000) } } });
  if (manualTwin) await prisma.message.update({ where: { id: manualTwin.id }, data: { xEventId: ev.id, conversationId: conv.id, xAccountId: acc.id, sentAt: ev.createdAt } });
  else await prisma.message.create({ data: { contactId: contact.id, xAccountId: acc.id, conversationId: conv.id, direction: inbound ? "IN" : "OUT", xEventId: ev.id, text: ev.text, sentAt: ev.createdAt, manual: !inbound } });

  if (inbound) {
    stats.inbound++;
    const wasReplied = conv.replied;
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastIncomingAt: ev.createdAt, replied: true, unread: true, lastPreview: ev.text.slice(0, 140) } });
    await prisma.contact.update({ where: { id: contact.id }, data: { manualStatus: "REPLIED", historyStatus: "CONTACTED" } });
    // A reply ends automation for that person immediately.
    const cancelled = await prisma.messageJob.updateMany({ where: { contactId: contact.id, status: { in: ["QUEUED", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED", errorCategory: "REPLIED", lastError: "Recipient replied" } });
    if (!wasReplied) {
      stats.newReplies++;
      await prisma.reminder.updateMany({ where: { contactId: contact.id, done: false, kind: "Check for reply" }, data: { done: true } });
      await logActivity({ type: "reply.received", message: `Reply from @${contact.usernameNormalized}${cancelled.count ? ` — ${cancelled.count} pending message(s) cancelled` : ""}`, contactId: contact.id, xAccountId: acc.id });
      await notify("reply", `New reply from @${contact.usernameNormalized}`, ev.text.slice(0, 200), contact.id);
    }
    if (looksLikeOptOut(ev.text)) {
      stats.optOuts++;
      await prisma.consentRecord.create({ data: { contactId: contact.id, status: "OPTED_OUT", source: "inbound-dm", evidence: `DM ${ev.id}: "${ev.text.slice(0, 120)}"`, xAccountId: acc.id } });
      await suppressContact(contact.id, "inbound opt-out keyword");
      await notify("opt_out", `@${contact.usernameNormalized} opted out`, "Added to the permanent suppression list.", contact.id);
    }
  } else {
    // Outgoing message we have no record of (sent from X directly, or a previous tool): counts as prior contact.
    stats.externalOutbound++;
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastOutgoingAt: ev.createdAt, lastPreview: ev.text.slice(0, 140) } });
    await prisma.contact.update({ where: { id: contact.id }, data: { historyStatus: "CONTACTED" } });
    await prisma.outreachLedger.upsert({
      where: { xAccountId_contactId: { xAccountId: acc.id, contactId: contact.id } },
      create: { xAccountId: acc.id, contactId: contact.id, state: "MANUAL" }, update: {},
    }).catch(() => undefined);
  }
}

/**
 * Targeted history check for specific contacts (e.g. just resolved): reads only their 1:1 thread (≤10 events each).
 * Lookup failure leaves the contact UNKNOWN, which keeps automation blocked for them.
 */
export async function checkContactHistory(accountId: string, contactIds: string[], providerOverride?: DmProvider) {
  const acc = await prisma.xAccount.findUniqueOrThrow({ where: { id: accountId } });
  const provider = providerOverride ?? providerFor(acc);
  // Includes leads already marked contacted by hand: their thread holds the DM you sent and any reply.
  const contacts = await prisma.contact.findMany({ where: { id: { in: contactIds }, xUserId: { not: null } } });
  const stats = newStats(0);
  let checked = 0;
  for (const c of contacts) {
    const events = await provider.listConversationWith({ id: acc.id, xUserId: acc.xUserId, username: acc.username }, c.xUserId!);
    if (events === null) continue;
    checked++; stats.events += events.length;
    for (const ev of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) await ingestEvent(acc, c, ev, stats);
    if (!events.length) await prisma.contact.updateMany({ where: { id: c.id, historyStatus: "UNKNOWN" }, data: { historyStatus: "NONE_FOUND" } });
  }
  return { checked, ...stats };
}

function otherParticipant(ev: DmEvent, me: string): string | null {
  if (ev.participantIds?.length) return ev.participantIds.find((p) => p !== me) ?? null;
  const parts = ev.conversationId.split("-"); // 1:1 conversation ids are "<idA>-<idB>"
  if (parts.length === 2 && parts.includes(me)) return parts.find((p) => p !== me)!;
  return ev.senderId !== me ? ev.senderId : null;
}
