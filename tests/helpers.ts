import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { defaultSchedule, Schedule } from "@/lib/schedule";
import { setSetting } from "@/lib/settings";
import { mockProvider } from "@/lib/provider";
import { recordConsent } from "@/lib/consent";

export const NOW = new Date("2026-10-14T15:00:00Z"); // a Wednesday

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
  mockProvider.reset();
  mockProvider.now = () => NOW;
  await setSetting("dryRun", false);
}

export async function makeAccount(overrides: Record<string, unknown> = {}) {
  const user = await prisma.user.upsert({ where: { email: "t@t.test" }, create: { email: "t@t.test", passwordHash: "x" }, update: {} });
  return prisma.xAccount.create({ data: { userId: user.id, xUserId: "1000", username: "me", accessTokenEnc: encrypt("tok"), scopes: [], lastSyncAt: new Date(NOW.getTime() - 3600_000), ...overrides } });
}

export const openSchedule = (o: Partial<Schedule> = {}): Schedule => ({
  ...defaultSchedule(), timezone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], allowWeekends: true, windowStart: "00:00", windowEnd: "23:59",
  maxPerHour: 60, maxPerDay: 1000, batchSize: 100, batchDelayMinMinutes: 0, batchDelayMaxMinutes: 0, messageDelayMinutes: 0, excludeHolidays: false, ...o,
});

export async function makeCampaign(accountId: string, o: { schedule?: Partial<Schedule>; status?: "ACTIVE" | "DRAFT"; requireApproval?: boolean; template?: string; name?: string } = {}) {
  return prisma.campaign.create({
    data: { name: o.name ?? "C1", status: o.status ?? "ACTIVE", xAccountId: accountId, templateBody: o.template ?? "Hey {{first_name}}, loved {{company}}!", requireApproval: o.requireApproval ?? false, schedule: openSchedule(o.schedule) as object },
  });
}

export async function makeContact(username: string, o: { consent?: boolean; campaignId?: string; resolved?: boolean; extra?: Record<string, unknown> } = {}) {
  const c = await prisma.contact.create({
    data: { usernameNormalized: username, usernameDisplay: username, founderName: `${username[0].toUpperCase()}${username.slice(1)} Doe`, company: `${username}Co`,
      xUserId: o.resolved === false ? null : `id_${username}`, resolveStatus: o.resolved === false ? "UNRESOLVED" : "RESOLVED", historyStatus: "NONE_FOUND", ...(o.extra as object) },
  });
  if (o.consent !== false) await recordConsent(c.id, { status: "OPTED_IN", source: "test-form", evidence: "https://example.com/optin/" + username, scope: "DMs" });
  if (o.campaignId) await prisma.campaignContact.create({ data: { campaignId: o.campaignId, contactId: c.id } });
  return c;
}
