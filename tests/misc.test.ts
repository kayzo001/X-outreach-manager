import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "@/lib/crypto";
import { renderTemplate, findNearDuplicates, usedVariables } from "@/lib/template";
import { scoreContact } from "@/lib/scoring";
import { logActivity } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { DryRunProvider, mockProvider } from "@/lib/provider";
import { buildWhere } from "@/lib/filters";
import { resetDb } from "./helpers";

describe("crypto", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const a = encrypt("secret-token"), b = encrypt("secret-token");
    expect(a).not.toBe(b); expect(decrypt(a)).toBe("secret-token");
    expect(a).not.toContain("secret-token");
  });
  it("detects tampering", () => { const p = encrypt("x").split("."); p[3] = Buffer.from("zz").toString("base64url"); expect(() => decrypt(p.join("."))).toThrow(); });
});

describe("templates", () => {
  const c = { usernameDisplay: "alice", founderName: "Alice Smith", company: "Acme" };
  it("renders and reports missing variables without inventing values", () => {
    const r = renderTemplate("Hey {{first_name}}, {{company}} / {{product}} {{bogus}}", c);
    expect(r.text).toBe("Hey Alice, Acme / {{product}} {{bogus}}");
    expect(r.missing).toEqual(["product"]); expect(r.unknown).toEqual(["bogus"]); expect(r.complete).toBe(false);
  });
  it("lists variables and flags near-identical messages", () => {
    expect(usedVariables("{{company}} {{first_name}} {{company}}")).toEqual(["company", "first_name"]);
    const dup = findNearDuplicates([{ id: "a", text: "Hey Sam, loved your product launch, would love to chat about video content." }, { id: "b", text: "Hey Sam, loved your product launch, would love to chat about video content!" }, { id: "c", text: "Completely different." }]);
    expect(dup).toHaveLength(1);
  });
});

describe("lead scoring", () => {
  const base = { id: "1", usernameNormalized: "a", bio: null, industry: null, product: null, mrr: null, mrrKind: "UNKNOWN", lastActiveAt: null, customFields: null } as never;
  it("is 0 and fully 'unknown' with no data — never fabricates", () => {
    const r = scoreContact(base);
    expect(r.score).toBe(0); expect(r.incomplete).toBe(true); expect(r.knownSignals).toBe(0);
  });
  it("self-reported revenue scores lower than verified", () => {
    const self = scoreContact({ ...(base as object), mrr: 20000, mrrKind: "SELF_REPORTED" } as never).score;
    const ver = scoreContact({ ...(base as object), mrr: 20000, mrrKind: "VERIFIED" } as never).score;
    expect(ver).toBeGreaterThan(self); expect(self).toBeGreaterThan(0);
  });
  it("scores within 0..100 with explainable factors", () => {
    const r = scoreContact({ ...(base as object), bio: "Founder of a SaaS. YouTube creator, marketing nerd", industry: "SaaS design tool", mrr: 50000, mrrKind: "VERIFIED", lastActiveAt: new Date(), customFields: { team_size: 3, milestone: "Seed", launched_at: new Date().toISOString() } } as never);
    expect(r.score).toBeLessThanOrEqual(100); expect(r.score).toBeGreaterThan(80);
    expect(r.factors.every((f) => f.detail.length > 0)).toBe(true);
  });
});

describe("activity log + dry-run provider + filters", () => {
  it("scrubs secrets from log metadata", async () => {
    await resetDb();
    await logActivity({ type: "t", message: "m", meta: { accessToken: "abc", nested: { client_secret: "zzz", ok: 1 } } });
    const row = await prisma.activityLog.findFirstOrThrow();
    expect(JSON.stringify(row.meta)).not.toMatch(/abc|zzz/);
    await expect(prisma.activityLog.update({ where: { id: row.id }, data: { message: "tamper" } })).rejects.toThrow();
  });
  it("DryRunProvider can never send", async () => {
    await expect(new DryRunProvider(mockProvider).sendDm()).rejects.toThrow(/DRY_RUN/);
  });
  it("filter builder supports AND/OR", () => {
    const and = buildWhere({ op: "AND", conditions: [{ field: "mrr", operator: "gt", value: 10000 }, { field: "previouslyMessaged", operator: "is", value: false }] });
    expect(JSON.stringify(and)).toContain('"AND"');
    const or = buildWhere({ op: "OR", conditions: [{ field: "company", operator: "contains", value: "x" }, { field: "replied", operator: "is", value: true }] });
    expect(JSON.stringify(or)).toContain('"OR"');
  });
});

describe("filter examples from the brief", () => {
  it("builds 'MRR > $10K and not contacted' and 'missing verified revenue'", () => {
    expect(JSON.stringify(buildWhere({ op: "AND", conditions: [{ field: "mrr", operator: "gt", value: 10000 }, { field: "previouslyMessaged", operator: "is", value: false }] }))).toContain('"gt":10000');
    expect(JSON.stringify(buildWhere({ op: "AND", conditions: [{ field: "mrrKind", operator: "is_not", value: "VERIFIED" }] }))).toContain('"not":"VERIFIED"');
    expect(JSON.stringify(buildWhere({ op: "AND", conditions: [{ field: "consentScope", operator: "contains", value: "product updates" }] }))).toContain("product updates");
  });
});
