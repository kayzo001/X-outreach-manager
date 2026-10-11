import Link from "next/link";
import { prisma } from "@/lib/db";
import { nextManualLead, manualStats } from "@/lib/manual-outreach";
import { FocusMode } from "@/components/focus-mode";
import { PageHeader } from "@/components/ui";

export default async function FocusPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const sp = await searchParams;
  const campaignId = sp.campaign || null;
  const [lead, stats, campaigns] = await Promise.all([
    nextManualLead({ campaignId }), manualStats(campaignId),
    prisma.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <>
      <PageHeader title="Focus mode" desc={<>One lead at a time, best score first. You send each DM yourself on X — the app prepares the draft, checks for duplicates and records what you sent. <Link className="text-primary hover:underline" href="/queue/manual">List view</Link> · <Link className="text-primary hover:underline" href="/settings#manual">targets & hours</Link></>} />
      <FocusMode initial={{ lead, stats }} campaignId={campaignId} campaigns={campaigns} />
    </>
  );
}
