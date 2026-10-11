import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, previewImport, rejectedRowsCsv, stageImport } from "@/lib/import";
import { safeCell, toCsv, autoDetectMapping, mapRow } from "@/lib/csv";
import { resetDb } from "./helpers";
import { recordConsent } from "@/lib/consent";

const csv = (rows: string[], header = "username,founder_name,company,mrr,consent_status") => Buffer.from([header, ...rows].join("\n"));

beforeEach(resetDb);

describe("CSV import", () => {
  it("detects headers, normalises, flags invalid + in-file duplicates, ignores blanks", async () => {
    const s = await stageImport("a.csv", csv(["@Alice,Alice A,Acme,5k,yes", "", "alice,Dup,Acme2,,", "https://x.com/Bob,Bob B,Beta,,", "bad name!,X,Y,,", "not a url https://,Z,Z,,", "carol,Carol,C,,"]));
    expect(s.mapping.username).toBe("username");
    const c = await previewImport(s.importId, s.mapping);
    expect(c).toMatchObject({ total: 6, valid: 3, newRows: 3, dupInFile: 1, invalid: 2, existing: 0 });
    const rej = await rejectedRowsCsv(s.importId);
    expect(rej).toContain("Duplicate of an earlier row");
    expect(rej).toContain("invalid characters");
  });

  it("re-importing the same file creates no duplicates and keeps history untouched", async () => {
    const file = csv(["alice,Alice,Acme,,", "bob,Bob,Beta,,"]);
    const a = await stageImport("a.csv", file); await previewImport(a.importId, a.mapping); const r1 = await commitImport(a.importId);
    expect(r1.created).toBe(2);
    const alice = await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "alice" } });
    await recordConsent(alice.id, { status: "OPTED_IN", source: "form", evidence: "ref-1" });
    await prisma.contact.update({ where: { id: alice.id }, data: { historyStatus: "CONTACTED", company: "Edited Co" } });

    const b = await stageImport("a.csv", file);
    const counts = await previewImport(b.importId, b.mapping);
    expect(counts).toMatchObject({ newRows: 0, existing: 2 });
    const r2 = await commitImport(b.importId);
    expect(r2.created).toBe(0);
    expect(await prisma.contact.count()).toBe(2);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: alice.id } });
    expect(after.historyStatus).toBe("CONTACTED");
    expect(after.consentStatus).toBe("OPTED_IN");
    expect(after.company).toBe("Edited Co"); // never overwritten
  });

  it("does not treat a CSV consent column as consent", async () => {
    const s = await stageImport("a.csv", csv(["alice,A,Acme,,opted_in"])); await previewImport(s.importId, s.mapping); await commitImport(s.importId);
    const c = await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "alice" } });
    expect(c.consentStatus).toBe("UNKNOWN");
    expect(await prisma.consentRecord.count()).toBe(0);
  });

  it("one contact can belong to several campaigns without duplicating identity", async () => {
    const c1 = await prisma.campaign.create({ data: { name: "A", schedule: {} } });
    const c2 = await prisma.campaign.create({ data: { name: "B", schedule: {} } });
    for (const cid of [c1.id, c2.id]) { const s = await stageImport("a.csv", csv(["alice,A,Acme,,"])); await previewImport(s.importId, s.mapping); await commitImport(s.importId, { campaignId: cid }); }
    expect(await prisma.contact.count()).toBe(1);
    expect(await prisma.campaignContact.count()).toBe(2);
  });

  it("marks CSV MRR as self-reported, and suppressed usernames stay do-not-contact", async () => {
    await prisma.suppressionEntry.create({ data: { usernameNormalized: "bob", reason: "test" } });
    const s = await stageImport("a.csv", csv(["alice,A,Acme,$12k,", "bob,B,B,,"])); await previewImport(s.importId, s.mapping); await commitImport(s.importId);
    expect(await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "alice" } })).toMatchObject({ mrr: 12000, mrrKind: "SELF_REPORTED" });
    expect(await prisma.contact.findUniqueOrThrow({ where: { usernameNormalized: "bob" } })).toMatchObject({ doNotContact: true, consentStatus: "OPTED_OUT" });
  });

  it("imports 10,000 rows (with 5% duplicates) correctly and quickly", async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `user${i % 9_500},Name ${i},Co ${i},,`);
    const t0 = Date.now();
    const s = await stageImport("big.csv", csv(rows));
    const c = await previewImport(s.importId, s.mapping);
    expect(c).toMatchObject({ total: 10_000, valid: 9_500, dupInFile: 500, newRows: 9_500 });
    const r = await commitImport(s.importId);
    expect(r.created).toBe(9_500);
    expect(await prisma.contact.count()).toBe(9_500);
    console.log(`10k import took ${Date.now() - t0} ms`);
  }, 120_000);

  it("defends against CSV formula injection on export", () => {
    for (const bad of ["=cmd|' /C calc'!A0", "+1+1", "-2", "@SUM(A1)", "\tx"]) expect(safeCell(bad).startsWith("'")).toBe(true);
    expect(toCsv(["a"], [["=1+1"], ['he said "hi", ok']])).toBe(`a\r\n'=1+1\r\n"he said ""hi"", ok"`);
  });

  it("auto-maps alternative header names", () => {
    const m = autoDetectMapping(["Handle", "Founder", "Startup", "Revenue"]);
    expect(m).toMatchObject({ username: "Handle", founder_name: "Founder", company: "Startup", mrr: "Revenue" });
    expect(mapRow({ Handle: "@X_y" }, m).username).toBe("x_y");
  });
});

describe("XLSX import", () => {
  it("parses xlsx, maps alternative headers, normalises and dedupes", async () => {
    const { readFileSync } = await import("fs");
    const s = await stageImport("fixture.xlsx", readFileSync("tests/fixture.xlsx"));
    expect(s.mapping).toMatchObject({ username: "Handle", founder_name: "Founder", company: "Startup", mrr: "Revenue" });
    expect(await previewImport(s.importId, s.mapping)).toMatchObject({ total: 3, valid: 2, newRows: 2, dupInFile: 1 });
    await commitImport(s.importId);
    expect((await prisma.contact.findMany({ orderBy: { usernameNormalized: "asc" } })).map((c) => c.usernameNormalized)).toEqual(["xlsx_two", "xlsxone"]);
  });
});
