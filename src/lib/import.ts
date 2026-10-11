import { Prisma } from "@prisma/client";
import { readSheet } from "read-excel-file/node";
import { prisma } from "./db";
import { logActivity } from "./activity";
import { rescoreContacts } from "./scoring";
import { Mapping, MappedRow, RawRow, autoDetectMapping, mapRow, parseCsvText, parseIntSafe, parseMrr, toCsv } from "./csv";

const CHUNK = 1000;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export async function stageImport(filename: string, data: Buffer) {
  if (data.length > MAX_IMPORT_BYTES) throw new Error("File too large (max 25 MB)");
  let headers: string[]; let rows: RawRow[];
  if (/\.xlsx$/i.test(filename)) {
    const sheet = (await readSheet(data)) as unknown as unknown[][];
    const hdr = (sheet[0] ?? []).map((h) => String(h ?? "").trim());
    headers = hdr.filter(Boolean);
    rows = sheet.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i] === null || r[i] === undefined ? "" : String(r[i])]))).filter((r) => Object.values(r).some((v) => String(v).trim() !== ""));
  } else if (/\.(csv|txt)$/i.test(filename)) {
    ({ headers, rows } = parseCsvText(data.toString("utf8")));
  } else throw new Error("Unsupported file type — use .csv or .xlsx");
  if (!headers.length) throw new Error("No header row detected");

  const imp = await prisma.csvImport.create({ data: { filename: filename.slice(0, 200), headers, totalRows: rows.length } });
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.csvImportRow.createMany({ data: rows.slice(i, i + CHUNK).map((raw, j) => ({ importId: imp.id, rowNumber: i + j + 2, raw: raw as Prisma.InputJsonValue })) });
  }
  await logActivity({ type: "import.staged", message: `Uploaded ${filename} (${rows.length} rows)`, meta: { importId: imp.id } });
  return { importId: imp.id, headers, mapping: autoDetectMapping(headers), totalRows: rows.length, sample: rows.slice(0, 5) };
}

async function bulkClassify(updates: { id: string; status: string; reason: string | null; u: string | null }[]) {
  if (!updates.length) return;
  await prisma.$executeRaw`
    UPDATE csv_import_rows r SET status = v.status::"ImportRowStatus", reason = v.reason, "usernameNormalized" = v.u
    FROM (SELECT unnest(${updates.map((x) => x.id)}::text[]) AS id, unnest(${updates.map((x) => x.status)}::text[]) AS status,
                 unnest(${updates.map((x) => x.reason)}::text[]) AS reason, unnest(${updates.map((x) => x.u)}::text[]) AS u) v
    WHERE r.id = v.id`;
}

/** Classifies every staged row. Safe to re-run with a different mapping. */
export async function previewImport(importId: string, mapping: Mapping) {
  if (!mapping.username) throw new Error("A username column mapping is required");
  await prisma.csvImport.update({ where: { id: importId }, data: { mapping: mapping as Prisma.InputJsonValue } });
  const seen = new Set<string>();
  const counts = { total: 0, valid: 0, newRows: 0, existing: 0, dupInFile: 0, invalid: 0 };
  let cursor = 0;
  for (;;) {
    const rows = await prisma.csvImportRow.findMany({ where: { importId, rowNumber: { gt: cursor } }, orderBy: { rowNumber: "asc" }, take: CHUNK, select: { id: true, rowNumber: true, raw: true } });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].rowNumber;
    const mapped = rows.map((r) => ({ r, m: mapRow(r.raw as RawRow, mapping) }));
    const candidates = [...new Set(mapped.filter((x) => x.m.username).map((x) => x.m.username!))];
    const existing = new Set((await prisma.contact.findMany({ where: { usernameNormalized: { in: candidates } }, select: { usernameNormalized: true } })).map((c) => c.usernameNormalized));
    const ups: { id: string; status: string; reason: string | null; u: string | null }[] = [];
    for (const { r, m } of mapped) {
      counts.total++;
      if (!m.username) { counts.invalid++; ups.push({ id: r.id, status: "INVALID", reason: m.usernameError ?? "Invalid username", u: null }); continue; }
      if (seen.has(m.username)) { counts.dupInFile++; ups.push({ id: r.id, status: "DUP_IN_FILE", reason: "Duplicate of an earlier row in this file", u: m.username }); continue; }
      seen.add(m.username);
      counts.valid++;
      if (existing.has(m.username)) { counts.existing++; ups.push({ id: r.id, status: "EXISTING", reason: "Already in database — history preserved", u: m.username }); }
      else { counts.newRows++; ups.push({ id: r.id, status: "NEW", reason: null, u: m.username }); }
    }
    await bulkClassify(ups);
  }
  await prisma.csvImport.update({ where: { id: importId }, data: { status: "PREVIEWED", totalRows: counts.total, validRows: counts.valid, newRows: counts.newRows, existingRows: counts.existing, dupInFileRows: counts.dupInFile, invalidRows: counts.invalid } });
  return counts;
}

