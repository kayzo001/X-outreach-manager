import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border bg-card", className)} {...p} />;
}
export function CardHeader({ title, desc, right }: { title: React.ReactNode; desc?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
      <div><h3 className="text-sm font-semibold">{title}</h3>{desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}</div>
      {right}
    </div>
  );
}
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "success"; size?: "sm" | "md" };
export const btnClass = (variant: BtnProps["variant"] = "secondary", size: BtnProps["size"] = "md") =>
  cn("inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 ring-primary/60",
    size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
    variant === "primary" && "bg-primary text-primary-foreground hover:brightness-110 glow",
    variant === "secondary" && "border bg-muted hover:bg-accent",
    variant === "ghost" && "hover:bg-muted text-muted-foreground hover:text-foreground",
    variant === "danger" && "bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/25",
    variant === "success" && "bg-success/15 text-success border border-success/30 hover:bg-success/25");
export function Button({ variant, size, className, ...p }: BtnProps) { return <button className={cn(btnClass(variant, size), className)} {...p} />; }
export function LinkButton({ href, variant, size, className, children, ...p }: { href: string; variant?: BtnProps["variant"]; size?: BtnProps["size"]; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return <Link href={href} className={cn(btnClass(variant, size), className)} {...p}>{children}</Link>;
}
const field = "w-full rounded-md border bg-muted/60 px-3 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 ring-primary/50";
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, r) => <input ref={r} className={cn(field, "h-9", className)} {...p} />);
Input.displayName = "Input";
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, r) => <select ref={r} className={cn(field, "h-9", className)} {...p} />);
Select.displayName = "Select";
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, r) => <textarea ref={r} className={cn(field, "py-2 leading-relaxed", className)} {...p} />);
Textarea.displayName = "Textarea";
export function Label({ children, hint, className }: { children: React.ReactNode; hint?: string; className?: string }) {
  return <label className={cn("mb-1.5 block text-xs font-medium text-muted-foreground", className)}>{children}{hint && <span className="ml-1.5 font-normal opacity-70">{hint}</span>}</label>;
}

const tones = {
  neutral: "bg-muted text-muted-foreground border-border", primary: "bg-primary/15 text-primary border-primary/30",
  success: "bg-success/15 text-success border-success/30", warning: "bg-warning/15 text-warning border-warning/30", danger: "bg-destructive/15 text-destructive border-destructive/30",
};
export function Badge({ tone = "neutral", className, children }: { tone?: keyof typeof tones; className?: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", tones[tone], className)}>{children}</span>;
}
export const statusTone = (s: string): keyof typeof tones => {
  if (/^(ACTIVE|OPTED_IN|SENT|RESOLVED|COMPLETED|CUSTOMER|CONVERTED|COMMITTED|ok)$/i.test(s)) return "success";
  if (/^(PAUSED|PENDING_APPROVAL|UNCERTAIN|UNKNOWN|EXPIRED|DRAFT|QUEUED|DRY_RUN|NONE_FOUND|INTERESTED|POTENTIAL_CUSTOMER|SENDING)$/i.test(s)) return "warning";
  if (/^(FAILED|OPTED_OUT|REVOKED|NOT_FOUND|SUSPENDED|DO_NOT_CONTACT|NOT_INTERESTED|CONTACTED)$/i.test(s) && !/^CONTACTED$/i.test(s)) return "danger";
  if (/^(CONTACTED|REPLIED)$/i.test(s)) return "primary";
  return "neutral";
};
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={statusTone(s)}>{s.replace(/_/g, " ").toLowerCase()}</Badge>;

export function StatCard({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "success" | "warning" | "danger" | "primary" }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 text-2xl font-semibold tracking-tight", tone === "success" && "text-success", tone === "warning" && "text-warning", tone === "danger" && "text-destructive", tone === "primary" && "text-primary")}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}
export function PageHeader({ title, desc, actions }: { title: string; desc?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold tracking-tight">{title}</h1>{desc && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{desc}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
export function Empty({ title, desc, action }: { title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="text-sm font-medium">{title}</div>
      {desc && <div className="max-w-sm text-xs text-muted-foreground">{desc}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("scroll-thin overflow-x-auto", className)}><table className="w-full text-sm">{children}</table></div>;
}
export const Th = ({ children, className }: { children?: React.ReactNode; className?: string }) => <th className={cn("whitespace-nowrap border-b px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground", className)}>{children}</th>;
export const Td = ({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("border-b border-border/60 px-4 py-3 align-middle", className)} {...p}>{children}</td>;

export function Alert({ tone = "warning", title, children }: { tone?: "warning" | "danger" | "primary" | "success"; title?: string; children?: React.ReactNode }) {
  const c = { warning: "border-warning/30 bg-warning/10 text-warning", danger: "border-destructive/30 bg-destructive/10 text-destructive", primary: "border-primary/30 bg-primary/10 text-primary", success: "border-success/30 bg-success/10 text-success" }[tone];
  return <div className={cn("rounded-md border px-4 py-3 text-sm", c)}>{title && <div className="font-medium">{title}</div>}{children && <div className={cn("text-foreground/80", title && "mt-1 text-xs")}>{children}</div>}</div>;
}
export function ScorePill({ score, incomplete }: { score: number | null | undefined; incomplete?: boolean }) {
  if (score === null || score === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  const tone = score >= 60 ? "success" : score >= 30 ? "warning" : "neutral";
  return <Badge tone={tone}>{score}{incomplete ? " ~" : ""}</Badge>;
}
