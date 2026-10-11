import "dotenv/config";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { Worker } from "bullmq";
import { prisma } from "../src/lib/db";
import { QUEUE_NAME, EngineJob, engineQueue, redis } from "../src/lib/queue";
import { reconcileUncertain, runSchedulerTick } from "../src/lib/engine";
import { syncAccount } from "../src/lib/sync";
import { resolvePending } from "../src/lib/resolve";
import { getSettings } from "../src/lib/settings";
import { notify } from "../src/lib/notify";
import { getProvider } from "../src/lib/provider";

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const startedAt = new Date();
const stats = { ticks: 0, sent: 0, dryRun: 0, lastTickAt: null as string | null, lastError: null as string | null };

const log = (...a: unknown[]) => console.log(JSON.stringify({ t: new Date().toISOString(), worker: WORKER_ID, msg: a.join(" ") }));

async function heartbeat() {
  const s = await getSettings();
  await prisma.workerStatus.upsert({
    where: { id: WORKER_ID },
    create: { id: WORKER_ID, heartbeatAt: new Date(), startedAt, info: { ...stats, provider: `x for OAuth accounts, ${getProvider().name} for demo`, dryRun: s.dryRun, killSwitch: s.killSwitch } },
    update: { heartbeatAt: new Date(), info: { ...stats, provider: `x for OAuth accounts, ${getProvider().name} for demo`, dryRun: s.dryRun, killSwitch: s.killSwitch } },
  });
  await prisma.workerStatus.deleteMany({ where: { heartbeatAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
}

async function handle(name: EngineJob) {
  switch (name) {
    case "tick": {
      const r = await runSchedulerTick(WORKER_ID);
      stats.ticks++; stats.sent += r.sent; stats.dryRun += r.dryRun; stats.lastTickAt = new Date().toISOString();
      if (r.sent || r.dryRun) log("tick", JSON.stringify(r));
      return;
    }
    case "reconcile": await reconcileUncertain(); return;
    case "resolve": {
      const scope = (await getSettings()).autoResolveScope;
      for (const a of await prisma.xAccount.findMany({ where: { status: "ACTIVE" } })) await resolvePending(a.id, 100, undefined, scope);
      return;
    }
    case "sync": {
      for (const a of await prisma.xAccount.findMany({ where: { status: "ACTIVE" } })) {
        if (a.rateLimitedUntil && a.rateLimitedUntil > new Date()) continue;
        const every = (await getSettings()).dmSyncIntervalMinutes * 60_000;
        if (a.lastSyncAt && Date.now() - a.lastSyncAt.getTime() < every) continue; // cost control: X bills per event read
        const r = await syncAccount(a.id);
        if (!r.ok) log("sync skipped", a.username, r.reason);
      }
      return;
    }
    case "reminders": {
      await dailyOutreachNudge();
      const due = await prisma.reminder.findMany({ where: { done: false, dueAt: { lte: new Date() } }, include: { contact: true }, take: 50 });
      for (const r of due) {
        const exists = await prisma.notification.findFirst({ where: { type: `reminder:${r.id}` } });
        if (!exists) await notify(`reminder:${r.id}`, `Reminder: ${r.kind} — @${r.contact.usernameNormalized}`, r.note ?? undefined, r.contactId);
      }
      return;
    }
  }
}

async function dailyOutreachNudge() {
  const { manualStats } = await import("../src/lib/manual-outreach");
  const st = await manualStats();
  if (!st.inHours || st.remaining === 0) return;
  const key = `outreach-day:${new Date().toISOString().slice(0, 10)}`;
  if (await prisma.notification.findFirst({ where: { type: key } })) return;
  await notify(key, `Today's outreach: ${st.today}/${st.target}`, `${st.remaining} cold leads are ready in Manual Queue → Focus mode.`);
}

async function main() {
  const q = engineQueue();
  // Repeatable schedulers live in Redis, so they survive restarts; upsert is idempotent across multiple workers.
  await q.upsertJobScheduler("tick", { every: 15_000 }, { name: "tick" });
  await q.upsertJobScheduler("reconcile", { every: 60_000 }, { name: "reconcile" });
  await q.upsertJobScheduler("resolve", { every: 120_000 }, { name: "resolve" });
  await q.upsertJobScheduler("sync", { every: 5 * 60_000 }, { name: "sync" });
  await q.upsertJobScheduler("reminders", { every: 60_000 }, { name: "reminders" });

  const worker = new Worker(QUEUE_NAME, async (job) => handle(job.name as EngineJob), { connection: redis(), concurrency: 1, lockDuration: 60_000 });
  worker.on("failed", (job, err) => { stats.lastError = `${job?.name}: ${err.message}`; log("job failed", job?.name, err.message); });
  worker.on("error", (err) => log("worker error", err.message));

  await heartbeat();
  const hb = setInterval(() => heartbeat().catch((e) => log("heartbeat failed", e.message)), 10_000);
  log("worker started", `provider=x(OAuth accounts)/${getProvider().name}(demo)`, `dryRun=${(await getSettings()).dryRun}`);

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return; stopping = true;
    log("shutting down", sig);
    clearInterval(hb);
    await worker.close(); // waits for the in-flight job
    await prisma.workerStatus.deleteMany({ where: { id: WORKER_ID } }).catch(() => undefined);
    await prisma.$disconnect(); redis().disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => log("unhandledRejection", String(e)));
}

main().catch((e) => { console.error(e); process.exit(1); });
