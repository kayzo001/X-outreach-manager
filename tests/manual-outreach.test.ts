import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { buildColdDraft, checkManualSafety, manualStats, markManualContacted, nextManualLead, skipManualLead } from "@/lib/manual-outreach";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { recordConsent, suppressContact } from "@/lib/consent";
import { planCampaign } from "@/lib/engine";
import { syncAccount } from "@/lib/sync";
import { resolvePending } from "@/lib/resolve";
import { mockProvider } from "@/lib/provider";
import { makeAccount, makeCampaign, resetDb } from "./helpers";

beforeEach(resetDb);

const cold = (u: string, extra: Record<string, unknown> = {}) =>
  prisma.contact.create({ data: { usernameNormalized: u, usernameDisplay: u, founderName: `${u[0].toUpperCase()}${u.slice(1)} Smith`, company: `${u}Co`, ...extra } });
const S = { outreachPitch: "I make short videos for SaaS.", outreachCta: "Open to ideas for {{company}}?", senderName: "" };

describe("presenting cold leads", () => {
  it("shows a cold lead with NO consent and NO prior conversation", async () => {
    await cold("alice");
    const lead = await nextManualLead();
    expect(lead?.username).toBe("alice");
    expect(lead?.checks.ok).toBe(true);
  });

  it("never presents opted-out, DNC, suppressed, contacted, replied, in-conversation or auto-queued leads", async () => {
    const acc = await makeAccount();
    const out = await cold("optedout"); await recordConsent(out.id, { status: "OPTED_OUT", source: "dm" });
    await cold("dnc", { doNotContact: true });
    const sup = await cold("supp"); await suppressContact(sup.id, "test");
    const msg = await cold("messaged"); await prisma.message.create({ data: { contactId: msg.id, direction: "OUT", text: "hi", sentAt: new Date(), manual: true } });
    const conv = await cold("convo"); await prisma.conversation.create({ data: { xAccountId: acc.id, contactId: conv.id } });
    const camp = await makeCampaign(acc.id, { requireApproval: true });
    const auto = await cold("autoq", { xUserId: "id_autoq", resolveStatus: "RESOLVED", historyStatus: "NONE_FOUND" });
    await recordConsent(auto.id, { status: "OPTED_IN", source: "f", evidence: "e" });
    await prisma.campaignContact.create({ data: { campaignId: camp.id, contactId: auto.id } });
    await planCampaign(camp.id);
    await cold("fresh");
    const shown: string[] = [];
    for (let i = 0; i < 10; i++) { const l = await nextManualLead({ excludeIds: shown.map((u) => u) }); if (!l) break; shown.push(l.id); }
    const names = (await prisma.contact.findMany({ where: { id: { in: shown } } })).map((c) => c.usernameNormalized);
    expect(names).toEqual(["fresh"]);
  });

  it("self-heals inconsistent records: a lead with a ledger entry is skipped and marked contacted", async () => {
    const acc = await makeAccount();
    const c = await cold("ledgered");
    await prisma.outreachLedger.create({ data: { xAccountId: acc.id, contactId: c.id, state: "SENT" } });
    expect(await nextManualLead()).toBeNull();
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).historyStatus).toBe("CONTACTED");
  });

  it("orders by lead score and can be scoped to a campaign", async () => {
    const acc = await makeAccount();
    const camp = await makeCampaign(acc.id, { name: "B" });
    const low = await cold("low"); const high = await cold("high"); const other = await cold("other");
    await prisma.leadScore.createMany({ data: [{ contactId: low.id, score: 10, factors: [] }, { contactId: high.id, score: 80, factors: [] }, { contactId: other.id, score: 99, factors: [] }] });
    await prisma.campaignContact.createMany({ data: [{ campaignId: camp.id, contactId: low.id }, { campaignId: camp.id, contactId: high.id }] });
    expect((await nextManualLead())?.username).toBe("other");
    expect((await nextManualLead({ campaignId: camp.id }))?.username).toBe("high");
  });
});

describe("marking contacted is permanent across campaigns and imports", () => {
  it("records history, ledger, follow-up reminder, daily progress — and never resurfaces the lead in any campaign", async () => {
    const acc = await makeAccount();
    const a = await makeCampaign(acc.id, { name: "A" }), b = await makeCampaign(acc.id, { name: "B" });
    const c = await cold("bob");
    await prisma.campaignContact.createMany({ data: [{ campaignId: a.id, contactId: c.id }, { campaignId: b.id, contactId: c.id }] });
    const before = await manualStats();
    await markManualContacted(c.id, { campaignId: a.id, text: "Hey Bob, …" });
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ manualStatus: "CONTACTED", historyStatus: "CONTACTED" });
    expect(await prisma.message.count({ where: { contactId: c.id, direction: "OUT", manual: true } })).toBe(1);
    expect(await prisma.outreachLedger.count({ where: { contactId: c.id, state: "MANUAL" } })).toBe(1);
    expect(await prisma.reminder.count({ where: { contactId: c.id, kind: "Check for reply", done: false } })).toBe(1);
    expect((await manualStats()).today).toBe(before.today + 1);
    expect(await nextManualLead({ campaignId: a.id })).toBeNull();
    expect(await nextManualLead({ campaignId: b.id })).toBeNull();
    // re-importing the same username can't create a second identity, and the automated lane also sees the history
    await expect(prisma.contact.create({ data: { usernameNormalized: "bob", usernameDisplay: "bob" } })).rejects.toThrow();
    expect((await checkManualSafety(c.id)).blockers.join()).toMatch(/Already messaged/);
  });

  it("warns (but records) if you mark someone who was already contacted", async () => {
    const c = await cold("twice");
    await markManualContacted(c.id, { text: "one" });
    const r = await markManualContacted(c.id, { text: "two" });
    expect(r.warning).toMatch(/Already/);
  });

  it("skip and not-a-fit remove the lead from the queue", async () => {
    const a = await cold("skipme"), b = await cold("nofit");
    await skipManualLead(a.id, "skip"); await skipManualLead(b.id, "not_fit");
    expect(await nextManualLead()).toBeNull();
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: b.id } })).customerStatus).toBe("NOT_INTERESTED");
  });
});

