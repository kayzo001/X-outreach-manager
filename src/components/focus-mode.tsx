"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, SkipForward, ThumbsDown, ArrowRight, Coffee, ShieldCheck, AlertTriangle } from "lucide-react";
import { Badge, Button, Card, ScorePill } from "./ui";
import { focusMarkContacted, focusNext, focusSkip } from "@/app/actions";
import type { FocusLead, ManualStats } from "@/lib/manual-outreach";
import { cn } from "@/lib/utils";

type Next = { lead: FocusLead | null; stats: ManualStats };

export function FocusMode({ initial, campaignId, campaigns }: { initial: Next; campaignId: string | null; campaigns: { id: string; name: string }[] }) {
  const [cur, setCur] = useState<Next>(initial);
  const [text, setText] = useState(initial.lead?.draft ?? "");
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [onBreak, setOnBreak] = useState(false);
  const [pending, start] = useTransition();
  const seen = useRef<string[]>(initial.lead ? [initial.lead.id] : []);
  const prefetched = useRef<Promise<Next> | null>(null);
  const lead = cur.lead, st = cur.stats;

  // Prefetch the following lead while you work on this one, so "next" is instant on big lists.
  const prefetch = useCallback(() => { prefetched.current = focusNext(campaignId, seen.current); }, [campaignId]);
  useEffect(() => { if (lead) prefetch(); }, [lead, prefetch]);

  const advance = useCallback(async (after: () => Promise<unknown>, contacted: boolean) => {
    start(async () => {
      const r = (await after()) as { warning?: string | null } | undefined;
      let nxt = prefetched.current ? await prefetched.current : await focusNext(campaignId, seen.current);
      if (nxt.lead && seen.current.includes(nxt.lead.id)) nxt = await focusNext(campaignId, seen.current);
      // stats moved on: refresh counts from server-truth result of the prefetch + this action
      const stats = { ...nxt.stats, today: contacted ? Math.max(nxt.stats.today, st.today + 1) : nxt.stats.today };
      if (nxt.lead) seen.current.push(nxt.lead.id);
      setCur({ lead: nxt.lead, stats }); setText(nxt.lead?.draft ?? ""); setCopied(false); setOpened(false);
      setNote(r?.warning ?? null);
      if (contacted && stats.batchSize && stats.today % stats.batchSize === 0) setOnBreak(true);
    });
  }, [campaignId, st.today]);

  const copy = useCallback(async () => { await navigator.clipboard.writeText(text); setCopied(true); }, [text]);
  const open = useCallback(() => { if (lead) { window.open(`https://x.com/${lead.username}`, "_blank", "noopener"); setOpened(true); } }, [lead]);
  const contacted = useCallback(() => lead && advance(() => focusMarkContacted(lead.id, lead.campaignId, text), true), [lead, text, advance]);
  const skip = useCallback(() => lead && advance(() => focusSkip(lead.id, "skip"), false), [lead, advance]);
  const notFit = useCallback(() => lead && advance(() => focusSkip(lead.id, "not_fit"), false), [lead, advance]);
  const later = useCallback(() => lead && advance(async () => undefined, false), [lead, advance]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || pending || onBreak || !lead) return;
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); copy(); } else if (k === "o") { e.preventDefault(); open(); }
      else if (k === "m") { e.preventDefault(); contacted(); } else if (k === "s") { e.preventDefault(); skip(); }
      else if (k === "n") { e.preventDefault(); later(); } else if (k === "x") { e.preventDefault(); notFit(); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [copy, open, contacted, skip, later, notFit, pending, onBreak, lead]);

  const pct = Math.min(100, Math.round((st.today / Math.max(1, st.target)) * 100));
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-48 flex-1">
            <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">Today</span><span className="font-medium tabular-nums">{st.today} / {st.target}{st.today >= st.target && " 🎉"}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full transition-all", st.today >= st.target ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
          </div>
          <div className="text-xs text-muted-foreground">Batch <b className="text-foreground">{st.batchSize ? st.today % st.batchSize : 0}/{st.batchSize}</b></div>
          <div className="text-xs text-muted-foreground"><b className="text-foreground">{st.remaining.toLocaleString()}</b> leads left</div>
          <Badge tone={st.inHours ? "success" : "warning"}>{st.inHours ? "in working hours" : `outside hours (${st.hoursLabel})`}</Badge>
          <select className="h-8 rounded-md border bg-muted/60 px-2 text-xs" value={campaignId ?? ""} onChange={(e) => { window.location.href = `/queue/manual/focus${e.target.value ? `?campaign=${e.target.value}` : ""}`; }}>
            <option value="">All campaigns</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </Card>

      {onBreak ? (
        <Card className="p-10 text-center">
          <Coffee className="mx-auto h-9 w-9 text-primary" />
          <h2 className="mt-3 text-lg font-semibold">Batch of {st.batchSize} done</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Good moment to check the Inbox for replies before the next batch. {st.today}/{st.target} today.</p>
          <div className="mt-5 flex justify-center gap-2"><Button variant="primary" onClick={() => setOnBreak(false)}>Start next batch</Button><Link className="inline-flex h-9 items-center rounded-md border bg-muted px-3.5 text-sm hover:bg-accent" href="/inbox">Open Inbox</Link></div>
        </Card>
      ) : !lead ? (
        <Card className="p-10 text-center"><Check className="mx-auto h-9 w-9 text-success" /><h2 className="mt-3 text-lg font-semibold">No more leads to contact{campaignId ? " in this campaign" : ""}</h2><p className="mt-1 text-sm text-muted-foreground">Import more CSVs, or check the Inbox for replies.</p></Card>
      ) : (
        <div className={cn("grid gap-4 lg:grid-cols-[1fr_1.4fr]", pending && "pointer-events-none opacity-60")}>
          <Card className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <a href={`https://x.com/${lead.username}`} target="_blank" rel="noreferrer" className="text-xl font-semibold hover:text-primary">@{lead.username}</a>
                <div className="mt-0.5 text-sm text-muted-foreground">{lead.founder ?? "Unknown founder"}{lead.company ? ` · ${lead.company}` : ""}</div>
              </div>
              <ScorePill score={lead.score} incomplete={lead.scoreIncomplete} />
            </div>
            <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-xs">
              {lead.product && <><dt className="text-muted-foreground">Product</dt><dd>{lead.product}</dd></>}
              {lead.industry && <><dt className="text-muted-foreground">Category</dt><dd>{lead.industry}</dd></>}
              {lead.mrr != null && <><dt className="text-muted-foreground">MRR</dt><dd>${lead.mrr.toLocaleString()} <span className="text-muted-foreground">({lead.mrrKind === "VERIFIED" ? "verified" : "self-reported"})</span></dd></>}
              {lead.followers != null && <><dt className="text-muted-foreground">Followers</dt><dd>{lead.followers.toLocaleString()}</dd></>}
              {lead.website && <><dt className="text-muted-foreground">Website</dt><dd><a className="text-primary hover:underline" href={lead.website.startsWith("http") ? lead.website : `https://${lead.website}`} target="_blank" rel="noreferrer">{lead.website.replace(/^https?:\/\//, "")}</a></dd></>}
              {lead.campaignName && <><dt className="text-muted-foreground">Campaign</dt><dd>{lead.campaignName}</dd></>}
            </dl>
            {lead.bio && <p className="mt-3 rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">{lead.bio}</p>}
            <div className="mt-4 space-y-1 text-xs">
              <div className="flex items-center gap-1.5 text-success"><ShieldCheck className="h-3.5 w-3.5" />Checked against your whole database: not contacted, not opted out, no conversation, no queued message.</div>
              {lead.checks.warnings.map((w) => <div key={w} className="flex items-start gap-1.5 text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</div>)}
            </div>
            <div className="mt-3"><Link className="text-xs text-primary hover:underline" href={`/leads/${lead.id}`} target="_blank">Full lead record ↗</Link></div>
          </Card>

          <Card className="flex flex-col p-5">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>Draft · {lead.draftSource}</span><span>{text.length} chars</span></div>
            <textarea value={text} onChange={(e) => { setText(e.target.value); setCopied(false); }} rows={7} className="w-full flex-1 rounded-md border bg-muted/50 p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 ring-primary/50" />
            <p className="mt-1.5 text-[11px] text-muted-foreground">Built only from data on file. Edit freely — what you mark as sent is recorded in the permanent history.</p>
            {note && <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{note}</div>}
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 [&_button]:whitespace-nowrap">
              <Button variant={copied ? "success" : "secondary"} onClick={copy}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy"} <kbd className="ml-1 text-[10px] opacity-60">C</kbd></Button>
              <Button variant={opened ? "success" : "secondary"} onClick={open}><ExternalLink className="h-4 w-4" />Open profile <kbd className="ml-1 text-[10px] opacity-60">O</kbd></Button>
              <Button variant="primary" onClick={contacted} disabled={pending}><Check className="h-4 w-4" />Contacted <kbd className="ml-1 text-[10px] opacity-70">M</kbd></Button>
              <Button variant="ghost" onClick={later} disabled={pending}><ArrowRight className="h-4 w-4" />Later <kbd className="ml-1 text-[10px] opacity-60">N</kbd></Button>
              <Button variant="ghost" onClick={skip} disabled={pending}><SkipForward className="h-4 w-4" />Skip <kbd className="ml-1 text-[10px] opacity-60">S</kbd></Button>
              <Button variant="danger" onClick={notFit} disabled={pending}><ThumbsDown className="h-4 w-4" />Not a fit <kbd className="ml-1 text-[10px] opacity-60">X</kbd></Button>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">Flow: <b>C</b> copy → <b>O</b> open profile → send the DM on X yourself → <b>M</b> mark contacted. <b>N</b> later keeps this lead for another session; <b>S</b> skip removes it; <b>X</b> marks it not a fit.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
