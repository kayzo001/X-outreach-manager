import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { CampaignForm } from "@/components/campaign-form";
import { defaultSchedule } from "@/lib/schedule";
import { getSettings } from "@/lib/settings";

export default async function NewCampaign() {
  const [accounts, templates, settings, samples] = await Promise.all([
    prisma.xAccount.findMany({ where: { status: "ACTIVE" }, select: { id: true, username: true } }),
    prisma.messageTemplate.findMany({ orderBy: { name: "asc" } }),
    getSettings(),
    prisma.contact.findMany({ take: 3, orderBy: { createdAt: "desc" }, select: { id: true, usernameDisplay: true, founderName: true, company: true, product: true, industry: true, customHook: true } }),
  ]);
  const sch = { ...defaultSchedule(), timezone: settings.defaultTimezone, maxPerHour: settings.defaultMaxPerHour, maxPerDay: settings.defaultMaxPerDay, batchSize: settings.defaultBatchSize, allowWeekends: settings.defaultAllowWeekends };
  return (<><PageHeader title="Create campaign" desc="Set up the audience, message and schedule. Nothing sends until you start the campaign, and automated delivery only ever reaches opted-in recipients." />
    <CampaignForm schedule={sch} accounts={accounts} templates={templates} samples={samples} /></>);
}
