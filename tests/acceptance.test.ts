import { readFileSync } from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, previewImport, stageImport } from "@/lib/import";
import { recordConsent } from "@/lib/consent";
import { runSchedulerTick, setCampaignStatus, approveAllForTest } from "./acceptance-helpers";
import { setSetting } from "@/lib/settings";
import { mockProvider } from "@/lib/provider";
import { syncAccount } from "@/lib/sync";
import { resolvePending } from "@/lib/resolve";
import { NOW, makeAccount, makeCampaign, resetDb } from "./helpers";
import { toCsv } from "@/lib/csv";

beforeEach(resetDb);

describe("acceptance: 300-username CSV → dry run → live (mock) → restart-safe", () => {
  it("passes the end-to-end scenario", async () => {
    const file = readFileSync("samples/founders-300.csv");
    const acc = await makeAccount({ lastSyncAt: null });
    const camp = await makeCampaign(acc.id, { requireApproval: true, schedule: { maxPerDay: 1000 } });

    // 1–2. upload 300 rows, duplicates removed automatically
    const s = await stageImport("founders-300.csv", file);
    expect(s.totalRows).toBe(300);
    const c = await previewImport(s.importId, s.mapping);
    expect(c).toMatchObject({ total: 300, valid: 296, newRows: 296, dupInFile: 2, invalid: 2 });
    await commitImport(s.importId, { campaignId: camp.id });
    expect(await prisma.contact.count()).toBe(296);

    // 3. re-import: nothing duplicated
    const s2 = await stageImport("founders-300.csv", file);
    expect(await previewImport(s2.importId, s2.mapping)).toMatchObject({ newRows: 0, existing: 296 });
    await commitImport(s2.importId, { campaignId: camp.id });
    expect(await prisma.contact.count()).toBe(296);
    expect(await prisma.campaignContact.count()).toBe(296);

    // 7. cold leads (no documented consent) → manual queue, never automated
    expect(await prisma.contact.count({ where: { consentStatus: "UNKNOWN" } })).toBe(296);
    await resolvePending(acc.id, 500, mockProvider);
    await syncAccount(acc.id, mockProvider);
    await runSchedulerTick("w", NOW);
    expect(await prisma.messageJob.count()).toBe(0);

    // 6. only properly-eligible recipients are queued: record opt-in for 12 of them
    const optedIn = await prisma.contact.findMany({ take: 12, orderBy: { usernameNormalized: "asc" } });
    for (const o of optedIn) await recordConsent(o.id, { status: "OPTED_IN", source: "newsletter-form", evidence: `https://example.com/optin/${o.usernameNormalized}`, scope: "DMs" });
    await runSchedulerTick("w", NOW);
    expect(await prisma.messageJob.count()).toBe(12);
    expect(await prisma.messageJob.count({ where: { status: "PENDING_APPROVAL" } })).toBe(12);

    // 15. DRY RUN: approve, run, nothing leaves the building
    await setSetting("dryRun", true);
    await approveAllForTest();
    for (let i = 0; i < 12; i++) await runSchedulerTick("w", new Date(NOW.getTime() + i * 60_000));
    expect(await prisma.messageJob.count({ where: { status: "DRY_RUN" } })).toBe(12);
    expect(mockProvider.sendCalls).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });
});