const fill = <T>(existing: T | null | undefined, incoming: T | null | undefined) => (existing === null || existing === undefined || existing === "" ? (incoming ?? undefined) : undefined);

function contactData(m: MappedRow, raw: RawRow, mapping: Mapping, importId: string) {
  const f = m.fields;
  const mapped = new Set(Object.values(mapping));
  const extra = Object.fromEntries(Object.entries(raw).filter(([k, v]) => !mapped.has(k) && String(v).trim() !== ""));
  const mrr = parseMrr(f.mrr);
  return {
    founderName: f.founder_name, company: f.company, website: f.website, product: f.product, industry: f.industry, location: f.location,
    country: f.country, language: f.language, bio: f.bio, notes: f.notes, customHook: f.custom_hook, sourceUrl: f.source_url,
    followers: parseIntSafe(f.followers) ?? undefined,
    verified: f.verified ? /^(1|true|yes|y)$/i.test(f.verified) : undefined,
    mrr: mrr ?? undefined, mrrKind: mrr != null ? ("SELF_REPORTED" as const) : undefined, // CSV MRR is a claim, never "verified"
    // consent_status in a file is a claim by the file's author — recorded for reference, NEVER applied as consent.
    customFields: { ...extra, ...(f.consent_status ? { csv_consent_claim: f.consent_status } : {}) },
    leadSource: `import:${importId}`,
  };
}

