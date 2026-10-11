"use client";
import { useState, useTransition } from "react";
import { Archive, Copy, Download, Pause, Play, Square } from "lucide-react";
import { Button, LinkButton } from "./ui";
import { campaignAction, duplicateCampaign } from "@/app/actions";

export function CampaignControls({ id, status }: { id: string; status: string }) {
  const [p, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const run = (a: "start" | "pause" | "resume" | "stop" | "archive" | "complete") => start(async () => { try { setNote(await campaignAction(id, a)); } catch (e) { setNote((e as Error).message); } });
  return (
    <>
      {(status === "DRAFT") && <Button variant="primary" disabled={p} onClick={() => run("start")}><Play className="h-4 w-4" />Start</Button>}
      {status === "PAUSED" && <Button variant="primary" disabled={p} onClick={() => run("resume")}><Play className="h-4 w-4" />Resume</Button>}
      {status === "ACTIVE" && <Button disabled={p} onClick={() => run("pause")}><Pause className="h-4 w-4" />Pause</Button>}
      {(status === "ACTIVE" || status === "PAUSED") && <Button variant="danger" disabled={p} onClick={() => confirm("Stop now and cancel every queued message?") && run("stop")}><Square className="h-4 w-4" />Stop</Button>}
      {status === "ACTIVE" && <Button variant="ghost" disabled={p} onClick={() => confirm("Mark complete? Remaining queued messages will be cancelled.") && run("complete")}>Mark complete</Button>}
      <LinkButton href={`/campaigns/${id}/edit`}>Edit</LinkButton>
      <Button disabled={p} onClick={() => start(() => duplicateCampaign(id))}><Copy className="h-4 w-4" />Duplicate</Button>
      <a className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-muted px-3.5 text-sm hover:bg-accent" href={`/api/export/campaign?id=${id}`}><Download className="h-4 w-4" />Export</a>
      {status !== "ARCHIVED" && <Button variant="ghost" disabled={p} onClick={() => confirm("Archive this campaign?") && run("archive")}><Archive className="h-4 w-4" /></Button>}
      {note && <div className="basis-full rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">{note}</div>}
    </>
  );
}
