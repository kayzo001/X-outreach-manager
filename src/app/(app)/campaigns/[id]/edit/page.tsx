import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { CampaignForm } from "@/components/campaign-form";
import { scheduleSchema } from "@/lib/schedule";
import { Card, CardHeader } from "@/components/ui";
import { AddLeadsFromImport } from "@/components/add-leads-from-import";
import { importOptionsFor } from "@/lib/campaign-imports";

export default async function EditCampaign({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.campaign.findUnique({ where: { id }, include: { contacts: { take: 3, include: { contact: true } } } });
  if (!c) notFound();
  const [accounts, templates] = await Promise.all([prisma.xAccount.findMany({ where: { status: "ACTIVE" }, select: { id: true, username: true } }), prisma.messageTemplate.findMany({ orderBy: { name: "asc" } })]);
  const samples = c.contacts.map((m) => m.contact);
  const importOptions = await importOptionsFor(id);
  return (<><PageHeader title={`Edit: ${c.name}`} desc={c.status === "ACTIVE" ? "This campaign is active — changes apply to messages not yet sent." : undefined} />
    <Card className="mb-5"><CardHeader title="Leads" desc="Add every lead from one of your CSV imports to this campaign." /><AddLeadsFromImport campaignId={c.id} imports={importOptions} /></Card>
    <CampaignForm campaign={c} schedule={scheduleSchema.parse(c.schedule)} accounts={accounts} templates={templates} samples={samples} /></>);
}
