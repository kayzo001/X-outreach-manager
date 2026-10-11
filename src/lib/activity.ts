import { prisma, Tx } from "./db";

export interface LogInput {
  type: string; message: string; level?: "info" | "warn" | "error";
  contactId?: string | null; campaignId?: string | null; xAccountId?: string | null; jobId?: string | null;
  apiStatus?: number | null; errorCategory?: string | null; retryCount?: number | null; consentRecordId?: string | null;
  meta?: Record<string, unknown>;
}

const SECRET_KEYS = /token|secret|password|authorization|cookie|key/i;
function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : scrub(x, depth + 1)]));
}

export async function logActivity(input: LogInput, db: Tx = prisma) {
  const { meta, ...rest } = input;
  try {
    await db.activityLog.create({ data: { level: "info", ...rest, meta: meta ? (scrub(meta) as object) : undefined } });
  } catch (e) {
    console.error("[activity-log] failed to write", input.type, (e as Error).message);
  }
}
