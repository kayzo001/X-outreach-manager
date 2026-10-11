import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { Brand, Nav } from "@/components/nav";
import { Alert } from "@/components/ui";
import { LogOut } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [settings, unread, pending, worker] = await Promise.all([
    getSettings(),
    prisma.conversation.count({ where: { unread: true } }),
    prisma.messageJob.count({ where: { status: "PENDING_APPROVAL" } }),
    prisma.workerStatus.findFirst({ orderBy: { heartbeatAt: "desc" } }),
  ]);
  const workerAlive = worker && Date.now() - worker.heartbeatAt.getTime() < 45_000;
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col justify-between border-r bg-card/50 px-3 py-5 md:flex">
        <div className="space-y-6"><Brand /><Nav unread={unread} pendingApproval={pending} /></div>
        <div className="space-y-3 px-1">
          <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${workerAlive ? "bg-success" : "bg-destructive"}`} />
            Worker {workerAlive ? "online" : "offline"}
            {settings.dryRun && <span className="ml-auto rounded bg-warning/15 px-1.5 text-[10px] font-medium text-warning">DRY RUN</span>}
          </div>
          <form action="/api/auth/logout" method="post"><button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted"><LogOut className="h-3.5 w-3.5" />{user.email}</button></form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="border-b bg-card/50 px-4 py-2 md:hidden"><Brand /></div>
        {settings.killSwitch && <div className="px-6 pt-4"><Alert tone="danger" title="EMERGENCY STOP IS ON">All automated sending is halted. Release it in Settings → System.</Alert></div>}
        <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8">{children}</div>
      </main>
    </div>
  );
}
