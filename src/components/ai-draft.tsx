"use client";
import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Button, Input, Select, Textarea } from "./ui";
import { aiDraft, setCustomMessage } from "@/app/actions";

export function AiDraft({ contactId, campaigns }: { contactId: string; campaigns: { id: string; name: string }[] }) {
  const [sender, setSender] = useState(""); const [offer, setOffer] = useState("short-form video content for SaaS founders"); const [text, setText] = useState(""); const [camp, setCamp] = useState(campaigns[0]?.id ?? "");
  const [msg, setMsg] = useState<string | null>(null); const [p, start] = useTransition();
  return (
    <div className="space-y-2 p-5">
      <Input className="h-8" placeholder="Who is sending? e.g. Sam from Acme Content" value={sender} onChange={(e) => setSender(e.target.value)} />
      <Input className="h-8" placeholder="What are you offering?" value={offer} onChange={(e) => setOffer(e.target.value)} />
      <Button size="sm" disabled={p || !sender} onClick={() => start(async () => { try { setMsg(null); setText(await aiDraft(contactId, sender, offer)); } catch (e) { setMsg((e as Error).message); } })}><Sparkles className="h-3.5 w-3.5" />{p ? "Drafting…" : "Draft with Claude"}</Button>
      {text && <>
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="text-[11px] text-warning">AI draft — read it, check every claim against what you actually know, then edit. Nothing is sent from here.</p>
        {campaigns.length > 0 && <div className="flex gap-2"><Select className="h-8" value={camp} onChange={(e) => setCamp(e.target.value)}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select><Button size="sm" disabled={p} onClick={() => start(async () => { await setCustomMessage(camp, contactId, text); setMsg("Saved as this lead’s message (still needs approval before sending)."); })}>Use as message</Button></div>}
      </>}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
