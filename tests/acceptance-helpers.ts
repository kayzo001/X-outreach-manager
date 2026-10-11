import { prisma } from "@/lib/db";
export { runSchedulerTick, setCampaignStatus } from "@/lib/engine";
export const approveAllForTest = () => prisma.messageJob.updateMany({ where: { status: "PENDING_APPROVAL" }, data: { status: "QUEUED" } });