describe("drafts use only data on file", () => {
  const base = { id: "x1", usernameNormalized: "u", usernameDisplay: "u", founderName: null, company: null, product: null, industry: null, customHook: null } as never;
  it("never prints 'undefined' or unfilled {{vars}}, whatever is missing", () => {
    for (const extra of [{}, { founderName: "Ana Lee" }, { company: "Acme" }, { founderName: "Ana Lee", company: "Acme", industry: "Analytics" }, { founderName: "Ana", company: "Acme", product: "Acme Flow" }, { customHook: "Loved your launch thread on Monday" }]) {
      const d = buildColdDraft({ ...(base as object), ...extra } as never, S);
      expect(d.text).not.toMatch(/undefined|null|\{\{/);
      expect(d.text).toContain(S.outreachPitch);
    }
  });
  it("uses the facts it has and drops {{company}} from the CTA when unknown", () => {
    const withCo = buildColdDraft({ ...(base as object), founderName: "Ana Lee", company: "Acme" } as never, S).text;
    expect(withCo.startsWith("Hey Ana,")).toBe(true);
    expect(withCo).toContain("Acme");
    expect(withCo).toContain("Open to ideas for Acme?");
    const noCo = buildColdDraft(base, S).text;
    expect(noCo.startsWith("Hey,")).toBe(true);
    expect(noCo).toContain("Open to ideas?");
  });
  it("prefers a complete campaign template, falls back when the template needs missing data", () => {
    const c = { ...(base as object), founderName: "Ana Lee", company: "Acme" } as never;
    expect(buildColdDraft(c, S, "Hi {{first_name}} from {{company}}!")).toMatchObject({ text: "Hi Ana from Acme!", source: "campaign template" });
    expect(buildColdDraft(c, S, "Hi {{first_name}} — {{custom_hook}}").source).toBe("auto draft");
  });
  it("default settings produce a sensible draft", () => {
    const d = buildColdDraft({ ...(base as object), founderName: "Ana Lee", company: "Acme" } as never, DEFAULT_SETTINGS);
    expect(d.text.length).toBeLessThan(400);
  });
});

describe("reply detection for manually contacted leads (official API sync)", () => {
  it("resolves contacted leads, links the DM you sent (no double count), detects the reply and closes the reminder", async () => {
    const acc = await makeAccount();
    const c = await cold("carol");
    await markManualContacted(c.id, { text: "Hey Carol" });
    const xid = mockProvider.idFor("carol");
    const t0 = Date.now();
    mockProvider.inbound.push(
      { id: "out-1", conversationId: `1000-${xid}`, senderId: "1000", text: "Hey Carol", createdAt: new Date(t0 - 60_000), participantIds: ["1000", xid] },
      { id: "in-1", conversationId: `1000-${xid}`, senderId: xid, text: "Sounds good, send ideas", createdAt: new Date(t0 - 30_000), participantIds: ["1000", xid] },
    );
    const r = await resolvePending(acc.id, 100, mockProvider, "opted_in"); // default worker scope now includes contacted leads
    expect(r.resolved).toBe(1);
    expect(await prisma.message.count({ where: { contactId: c.id, direction: "OUT" } })).toBe(1); // linked, not duplicated
    expect((await prisma.message.findFirstOrThrow({ where: { contactId: c.id, direction: "OUT" } })).xEventId).toBe("out-1");
    expect(await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } })).toMatchObject({ replied: true });
    expect(await prisma.reminder.count({ where: { contactId: c.id, done: false } })).toBe(0);
    await syncAccount(acc.id, mockProvider);
    expect(await prisma.message.count({ where: { contactId: c.id } })).toBe(2);
  });
});

describe("speed on large lists", () => {
  it("serves the next lead from 5,000 cold leads quickly", async () => {
    await prisma.contact.createMany({ data: Array.from({ length: 5000 }, (_, i) => ({ usernameNormalized: `lead_${i}`, usernameDisplay: `lead_${i}`, company: `Co${i}` })) });
    const t = Date.now();
    for (let i = 0; i < 5; i++) expect(await nextManualLead()).not.toBeNull();
    const per = (Date.now() - t) / 5;
    console.log(`nextManualLead ≈ ${per.toFixed(0)} ms on 5k leads`);
    expect(per).toBeLessThan(500);
  });
});
