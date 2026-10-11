import { prisma } from "./db";
import type { ImportOption } from "@/components/add-leads-from-import";

/** Imports that can feed a campaign, with how many of their leads are already members. */
export async function importOptionsFor(campaignId: string): Promise<ImportOption[]> {
  const imports = await prisma.csvImport.findMany({ where: { status: { in: ["COMMITTED", "PREVIEWED"] } }, orderBy: { createdAt: "desc" }, take: 20 });
  return Promise.all(imports.map(async (i) => {
    if (i.status === "PREVIEWED") return { id: i.id, filename: i.filename, status: i.status, createdAt: i.createdAt.toISOString(), leads: i.validRows, inCampaign: 0 };
    const rows = await prisma.csvImportRow.findMany({ where: { importId: i.id, contactId: { not: null } }, select: { contactId: true }, distinct: ["contactId"] });
    const ids = rows.map((r) => r.contactId!);
    const inCampaign = ids.length ? await prisma.campaignContact.count({ where: { campaignId, contactId: { in: ids } } }) : 0;
    return { id: i.id, filename: i.filename, status: i.status, createdAt: i.createdAt.toISOString(), leads: ids.length, inCampaign };
  }));
}
