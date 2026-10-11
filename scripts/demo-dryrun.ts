// Live dry-run demonstration against the running worker (Redis + Postgres). Transmits NOTHING to X.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { encrypt } from "../src/lib/crypto";
import { recordConsent } from "../src/lib/consent";
import { resolvePending } from "../src/lib/resolve";
import { syncAccount } from "../src/lib/sync";
import { setSetting } from "../src/lib/settings";
import { pokeTick } from "../src/lib/queue";
import { planCampaign, setCampaignStatus } from "../src/lib/engine";
import { defaultSchedule } from "../src/lib/schedule";
import { mockProvider } from "../src/lib/provider";

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.X_PROVIDER === "x") throw new Error("Demo only runs with X_PROVIDER=mock");
  await setSetting("dryRun", true); await setSetting("killSwitch", false);
  const user = await prisma.user.findFirstOrThrow();
  const acc = await prisma.xAccount.upsert({ where: { xUserId: "900000001" }, create: { userId: user.id, xUserId: "900000001", username: "demo_sender", accessTokenEnc: encrypt("demo"), scopes: [], status: "ACTIVE" }, update: { status: "ACTIVE" } });
  console.log("1. resolving usernames →", await resolvePending(acc.id, 500, mockProvider));
  console.log("2. syncing DM history →", (await syncAccount(acc.id, mockProvider)).ok ? "done" : "failed");

  const contacts = await prisma.contact.findMany({ where: { usernameNormalized: { startsWith: "founder_" } }, orderBy: { usernameNormalized: "asc" }, take: 11 });
  const optedIn = contacts.slice(0, 10), cold = contacts[10];
  for (const c of optedIn) await recordConsent(c.id, { status: "OPTED_IN", source: "demo-optin-form", evidence: `https://example.com/optin/${c.usernameNormalized}`, scope: "DMs about content services", xAccountId: acc.id });
  console.log(`3. recorded documented opt-in for ${optedIn.length} leads; @${cold.usernameNormalized} has none`);

  const camp = await prisma.campaign.create({ data: {
    name: `Dry-run demo ${new Date().toISOString().slice(11, 19)}`, xAccountId: acc.id, requireApproval: false, status: "DRAFT",
    templateBody: "Hey {{first_name}}, you asked for updates about {{company}} content — here's the first one. Reply STOP any time.",
    schedule: { ...defaultSchedule(), timezone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], allowWeekends: true, windowStart: "00:00", windowEnd: "23:59", excludeHolidays: false, maxPerHour: 60, maxPerDay: 100, batchSize: 5, batchDelayMinMinutes: 0, batchDelayMaxMinutes: 0, messageDelayMinutes: 0 },
  } });
  await prisma.campaignContact.createMany({ data: contacts.map((c) => ({ campaignId: camp.id, contactId: c.id })) });
  console.log("4. plan:", await planCampaign(camp.id));
  await setCampaignStatus(camp.id, "start");
  console.log("5. campaign started — worker is processing (dry run)…");
  for (let i = 0; i < 40; i++) {
    await pokeTick();
    await sleep(5500);
    const n = await prisma.messageJob.count({ where: { campaignId: camp.id, status: "DRY_RUN" } });
    process.stdout.write(`   dry-run jobs: ${n}/10\r`);
    if (n >= 10) break;
  }
  const [jobs, msgs, ledger, coldJobs, camp2] = await Promise.all([
    prisma.messageJob.count({ where: { campaignId: camp.id, status: "DRY_RUN" } }), prisma.message.count({ where: { direction: "OUT" } }), prisma.outreachLedger.count(),
    prisma.messageJob.count({ where: { campaignId: camp.id, contactId: cold.id } }), prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } }),
  ]);
  console.log(`\n6. RESULT: ${jobs} dry-run jobs · ${msgs} messages transmitted · ${ledger} ledger rows · ${coldJobs} jobs for the cold lead · campaign ${camp2.status}`);
  const logs = await prisma.activityLog.findMany({ where: { campaignId: camp.id }, orderBy: { at: "asc" }, take: 6 });
  logs.forEach((l) => console.log(`   ${l.at.toISOString().slice(11, 19)}  ${l.type.padEnd(14)} ${l.message}`));
  process.exit(jobs === 10 && msgs === 0 && coldJobs === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
