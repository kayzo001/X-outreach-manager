import { describe, expect, it } from "vitest";
import { computeNextSendAt, gateSend, inWindow, nextWindowStart, scheduleSchema } from "@/lib/schedule";
import { openSchedule } from "./helpers";

const ny = scheduleSchema.parse({ timezone: "America/New_York", windowStart: "09:00", windowEnd: "17:00", maxPerDay: 20, batchSize: 5, batchDelayMinMinutes: 60, batchDelayMaxMinutes: 60, messageDelayMinutes: 3 });
const d = (s: string) => new Date(s);
const zero = { sentLastHour: 0, sentToday: 0, sentTotal: 0 };

describe("sending window", () => {
  it("honours the campaign timezone (NY, EDT in October)", () => {
    expect(inWindow(ny, d("2026-10-14T13:00:00Z"))).toBe(true);   // 9:00 EDT
    expect(inWindow(ny, d("2026-10-14T12:59:00Z"))).toBe(false);  // 8:59 EDT
    expect(inWindow(ny, d("2026-10-14T21:00:00Z"))).toBe(false);  // 17:00 EDT (end exclusive)
  });
  it("blocks weekends and excluded holidays", () => {
    expect(inWindow(ny, d("2026-10-17T15:00:00Z"))).toBe(false); // Saturday
    const h = { ...ny, holidays: ["2026-10-14"] };
    expect(inWindow(h, d("2026-10-14T15:00:00Z"))).toBe(false);
    expect(inWindow({ ...h, excludeHolidays: false }, d("2026-10-14T15:00:00Z"))).toBe(true);
  });
  it("respects start/end dates", () => {
    const s = { ...ny, startDate: "2026-10-20", endDate: "2026-10-22" };
    expect(inWindow(s, d("2026-10-14T15:00:00Z"))).toBe(false);
    expect(nextWindowStart(s, d("2026-10-14T15:00:00Z"))?.toISOString()).toBe("2026-10-20T13:00:00.000Z");
    expect(nextWindowStart(s, d("2026-10-22T22:00:00Z"))).toBeNull();
  });
  it("rolls to next weekday morning after hours / over the weekend", () => {
    expect(nextWindowStart(ny, d("2026-10-16T22:00:00Z"))?.toISOString()).toBe("2026-10-19T13:00:00.000Z"); // Fri night → Mon 9:00 EDT
  });
});

describe("limits and batch timing", () => {
  const now = d("2026-10-14T15:00:00Z");
  it("allows when under all limits", () => expect(gateSend(ny, now, zero, null).ok).toBe(true));
  it("daily limit blocks and points to next window", () => {
    const g = gateSend(ny, now, { ...zero, sentToday: 20 }, null);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.retryAt?.toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });
  it("hourly limit blocks", () => expect(gateSend(ny, now, { ...zero, sentLastHour: 5 }, null).ok).toBe(false));
  it("campaign cap is terminal", () => { const g = gateSend({ ...ny, maxPerCampaign: 10 }, now, { ...zero, sentTotal: 10 }, null); expect(g.ok).toBe(false); if (!g.ok) expect(g.terminal).toBe(true); });
  it("end date passed is terminal", () => { const g = gateSend({ ...ny, endDate: "2026-10-01" }, now, zero, null); if (!g.ok) expect(g.terminal).toBe(true); expect(g.ok).toBe(false); });
  it("waits for nextSendAt", () => expect(gateSend(ny, now, zero, d("2026-10-14T15:03:00Z")).ok).toBe(false));
  it("spaces messages by 3 min within a batch, then 60 min after batch of 5", () => {
    let t = now, count = 0; const times: number[] = [];
    for (let i = 0; i < 6; i++) { const n = computeNextSendAt(ny, t, count); times.push((n.nextSendAt.getTime() - t.getTime()) / 60_000); t = n.nextSendAt; count = n.batchSentCount; }
    expect(times).toEqual([3, 3, 3, 3, 60, 3]);
  });
  it("pushes next send into next window if delay crosses closing time", () => {
    const n = computeNextSendAt(ny, d("2026-10-14T20:58:00Z"), 4); // 16:58 EDT + 60m → after close
    expect(n.nextSendAt.toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });
  it("validates max ≥ min batch delay", () => expect(() => scheduleSchema.parse({ batchDelayMinMinutes: 30, batchDelayMaxMinutes: 10 })).toThrow());
  it("test helper schedule is valid", () => expect(openSchedule().batchSize).toBe(100));
});
