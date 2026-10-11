import { DateTime } from "luxon";
import { z } from "zod";

export const scheduleSchema = z.object({
  timezone: z.string().default("America/New_York"),
  startDate: z.string().nullable().default(null), // YYYY-MM-DD in campaign tz
  endDate: z.string().nullable().default(null),
  days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]), // ISO weekday: 1=Mon..7=Sun
  allowWeekends: z.boolean().default(false),
  excludeHolidays: z.boolean().default(true),
  holidays: z.array(z.string()).default([]), // YYYY-MM-DD
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("17:00"),
  maxPerHour: z.number().int().min(1).max(60).default(5),
  maxPerDay: z.number().int().min(1).max(1000).default(20),
  maxPerCampaign: z.number().int().min(1).nullable().default(null),
  batchSize: z.number().int().min(1).max(100).default(5),
  batchDelayMinMinutes: z.number().min(0).default(60),
  batchDelayMaxMinutes: z.number().min(0).default(60),
  messageDelayMinutes: z.number().min(0).default(3),
  maxConsecutiveErrors: z.number().int().min(1).default(3),
  autoPauseOnErrors: z.boolean().default(true),
  stopOnReply: z.boolean().default(true),
}).refine((s) => s.batchDelayMaxMinutes >= s.batchDelayMinMinutes, { message: "Max batch delay must be ≥ min batch delay" });

export type Schedule = z.infer<typeof scheduleSchema>;
export const defaultSchedule = (): Schedule => scheduleSchema.parse({});

const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return { hour: h, minute: m }; };

export function allowedDay(s: Schedule, dt: DateTime): boolean {
  if (!s.days.includes(dt.weekday)) return false;
  if (!s.allowWeekends && dt.weekday >= 6) return false;
  const iso = dt.toISODate()!;
  if (s.startDate && iso < s.startDate) return false;
  if (s.endDate && iso > s.endDate) return false;
  if (s.excludeHolidays && s.holidays.includes(iso)) return false;
  return true;
}

export function inWindow(s: Schedule, now: Date): boolean {
  const dt = DateTime.fromJSDate(now, { zone: s.timezone });
  if (!dt.isValid || !allowedDay(s, dt)) return false;
  const start = dt.set(hm(s.windowStart)).startOf("minute");
  const end = dt.set(hm(s.windowEnd)).startOf("minute");
  return dt >= start && dt < end;
}

/** Earliest instant >= `from` that is inside the sending window; null if none within 400 days (e.g. past endDate). */
export function nextWindowStart(s: Schedule, from: Date): Date | null {
  let dt = DateTime.fromJSDate(from, { zone: s.timezone });
  if (!dt.isValid) return null;
  if (inWindow(s, dt.toJSDate())) return dt.toJSDate();
  for (let i = 0; i < 400; i++) {
    const day = dt.plus({ days: i });
    if (!allowedDay(s, day)) continue;
    const start = day.set(hm(s.windowStart)).startOf("minute");
    const end = day.set(hm(s.windowEnd)).startOf("minute");
    if (end <= start) continue;
    if (start >= dt) return start.toJSDate();
    if (dt < end) return dt.toJSDate(); // already past start but within window (covered above) — defensive
  }
  return null;
}

export interface SendCounters { sentLastHour: number; sentToday: number; sentTotal: number }
export type Gate = { ok: true } | { ok: false; reason: string; retryAt?: Date; terminal?: boolean };

/** Pure gate: may this campaign send one message at `now`? */
export function gateSend(s: Schedule, now: Date, c: SendCounters, nextSendAt: Date | null): Gate {
  if (s.maxPerCampaign !== null && c.sentTotal >= s.maxPerCampaign) return { ok: false, reason: "Campaign message cap reached", terminal: true };
  const dt = DateTime.fromJSDate(now, { zone: s.timezone });
  if (s.endDate && dt.toISODate()! > s.endDate) return { ok: false, reason: "Campaign end date passed", terminal: true };
  if (!inWindow(s, now)) {
    const next = nextWindowStart(s, now);
    return next ? { ok: false, reason: "Outside sending window", retryAt: next } : { ok: false, reason: "No remaining sending window", terminal: true };
  }
  if (nextSendAt && nextSendAt > now) return { ok: false, reason: "Waiting for message/batch delay", retryAt: nextSendAt };
  if (c.sentToday >= s.maxPerDay) {
    const tomorrow = nextWindowStart(s, dt.plus({ days: 1 }).startOf("day").toJSDate());
    return { ok: false, reason: "Daily limit reached", retryAt: tomorrow ?? undefined };
  }
  if (c.sentLastHour >= s.maxPerHour) return { ok: false, reason: "Hourly limit reached", retryAt: new Date(now.getTime() + 60_000) };
  return { ok: true };
}

/** Compute the next allowed send time after a successful send. Deterministic — no jitter. */
export function computeNextSendAt(s: Schedule, now: Date, batchSentCount: number): { nextSendAt: Date; batchSentCount: number } {
  const done = batchSentCount + 1;
  let delayMin: number, count: number;
  if (done >= s.batchSize) { delayMin = s.batchDelayMinMinutes; count = 0; }
  else { delayMin = s.messageDelayMinutes; count = done; }
  const raw = new Date(now.getTime() + delayMin * 60_000);
  return { nextSendAt: nextWindowStart(s, raw) ?? raw, batchSentCount: count };
}

export function dayBounds(s: Schedule, now: Date) {
  const dt = DateTime.fromJSDate(now, { zone: s.timezone });
  return { dayStart: dt.startOf("day").toJSDate(), hourAgo: new Date(now.getTime() - 3_600_000) };
}
