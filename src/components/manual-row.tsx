"use client";
import { useState, useTransition } from "react";
import { Check, Copy, ExternalLink, MessageSquareReply, SkipForward } from "lucide-react";
import { Badge, Button, ScorePill } from "./ui";
import { manualContacted, manualStatus } from "@/app/actions";
import Link from "next/link";

export interface ManualItem { id: string; username: string; founder: string | null; company: string | null; score: number | null; incomplete: boolean; message: string; missing: string[]; campaignId: string | null; manualStatus: string | null }

export function ManualRow({ item }: { item: ManualItem }) {
  const [text, setText] = useState(item.message);
  const [copied, setCopied] = useState(false);
  const [p, start] = useTransition();
  return (
    <div className="grid gap-4 border-b p-4 lg:grid-cols-[220px_1fr_auto]">
      <div>
        <Link href={`/leads/${item.id}`} className="font-medium hover:text-primary">@{item.username}</Link>
        <div className="mt-0.5 text-xs text-muted-foreground">{item.founder ?? "Unknown founder"}{item.company ? ` · ${item.company}` : ""}</div>
        <div className="mt-2 flex items-center gap-2"><ScorePill score={item.score} incomplete={item.incomplete} />{item.manualStatus === "CONTACTED" && <Badge tone="primary">contacted</Badge>}</div>
      </div>
      <div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border bg-muted/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 ring-primary/50" />
        {item.missing.length > 0 && <div className="mt-1 text-[11px] text-warning">Fill in before sending: {item.missing.join(", ")} (edit the lead or this text)</div>}
        <div className="mt-1 text-[11px] text-muted-foreground">{text.length} chars · You send this yourself on X. Be honest about who you are and why you’re writing.</div>
      </div>
      <div className="flex flex-wrap items-start gap-2 lg:w-64 lg:justify-end">
        <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</Button>
        <a className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-muted px-2.5 text-xs font-medium hover:bg-accent" href={`https://x.com/${item.username}`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open profile</a>
        <Button size="sm" variant="success" disabled={p} onClick={() => start(() => manualContacted(item.id, item.campaignId, text))}><Check className="h-3.5 w-3.5" />Mark contacted</Button>
        <Button size="sm" disabled={p} onClick={() => start(() => manualStatus(item.id, "REPLIED"))}><MessageSquareReply className="h-3.5 w-3.5" />Replied</Button>
        <Button size="sm" variant="ghost" disabled={p} onClick={() => start(() => manualStatus(item.id, "SKIPPED"))}><SkipForward className="h-3.5 w-3.5" />Skip</Button>
      </div>
    </div>
  );
}
