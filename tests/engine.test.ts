import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { claimNextJob, executeClaimedJob, planCampaign, reconcileUncertain, recoverStaleSending, runSchedulerTick, setCampaignStatus } from "@/lib/engine";
import { checkAutomatedEligibility } from "@/lib/eligibility";
import { recordConsent, suppressContact } from "@/lib/consent";
import { setSetting } from "@/lib/settings";
import { mockProvider } from "@/lib/provider";
import { recordManualSend } from "@/lib/manual";
import { NOW, makeAccount, makeCampaign, makeContact, resetDb } from "./helpers";

const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
async function setup(n = 1, o: Parameters<typeof makeCampaign>[1] = {}) {
  const acc = await makeAccount();
  const camp = await makeCampaign(acc.id, o);
  const contacts = [];
  for (let i = 0; i < n; i++) contacts.push(await makeContact(`lead${i}`, { campaignId: camp.id }));
  return { acc, camp, contacts };
}
const tick = (t = NOW) => runSchedulerTick("w1", t);

beforeEach(resetDb);

describe("consent enforcement", () => {
  it("queues only contacts with a documented opt-in; others stay out", async () => {
    const { camp } = await setup(1);
    await makeContact("cold", { consent: false, campaignId: camp.id });
    const p = await planCampaign(camp.id);
    expect(p.created).toBe(1);
    expect(p.blocked.NO_CONSENT).toBe(1);
    expect(await prisma.messageJob.count()).toBe(1);
  });
  it("an opt-in without evidence is rejected", async () => {
    const c = await makeContact("x", { consent: false });
    await expect(recordConsent(c.id, { status: "OPTED_IN", source: "csv" })).rejects.toThrow(/evidence/);
  });
  it("expired opt-in blocks", async () => {
    const { acc, contacts } = await setup(1);
    await prisma.consentRecord.updateMany({ where: { contactId: contacts[0].id }, data: { expiresAt: new Date(NOW.getTime() - 1000) } });
    const e = await checkAutomatedEligibility(prisma, { contactId: contacts[0].id, xAccountId: acc.id, now: NOW });
    expect(e.blockers).toContain("CONSENT_EXPIRED");
  });
  it("opt-out suppresses permanently, cancels queued jobs, and later opt-in cannot override suppression", async () => {
    const { camp, contacts } = await setup(1);
    await planCampaign(camp.id);
    await recordConsent(contacts[0].id, { status: "OPTED_OUT", source: "dm:stop" });
    expect(await prisma.messageJob.count({ where: { status: "CANCELLED" } })).toBe(1);
    expect(await prisma.suppressionEntry.count()).toBe(1);
    await recordConsent(contacts[0].id, { status: "OPTED_IN", source: "x", evidence: "y" });
    const e = await checkAutomatedEligibility(prisma, { contactId: contacts[0].id, xAccountId: camp.xAccountId!, now: NOW });
    expect(e.blockers).toContain("SUPPRESSED");
    expect(e.ok).toBe(false);
  });
  it("blocks when DM history has never been synced (never claims 'no prior contact' blindly)", async () => {
    const acc = await makeAccount({ lastSyncAt: null });
    const camp = await makeCampaign(acc.id);
    await makeContact("a", { campaignId: camp.id });
    const p = await planCampaign(camp.id);
    expect(p.created).toBe(0);
    expect(p.blocked.HISTORY_STALE).toBe(1);
  });
});

