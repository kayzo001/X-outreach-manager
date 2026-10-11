"use client";
import { useState, useTransition } from "react";
import { Button } from "./ui";

/** Runs a server action (optionally returning a status message) with a confirm + pending state. */
export function ActionButton({ action, args = [], label, confirmText, variant, size = "sm", className }: { action: (...a: any[]) => Promise<unknown>; args?: unknown[]; label: string; confirmText?: string; variant?: "primary" | "secondary" | "ghost" | "danger" | "success"; size?: "sm" | "md"; className?: string }) {
  const [p, start] = useTransition(); const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant={variant} size={size} className={className} disabled={p} onClick={() => { if (confirmText && !confirm(confirmText)) return; start(async () => { try { const r = await action(...args); setMsg(typeof r === "string" ? r : null); } catch (e) { setMsg((e as Error).message); } }); }}>{p ? "Working…" : label}</Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