export async function commitImport(importId: string, opts: { campaignId?: string | null } = {}) {
  const imp = await prisma.csvImport.findUniqueOrThrow({ where: { id: importId } });
  if (imp.status === "COMMITTED") throw new Error("Import already committed");
  if (imp.status === "COMMITTING") throw new Error("Import is already being committed");
  if (imp.status !== "PREVIEWED") throw new Error("Preview the import before committing");
  const claimed = await prisma.csvImport.updateMany({ where: { id: importId, status: "PREVIEWED" }, data: { status: "COMMITTING" } });
  if (!claimed.count) throw new Error("Import is already being committed");
  const mapping = imp.mapping as Mapping;
  const campaignIds = new Map<string, string>();
  const campaignFor = async (name: string) => {
    const k = name.toLowerCase();
    if (campaignIds.has(k)) return campaignIds.get(k)!;
    let c = await prisma.campaign.findFirst({ where: { name: { equals: name, mode: "insensitive" }, status: { not: "ARCHIVED" } } });
    if (!c) c = await prisma.campaign.create({ data: { name, status: "DRAFT", schedule: {} } });
    campaignIds.set(k, c.id);
    return c.id;
  };
  let created = 0, linked = 0, cursor = 0, backfilled = 0;
  try {
    for (;;) {
      const rows = await prisma.csvImportRow.findMany({ where: { importId, rowNumber: { gt: cursor }, status: { in: ["NEW", "EXISTING"] } }, orderBy: { rowNumber: "asc" }, take: CHUNK });
      if (!rows.length) break;
      cursor = rows[rows.length - 1].rowNumber;
      const mapped = rows.map((r) => ({ r, m: mapRow(r.raw as RawRow, mapping) })).filter((x) => x.m.username);
      const names = mapped.map((x) => x.m.username!);
      const suppressed = new Set((await prisma.suppressionEntry.findMany({ where: { usernameNormalized: { in: names } }, select: { usernameNormalized: true } })).map((s) => s.usernameNormalized));

      const before = await prisma.contact.findMany({ where: { usernameNormalized: { in: names } } });
      const beforeSet = new Set(before.map((c) => c.usernameNormalized));
      const toCreate = mapped.filter((x) => !beforeSet.has(x.m.username!));
      if (toCreate.length) {
        const res = await prisma.contact.createMany({
          skipDuplicates: true, // race-safe: unique(usernameNormalized) is the real guard
          data: toCreate.map(({ m, r }) => ({
            usernameNormalized: m.username!, usernameDisplay: m.username!, firstImportId: importId,
            doNotContact: suppressed.has(m.username!), consentStatus: suppressed.has(m.username!) ? ("OPTED_OUT" as const) : ("UNKNOWN" as const),
            ...contactData(m, r.raw as RawRow, mapping, importId),
          })),
        });
        created += res.count;
      }
      const all = await prisma.contact.findMany({ where: { usernameNormalized: { in: names } } });
      const byName = new Map(all.map((c) => [c.usernameNormalized, c]));

      await prisma.contactIdentifier.createMany({ skipDuplicates: true, data: all.map((c) => ({ contactId: c.id, type: "USERNAME", value: c.usernameNormalized })) });
      for (const { r, m } of mapped) {
        const c = byName.get(m.username!);
        if (!c) continue;
        await prisma.csvImportRow.update({ where: { id: r.id }, data: { contactId: c.id } });
        // Existing contacts: ONLY fill blanks. Never overwrite, never touch consent/history/status.
        if (beforeSet.has(m.username!)) {
          const d = contactData(m, r.raw as RawRow, mapping, importId);
          const patch: Prisma.ContactUpdateInput = {
            founderName: fill(c.founderName, d.founderName), company: fill(c.company, d.company), website: fill(c.website, d.website), product: fill(c.product, d.product),
            industry: fill(c.industry, d.industry), location: fill(c.location, d.location), country: fill(c.country, d.country), language: fill(c.language, d.language),
            bio: fill(c.bio, d.bio), customHook: fill(c.customHook, d.customHook), sourceUrl: fill(c.sourceUrl, d.sourceUrl), followers: fill(c.followers, d.followers),
            ...(c.mrr == null && d.mrr != null ? { mrr: d.mrr, mrrKind: "SELF_REPORTED" as const } : {}),
          };
          const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
          if (Object.keys(clean).length) { await prisma.contact.update({ where: { id: c.id }, data: clean }); backfilled++; }
        }
      }
      // Campaign memberships (default campaign + per-row `campaign` column). Unique(campaignId, contactId) makes this idempotent.
      const memberships: { campaignId: string; contactId: string; customMessage?: string }[] = [];
      for (const { m } of mapped) {
        const c = byName.get(m.username!);
        if (!c) continue;
        const cid = m.fields.campaign ? await campaignFor(m.fields.campaign) : opts.campaignId;
        if (cid) memberships.push({ campaignId: cid, contactId: c.id, customMessage: m.fields.message });
      }
      if (memberships.length) linked += (await prisma.campaignContact.createMany({ skipDuplicates: true, data: memberships })).count;
      await prisma.csvImport.update({ where: { id: importId }, data: { committedRows: { increment: mapped.length } } });
    }
    await prisma.csvImport.update({ where: { id: importId }, data: { status: "COMMITTED", committedAt: new Date(), campaignId: opts.campaignId ?? null } });
  } catch (e) {
    await prisma.csvImport.update({ where: { id: importId }, data: { status: "PREVIEWED" } }); // resumable: createMany/memberships are idempotent
    throw e;
  }
  const touched = await prisma.csvImportRow.findMany({ where: { importId, contactId: { not: null } }, select: { contactId: true } });
  await rescoreContacts(touched.map((r) => r.contactId!));
  await logActivity({ type: "import.committed", message: `Import committed: ${created} new contacts, ${linked} campaign links, ${backfilled} existing contacts back-filled`, meta: { importId } });
  return { created, linked, backfilled };
}

export async function rejectedRowsCsv(importId: string) {
  const imp = await prisma.csvImport.findUniqueOrThrow({ where: { id: importId } });
  const rows = await prisma.csvImportRow.findMany({ where: { importId, status: { in: ["INVALID", "DUP_IN_FILE"] } }, orderBy: { rowNumber: "asc" } });
  const headers = ["row_number", "rejection_reason", ...imp.headers];
  return toCsv(headers, rows.map((r) => [r.rowNumber, r.reason, ...imp.headers.map((h) => (r.raw as RawRow)[h] ?? "")]));
}