describe("sending + duplicate prevention", () => {
  it("sends once, records everything, and never sends the same contact twice", async () => {
    const { camp } = await setup(1);
    await tick();
    expect(mockProvider.sent).toHaveLength(1);
    expect(mockProvider.sent[0].text).toBe("Hey Lead0, loved lead0Co!");
    const job = await prisma.messageJob.findFirstOrThrow();
    expect(job.status).toBe("SENT");
    expect((await prisma.outreachLedger.findFirstOrThrow()).state).toBe("SENT");
    for (let i = 1; i <= 5; i++) await tick(later(i));
    expect(mockProvider.sent).toHaveLength(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe("COMPLETED");
  });

  it("a second campaign cannot re-message someone already contacted", async () => {
    const { acc, contacts } = await setup(1);
    await tick();
    const camp2 = await makeCampaign(acc.id, { name: "C2" });
    await prisma.campaignContact.create({ data: { campaignId: camp2.id, contactId: contacts[0].id } });
    const p = await planCampaign(camp2.id);
    expect(p.created).toBe(0);
    expect(p.blocked.ALREADY_MESSAGED).toBe(1);
    await tick(later(10));
    expect(mockProvider.sent).toHaveLength(1);
  });

  it("DB refuses two live jobs for the same sender/recipient (partial unique index)", async () => {
    const { acc, camp, contacts } = await setup(1);
    const camp2 = await makeCampaign(acc.id, { name: "C2" });
    const base = { contactId: contacts[0].id, xAccountId: acc.id, body: "x", bodyHash: "h" };
    await prisma.messageJob.create({ data: { ...base, campaignId: camp.id, idempotencyKey: "k1" } });
    await expect(prisma.messageJob.create({ data: { ...base, campaignId: camp2.id, idempotencyKey: "k2" } })).rejects.toThrow();
  });

  it("DB refuses a duplicate ledger row, duplicate usernames, and non-normalised usernames", async () => {
    const { acc, contacts } = await setup(1);
    await prisma.outreachLedger.create({ data: { xAccountId: acc.id, contactId: contacts[0].id, state: "SENT" } });
    await expect(prisma.outreachLedger.create({ data: { xAccountId: acc.id, contactId: contacts[0].id, state: "SENT" } })).rejects.toThrow();
    await expect(prisma.contact.create({ data: { usernameNormalized: "lead0", usernameDisplay: "x" } })).rejects.toThrow();
    await expect(prisma.contact.create({ data: { usernameNormalized: "Upper", usernameDisplay: "x" } })).rejects.toThrow();
  });

  it("DB refuses duplicate idempotency keys", async () => {
    const { acc, camp, contacts } = await setup(2);
    const mk = (cid: string) => prisma.messageJob.create({ data: { contactId: cid, xAccountId: acc.id, campaignId: camp.id, body: "x", bodyHash: "h", idempotencyKey: "same" } });
    await mk(contacts[0].id);
    await expect(mk(contacts[1].id)).rejects.toThrow();
  });

  it("planning a campaign several times concurrently does not duplicate jobs", async () => {
    const { camp } = await setup(3);
    await Promise.all([planCampaign(camp.id), planCampaign(camp.id), planCampaign(camp.id)]);
    expect(await prisma.messageJob.count()).toBe(3);
  });

  it("two workers racing for the same job: exactly one claims", async () => {
    const { camp } = await setup(1);
    await planCampaign(camp.id);
    const results = await Promise.all([claimNextJob(camp.id, "w1", NOW), claimNextJob(camp.id, "w2", NOW), claimNextJob(camp.id, "w3", NOW)]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it("racing workers cannot bypass pacing (2nd job must wait for the delay)", async () => {
    const { camp } = await setup(3, { schedule: { messageDelayMinutes: 10 } });
    await planCampaign(camp.id);
    const r = await Promise.all([claimNextJob(camp.id, "w1", NOW), claimNextJob(camp.id, "w2", NOW)]);
    expect(r.filter((x) => x.claimed)).toHaveLength(1);
    expect((await claimNextJob(camp.id, "w1", later(5))).claimed).toBe(false);
    expect((await claimNextJob(camp.id, "w1", later(10))).claimed).toBe(true);
  });

  it("same contact in two campaigns, two workers ticking at once: only one send", async () => {
    const { acc, contacts } = await setup(1);
    const camp2 = await makeCampaign(acc.id, { name: "C2" });
    await prisma.campaignContact.create({ data: { campaignId: camp2.id, contactId: contacts[0].id } });
    await Promise.all([tick(), tick()]);
    expect(mockProvider.sent).toHaveLength(1);
  });

  it("incomplete personalization is never sent", async () => {
    const acc = await makeAccount();
    const camp = await makeCampaign(acc.id, { template: "Hi {{first_name}} — {{custom_hook}}" });
    await makeContact("a", { campaignId: camp.id });
    const p = await planCampaign(camp.id);
    expect(p.created).toBe(0);
    expect(p.blocked.INCOMPLETE_PERSONALIZATION).toBe(1);
  });

  it("manual send is recorded in the same dedupe store and cancels queued jobs", async () => {
    const { camp, contacts } = await setup(1);
    await planCampaign(camp.id);
    await recordManualSend(contacts[0].id);
    expect(await prisma.messageJob.count({ where: { status: "CANCELLED" } })).toBe(1);
    await tick();
    expect(mockProvider.sent).toHaveLength(0);
  });

  it("a duplicated campaign never resets history restrictions", async () => {
    const { acc, contacts } = await setup(1);
    await tick();
    const dup = await makeCampaign(acc.id, { name: "copy" });
    await prisma.campaignContact.create({ data: { campaignId: dup.id, contactId: contacts[0].id } });
    await tick(later(30));
    expect(mockProvider.sent).toHaveLength(1);
  });
});

describe("campaign controls", () => {
  it("pause stops sending immediately; resume continues", async () => {
    const { camp } = await setup(3);
    await tick();
    await setCampaignStatus(camp.id, "pause");
    await tick(later(1)); await tick(later(2));
    expect(mockProvider.sent).toHaveLength(1);
    await setCampaignStatus(camp.id, "resume");
    await tick(later(3));
    expect(mockProvider.sent).toHaveLength(2);
  });
  it("stop cancels queued jobs", async () => {
    const { camp } = await setup(3);
    await planCampaign(camp.id);
    await setCampaignStatus(camp.id, "stop");
    expect(await prisma.messageJob.count({ where: { status: "CANCELLED" } })).toBe(3);
  });
  it("global kill switch halts everything and can be released", async () => {
    const { camp } = await setup(3);
    await setSetting("killSwitch", true);
    await tick(); expect(mockProvider.sent).toHaveLength(0);
    expect((await claimNextJob(camp.id, "w", NOW)).claimed).toBe(false);
    await setSetting("killSwitch", false);
    await tick(later(1)); expect(mockProvider.sent).toHaveLength(1);
  });
  it("respects daily limit and batch spacing across ticks", async () => {
    await setup(6, { schedule: { maxPerDay: 3, messageDelayMinutes: 2, batchSize: 2, batchDelayMinMinutes: 30, batchDelayMaxMinutes: 30 } });
    for (const m of [0, 1, 2, 3, 30, 33, 60, 64, 65, 120]) await tick(later(m));
    expect(mockProvider.sent).toHaveLength(3);
  });
  it("dry-run mode never calls the provider's send and burns no first-contact slot", async () => {
    await setSetting("dryRun", true);
    await setup(2);
    await tick(); await tick(later(1));
    expect(mockProvider.sendCalls).toBe(0);
    expect(await prisma.messageJob.count({ where: { status: "DRY_RUN" } })).toBe(2);
    expect(await prisma.outreachLedger.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });
  it("manual approval gate: nothing sends until approved", async () => {
    await setup(1, { requireApproval: true });
    await tick();
    expect(mockProvider.sent).toHaveLength(0);
    await prisma.messageJob.updateMany({ where: { status: "PENDING_APPROVAL" }, data: { status: "QUEUED" } });
    await tick(later(1));
    expect(mockProvider.sent).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("429 re-queues until the reset time, burns no ledger slot, then succeeds", async () => {
    const { acc } = await setup(1);
    const reset = later(15);
    mockProvider.forced.push({ kind: "rate_limited", resetAt: reset, apiStatus: 429 });
    await tick();
    const job = await prisma.messageJob.findFirstOrThrow();
    expect(job.status).toBe("QUEUED"); expect(job.notBefore?.toISOString()).toBe(reset.toISOString());
    expect(await prisma.outreachLedger.count({ where: { state: { not: "VOID" } } })).toBe(0);
    expect((await prisma.xAccount.findUniqueOrThrow({ where: { id: acc.id } })).rateLimitedUntil?.toISOString()).toBe(reset.toISOString());
    await tick(later(5)); expect(mockProvider.sendCalls).toBe(1);
    await tick(later(16)); expect(mockProvider.sent).toHaveLength(1);
  });
  it("permanent failure is not retried and is categorised", async () => {
    await setup(1);
    mockProvider.forced.push({ kind: "permanent", apiStatus: 403, category: "RECIPIENT_RESTRICTED", message: "cannot dm" });
    await tick(); await tick(later(5)); await tick(later(10));
    expect(mockProvider.sendCalls).toBe(1);
    expect(await prisma.messageJob.findFirstOrThrow()).toMatchObject({ status: "FAILED", errorCategory: "RECIPIENT_RESTRICTED", apiStatus: 403 });
  });
  it("auth failure revokes the account, pauses campaigns, never retries", async () => {
    const { acc, camp } = await setup(2);
    mockProvider.forced.push({ kind: "auth", apiStatus: 401, message: "revoked" });
    await tick(); await tick(later(5));
    expect(mockProvider.sendCalls).toBe(1);
    expect((await prisma.xAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe("REVOKED");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe("PAUSED");
  });
  it("auto-pauses after N consecutive errors", async () => {
    const { camp } = await setup(5, { schedule: { maxConsecutiveErrors: 2 } });
    for (let i = 0; i < 3; i++) mockProvider.forced.push({ kind: "permanent", apiStatus: 400, category: "BAD_REQUEST", message: "x" });
    for (let i = 0; i < 4; i++) await tick(later(i));
    expect(mockProvider.sendCalls).toBe(2);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).toMatchObject({ status: "PAUSED", autoPaused: true });
  });
});

describe("uncertain delivery, crashes, reconciliation", () => {
  it("timeout after delivery ⇒ UNCERTAIN, never re-sent, reconciled to SENT", async () => {
    await setup(1);
    mockProvider.forced.push({ kind: "delivered_but_timeout" });
    await tick();
    expect((await prisma.messageJob.findFirstOrThrow()).status).toBe("UNCERTAIN");
    await tick(later(2)); await tick(later(3));
    expect(mockProvider.sendCalls).toBe(1);
    expect(await reconcileUncertain(mockProvider, later(5))).toBe(1);
    expect(await prisma.messageJob.findFirstOrThrow()).toMatchObject({ status: "SENT" });
    expect(await prisma.message.count({ where: { direction: "OUT" } })).toBe(1);
    expect(mockProvider.sent).toHaveLength(1);
  });
  it("timeout that was NOT delivered: stays uncertain during grace, then confirmed failed and ledger freed", async () => {
    await setup(1);
    mockProvider.forced.push({ kind: "uncertain", reason: "timeout" });
    await tick();
    await reconcileUncertain(mockProvider, later(5));
    expect((await prisma.messageJob.findFirstOrThrow()).status).toBe("UNCERTAIN");
    await reconcileUncertain(mockProvider, later(8));
    await reconcileUncertain(mockProvider, later(70));
    expect(await prisma.messageJob.findFirstOrThrow()).toMatchObject({ status: "FAILED", errorCategory: "NOT_DELIVERED_CONFIRMED" });
    expect((await prisma.outreachLedger.findFirstOrThrow()).state).toBe("VOID");
    expect(mockProvider.sendCalls).toBe(1);
  });
  it("lookup failure keeps UNCERTAIN (no assumptions)", async () => {
    await setup(1);
    mockProvider.forced.push({ kind: "uncertain", reason: "5xx", apiStatus: 502 });
    await tick(); mockProvider.lookupFails = true;
    await reconcileUncertain(mockProvider, later(100));
    expect((await prisma.messageJob.findFirstOrThrow()).status).toBe("UNCERTAIN");
  });
  it("worker crash mid-send (job stuck SENDING) is never re-sent: becomes UNCERTAIN", async () => {
    const { camp } = await setup(1);
    await planCampaign(camp.id);
    const claim = await claimNextJob(camp.id, "dead-worker", NOW);
    expect(claim.claimed).toBe(true);
    expect(await recoverStaleSending(later(5))).toBe(1);
    await tick(later(6)); await tick(later(10));
    expect(mockProvider.sendCalls).toBe(0);
    expect(await prisma.messageJob.findFirstOrThrow()).toMatchObject({ status: "UNCERTAIN", errorCategory: "WORKER_CRASH" });
    expect(await prisma.outreachLedger.findFirstOrThrow()).toMatchObject({ state: "UNCERTAIN" });
    const e = await checkAutomatedEligibility(prisma, { contactId: (await prisma.contact.findFirstOrThrow()).id, xAccountId: camp.xAccountId!, now: later(10) });
    expect(e.blockers).toContain("UNCERTAIN_PENDING");
  });
  it("after a restart (only DB state survives) already-sent contacts are not re-sent", async () => {
    await setup(2);
    await tick();
    await tick(later(1)); await tick(later(2)); await tick(later(3));
    expect(mockProvider.sent.map((s) => s.toXUserId).sort()).toEqual(["id_lead0", "id_lead1"]);
  });
});

describe("stop right before transmission", () => {
  it("pausing between claim and send aborts and re-queues safely", async () => {
    const { camp } = await setup(1);
    await planCampaign(camp.id);
    const claim = await claimNextJob(camp.id, "w", NOW);
    if (!claim.claimed) throw new Error("expected claim");
    await setCampaignStatus(camp.id, "pause");
    expect(await executeClaimedJob(claim.jobId)).toBe("reverted");
    expect(mockProvider.sendCalls).toBe(0);
    expect(await prisma.messageJob.findFirstOrThrow()).toMatchObject({ status: "QUEUED" });
    expect((await prisma.outreachLedger.findFirstOrThrow()).state).toBe("VOID");
  });
});

describe("suppression", () => {
  it("suppressContact cancels queued/pending jobs", async () => {
    const { camp, contacts } = await setup(1, { requireApproval: true });
    await planCampaign(camp.id);
    await suppressContact(contacts[0].id, "test");
    expect(await prisma.messageJob.count({ where: { status: "CANCELLED" } })).toBe(1);
  });
});

describe("provider routing", () => {
  it("real OAuth accounts always use the official X client; demo/test accounts use X_PROVIDER (mock)", async () => {
    const { providerFor, DEMO_X_USER_ID } = await import("@/lib/provider");
    expect(providerFor({ lastVerifiedAt: new Date(), xUserId: "777" }).name).toBe("x");
    expect(providerFor({ lastVerifiedAt: null, xUserId: "777" }).name).toBe("mock");
    expect(providerFor({ lastVerifiedAt: new Date(), xUserId: DEMO_X_USER_ID }).name).toBe("mock");
  });
  it("dry-run never sends, even for a real OAuth account routed to the X client", async () => {
    await setSetting("dryRun", true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const acc = await makeAccount({ lastVerifiedAt: new Date() });
    const camp = await makeCampaign(acc.id);
    await makeContact("real1", { campaignId: camp.id });
    await runSchedulerTick("w", NOW);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await prisma.messageJob.count({ where: { status: "DRY_RUN" } })).toBe(1);
    vi.unstubAllGlobals();
  });
});
