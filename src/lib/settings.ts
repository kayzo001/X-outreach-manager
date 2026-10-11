import { prisma, Tx } from "./db";

export interface AppSettings {
  killSwitch: boolean;                // global emergency stop
  defaultTimezone: string;
  defaultMaxPerHour: number;
  defaultMaxPerDay: number;
  defaultBatchSize: number;
  defaultAllowWeekends: boolean;
  requireTemplateComplete: boolean;   // block sends with unresolved {{vars}}
  duplicateSimilarityThreshold: number;
  contactFrequencyDays: number;       // min days between any two messages to one contact
  consentMaxAgeDays: number;          // opt-in older than this counts as expired (0 = never)
  historyMaxStaleDays: number;        // DM history sync must be this fresh before auto-send
  notifyEmail: string | null;
  dryRun: boolean;
  dmSyncIntervalMinutes: number;     // how often the worker reads DM history (X bills per event read)
  dmSyncPageSize: number;            // events per incremental read
  autoResolveScope: "opted_in" | "campaigns" | "all"; // whose usernames the worker resolves automatically ($/user)
  // Manual (human-sent) outreach
  manualDailyTarget: number;        // leads to contact per day
  manualBatchSize: number;          // pause-and-review prompt after this many
  manualWorkStart: string;          // "09:00" in defaultTimezone
  manualWorkEnd: string;
  manualWorkDays: number[];         // ISO weekdays
  manualFollowupDays: number;       // "check for reply" reminder N days after contact (0 = off)
  outreachPitch: string;            // one sentence about what YOU offer — used in drafts
  outreachCta: string;              // closing question
  senderName: string;               // how you sign off (blank = no sign-off)
}

export const DEFAULT_SETTINGS: AppSettings = {
  killSwitch: false,
  defaultTimezone: "America/New_York",
  defaultMaxPerHour: 5,
  defaultMaxPerDay: 20,
  defaultBatchSize: 5,
  defaultAllowWeekends: false,
  requireTemplateComplete: true,
  duplicateSimilarityThreshold: 0.92,
  contactFrequencyDays: 90,
  consentMaxAgeDays: 365,
  historyMaxStaleDays: 7,
  notifyEmail: null,
  dryRun: process.env.DRY_RUN !== "false",
  dmSyncIntervalMinutes: 60,
  dmSyncPageSize: 20,
  autoResolveScope: "opted_in",
  manualDailyTarget: 30,
  manualBatchSize: 10,
  manualWorkStart: "09:00",
  manualWorkEnd: "17:00",
  manualWorkDays: [1, 2, 3, 4, 5],
  manualFollowupDays: 3,
  outreachPitch: "I run a small studio that turns SaaS products into short-form videos that bring in signups.",
  outreachCta: "Would you be open to me sending over 2–3 video ideas for {{company}}?",
  senderName: "",
};

export async function getSettings(db: Tx = prisma): Promise<AppSettings> {
  const rows = await db.appSetting.findMany();
  const o: Record<string, unknown> = {};
  for (const r of rows) o[r.key] = r.value;
  return { ...DEFAULT_SETTINGS, ...o } as AppSettings;
}

export async function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K], db: Tx = prisma) {
  await db.appSetting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
}

export async function isKillSwitchOn(db: Tx = prisma) {
  const r = await db.appSetting.findUnique({ where: { key: "killSwitch" } });
  return r?.value === true;
}
