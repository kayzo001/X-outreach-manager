import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { syncAccount } from "@/lib/sync";
import { planCampaign, runSchedulerTick } from "@/lib/engine";
import { mockProvider } from "@/lib/provider";
import { resolvePending } from "@/lib/resolve";
import { NOW, makeAccount, makeCampaign, makeContact, resetDb } from "./helpers";

beforeEach(resetDb);
const inbound = (from: string, text: string, id = "in1") => ({ id, conversationId: `1000-${from}`, senderId: from, text, createdAt: new Date(NOW.getTime() - 1000), participantIds: ["1000", from] });

describe("inbox sync / replies / existing DMs", () => {
  it("detects an existing thread and blocks automation for that contact", async () => {
    const acc = await makeAccount({ lastSyncAt: null });
    const camp = await makeCampaign(acc.id);
    const c = await makeContact("alice", { campaignId: camp.id });
    mockProvider.inbound.push({ id: "old_out", conversationId: "1000-id_alice", senderId: "1000", text: "hello earlier", createdAt: new Date(NOW.getTime() - 86400000), participantIds: ["1000", "id_alice"] });
    const r = await syncAccount(acc.id, mockProvider);
    expect(r.ok && r.externalOutbound).toBe(1);
    expect(await prisma.conversation.count({ where: { contactId: c.id } })).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).historyStatus).toBe("CONTACTED");
    const p = await planCampaign(camp.id);
    expect(p.created).toBe(0);
    expect(p.blocked.EXISTING_CONVERSATION).toBe(1);
  });
  it("contacts without a visible thread become NONE_FOUND (never 'never messaged'), and sync is idempotent", async () => {
    const acc = await makeAccount({ lastSyncAt: null });
    const c = await makeContact("bob");
    await prisma.contact.update({ where: { id: c.id }, data: { historyStatus: "UNKNOWN" } });
    await syncAccount(acc.id, mockProvider); await syncAccount(acc.id, mockProvider);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).historyStatus).toBe("NONE_FOUND");
  });
  it("a reply marks replied, notifies, cancels pending messages and stops follow-ups", async () => {
    const acc = await makeAccount();
    const camp = await makeCampaign(acc.id, { requireApproval: true });
    const c = await makeContact("alice", { campaignId: camp.id });
    await planCampaign(camp.id);
    mockProvider.inbound.push(inbound("id_alice", "Sounds interesting, tell me more"));
    const r = await syncAccount(acc.id, mockProvider);
    expect(r.ok && r.newReplies).toBe(1);
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv).toMatchObject({ replied: true, unread: true });
    expect(await prisma.notification.count({ where: { type: "reply" } })).toBe(1);
    expect(await prisma.messageJob.count({ where: { status: "CANCELLED", errorCategory: "REPLIED" } })).toBe(1);
    await syncAccount(acc.id, mockProvider); // idempotent
    expect(await prisma.notification.count({ where: { type: "reply" } })).toBe(1);
    expect(await prisma.message.count({ where: { direction: "IN" } })).toBe(1);
  });
  it("a STOP reply is auto-detected as an opt-out and permanently suppressed", async () => {
    const acc = await makeAccount();
    const camp = await makeCampaign(acc.id);
    const c = await makeContact("alice", { campaignId: camp.id });
    mockProvider.inbound.push(inbound("id_alice", "STOP"));
    await syncAccount(acc.id, mockProvider);
    expect(await prisma.suppressionEntry.count({ where: { usernameNormalized: "alice" } })).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).consentStatus).toBe("OPTED_OUT");
    await runSchedulerTick("w", NOW);
    expect(mockProvider.sent).toHaveLength(0);
  });
  it("unmatched senders are counted, not guessed", async () => {
    const acc = await makeAccount();
    mockProvider.inbound.push(inbound("999999", "hi"));
    const r = await syncAccount(acc.id, mockProvider);
    expect(r.ok && r.unmatched).toBe(1);
  });
  it("resolves usernames to stable X ids and flags missing/suspended accounts", async () => {
    const acc = await makeAccount();
    await makeContact("ok1", { resolved: false, consent: false });
    await makeContact("gone", { resolved: false, consent: false });
    await makeContact("susp", { resolved: false, consent: false });
    mockProvider.missingUsers.add("gone"); mockProvider.suspendedUsers.add("susp");
    const r = await resolvePending(acc.id, 100, mockProvider);
    expect(r).toMatchObject({ resolved: 1, failed: 2 });
    expect(await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "ok1" } })).toMatchObject({ resolveStatus: "RESOLVED", xUserId: mockProvider.idFor("ok1") });
    expect((await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "susp" } })).resolveStatus).toBe("SUSPENDED");
  });
});
