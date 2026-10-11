"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { FileSpreadsheet, Plus, Upload } from "lucide-react";
import { Badge, Button } from "./ui";
import { addImportToCampaign } from "@/app/actions";
import { cn } from "@/lib/utils";

export interface ImportOption { id: string; filename: string; status: string; createdAt: string; leads: number; inCampaign: number }

export function AddLeadsFromImport({ campaignId, imports }: { campaignId: string; imports: ImportOption[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [, start] = useTransition();
  const add = (id: string) => { setBusy(id); setMsg(null); start(async () => { setMsg(await addImportToCampaign(campaignId, id)); setBusy(null); }); };

  return (
    <div className="space-y-2 p-4">
      {imports.map((i) => {
        const pendingImport = i.status === "PREVIEWED";
        const remaining = Math.max(0, i.leads - i.inCampaign);
        const done = !pendingImport && remaining === 0;
        return (
          <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={i.filename}>{i.filename}</div>
              <div className="text-[11px] text-muted-foreground">
                {new Date(i.createdAt).toLocaleDateString()} · {i.leads.toLocaleString()} {pendingImport ? "valid rows, not imported yet" : "leads"}
                {!pendingImport && i.inCampaign > 0 && ` · ${i.inCampaign.toLocaleString()} already in this campaign`}
              </div>
            </div>
            {pendingImport && <Badge tone="warning">not imported</Badge>}
            {done ? <Badge tone="success">all added</Badge> : (
              <Button size="sm" variant={pendingImport ? "secondary" : "primary"} disabled={!!busy} onClick={() => add(i.id)}>
                {pendingImport ? <Upload className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {busy === i.id ? "Adding…" : pendingImport ? `Import & add ${i.leads.toLocaleString()}` : `Add ${remaining.toLocaleString()} leads`}
              </Button>
            )}
          </div>
        );
      })}
      {!imports.length && <p className="py-3 text-center text-xs text-muted-foreground">No CSV imports yet. <Link className="text-primary hover:underline" href="/import">Import a CSV →</Link></p>}
      {msg && <div className={cn("rounded-md border px-3 py-2 text-xs", msg.ok ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive")}>{msg.message}</div>}
      <p className="text-[11px] text-muted-foreground">Adding leads never sends anything. Leads without a documented opt-in go to the manual queue; existing contact history and duplicate protection still apply. Want only some leads? Use <Link className="text-primary hover:underline" href="/leads">All Leads</Link> filters → “Add to campaign”.</p>
    </div>
  );
}
