import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { XProvider } from "@/lib/provider/x";
import { mockProvider } from "@/lib/provider";
import { syncAccount } from "@/lib/sync";
import { resolvePending } from "@/lib/resolve";
import { checkAutomatedEligibility } from "@/lib/eligibility";
import { encrypt } from "@/lib/crypto";
import { NOW, makeAccount, makeContact, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("DM sync cost controls (real X client, stubbed HTTP)", () => {
  it("incremental sync uses small pages and stops at the first page with an already-known event", async () => {
    const acc = await makeAccount({ tokenExpiresAt: new Date(Date.now() + 3600_000), accessTokenEnc: encrypt("tok") });
    const c = await makeContact("alice");
    await prisma.message.create({ data: { contactId: c.id, xAccountId: acc.id, direction: "OUT", xEventId: "known-1", text: "old", sentAt: new Date() } });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const page = urls.length;
      const data = page === 1 ? [{ id: "new-1", text: "hi", sender_id: "id_alice", dm_conversation_id: "1000-id_alice", created_at: new Date().toISOString(), participant_ids: ["1000", "id_alice"] }, { id: "known-1", text: "old", sender_id: "1000", dm_conversation_id: "1000-id_alice", created_at: new Date().toISOString() }] : [];
      return new Response(JSON.stringify({ data, meta: { next_token: "more" } }), { status: 200 });
    }));
    const r = await syncAccount(acc.id, new XProvider());
    expect(r.ok).toBe(true);
    expect(urls).toHaveLength(1);                         // did NOT page further into known history
    expect(urls[0]).toContain("max_results=20");          // default incremental page size
    expect(await prisma.message.count({ where: { direction: "IN" } })).toBe(1);
  });
});

describe("targeted history check for newly resolved leads", () => {
  it("an old thread with a lead resolved AFTER the last sync is still found and blocks automation", async () => {
    const acc = await makeAccount(); // already synced (lastSyncAt set)
    const c = await prisma.contact.create({ data: { usernameNormalized: "late", usernameDisplay: "late" } });
    await prisma.consentRecord.create({ data: { contactId: c.id, status: "OPTED_IN", source: "f", evidence: "e" } });
    await prisma.contact.update({ where: { id: c.id }, data: { consentStatus: "OPTED_IN" } });
    const xid = mockProvider.idFor("late");
    mockProvider.inbound.push({ id: "ancient", conversationId: `1000-${xid}`, senderId: "1000", text: "we talked before", createdAt: new Date(NOW.getTime() - 20 * 86400000), participantIds: ["1000", xid] });

    // Before resolution + check, automation is blocked as UNRESOLVED / HISTORY_UNKNOWN
    expect((await checkAutomatedEligibility(prisma, { contactId: c.id, xAccountId: acc.id, now: NOW })).blockers).toEqual(expect.arrayContaining(["UNRESOLVED", "HISTORY_UNKNOWN"]));
    await resolvePending(acc.id, 100, mockProvider, "opted_in");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.historyStatus).toBe("CONTACTED");
    expect((await checkAutomatedEligibility(prisma, { contactId: c.id, xAccountId: acc.id, now: NOW })).blockers).toContain("ALREADY_MESSAGED");
  });

  it("no thread found → NONE_FOUND (not 'never contacted'), and lookup failure keeps it blocked", async () => {
    const acc = await makeAccount();
    const a = await prisma.contact.create({ data: { usernameNormalized: "fresh", usernameDisplay: "fresh" } });
    await resolvePending(acc.id, 100, mockProvider);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: a.id } })).historyStatus).toBe("NONE_FOUND");

    const b = await prisma.contact.create({ data: { usernameNormalized: "flaky", usernameDisplay: "flaky" } });
    mockProvider.lookupFails = true;
    await resolvePending(acc.id, 100, mockProvider);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: b.id } })).historyStatus).toBe("UNKNOWN");
  });

  it("worker-style auto-resolve only spends on opted-in leads by default", async () => {
    const acc = await makeAccount();
    await prisma.contact.create({ data: { usernameNormalized: "cold1", usernameDisplay: "cold1" } });
    const warm = await prisma.contact.create({ data: { usernameNormalized: "warm1", usernameDisplay: "warm1", consentStatus: "OPTED_IN" } });
    const r = await resolvePending(acc.id, 100, mockProvider, "opted_in");
    expect(r.resolved).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: warm.id } })).xUserId).not.toBeNull();
    expect((await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "cold1" } })).xUserId).toBeNull();
  });
});
