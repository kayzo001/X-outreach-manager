"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Inbox, LayoutDashboard, ListChecks, Megaphone, ScrollText, Send, Settings, Upload, Users, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/leads", label: "All Leads", icon: Users },
  { href: "/import", label: "Import CSV", icon: Upload },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/queue/manual", label: "Manual Queue", icon: ListChecks },
  { href: "/queue/automated", label: "Automated Queue", icon: Send },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/logs", label: "Activity Logs", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav({ unread, pendingApproval }: { unread: number; pendingApproval: number }) {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        const badge = href === "/inbox" ? unread : href === "/queue/automated" ? pendingApproval : 0;
        return (
          <Link key={href} href={href} className={cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition", active ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            <Icon className="h-4 w-4" />
            <span className="flex-1">{label}</span>
            {badge > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{badge}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
export const Brand = () => (
  <div className="flex items-center gap-2 px-3">
    <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground glow"><Zap className="h-4 w-4" /></div>
    <div className="leading-tight"><div className="text-sm font-semibold">Outreach Manager</div><div className="text-[11px] text-muted-foreground">for X</div></div>
  </div>
);
