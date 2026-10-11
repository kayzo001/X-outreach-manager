import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAME = "xom-engine";
export type EngineJob = "tick" | "reconcile" | "sync" | "resolve" | "reminders";

const g = globalThis as unknown as { __redis?: IORedis; __queue?: Queue };

export function redis(): IORedis {
  return (g.__redis ??= new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null, enableReadyCheck: true }));
}

export function engineQueue(): Queue {
  return (g.__queue ??= new Queue(QUEUE_NAME, {
    connection: redis(),
    defaultJobOptions: { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 }, attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  }));
}

/** Ask the worker to run a tick right away (e.g. after Start/Resume). The DB gate still decides whether anything is sent. */
export async function pokeTick() {
  try { await engineQueue().add("tick", {}, { jobId: `tick-now-${Math.floor(Date.now() / 5000)}` }); } catch { /* redis down: periodic tick will still run */ }
}

export async function queueHealth() {
  try {
    const q = engineQueue();
    const [counts, schedulers] = await Promise.all([q.getJobCounts("waiting", "active", "delayed", "failed", "completed"), q.getJobSchedulers()]);
    return { ok: true as const, counts, schedulers: schedulers.length };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}
