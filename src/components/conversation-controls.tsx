"use client";
import { useState, useTransition } from "react";
import { Button, Input, Select, Textarea } from "./ui";
import { updateConversation } from "@/app/actions";

const STATUSES = [["OPEN", "Open"], ["INTERESTED", "Interested"], ["POTENTIAL_CUSTOMER", "Potential customer"], ["CONVERTED", "Converted"], ["NOT_INTERESTED", "Not interested"], ["DO_NOT_CONTACT", "Do not contact"]];

export function ConversationControls({ id, status, tags, notes, unread }: { id: string; status: string; tags: string[]; notes: string; unread: boolean }) {
  const [n, setN] = useState(notes); const [tag, setTag] = useState(""); const [p, start] = useTransition();
  return (
    <div className="space-y-4">
      <div><div className="mb-1.5 text-xs font-medium text-muted-foreground">Status</div>
        <Select value={status} disabled={p} onChange={(e) => { const v = e.target.value; if (v === "DO_NOT_CONTACT" && !confirm("Mark do-not-contact? This permanently suppresses the contact.")) return; start(() => updateConversation(id, { status: v as never })); }}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
      <div><div className="mb-1.5 text-xs font-medium text-muted-foreground">Tags</div>
        <div className="mb-2 flex flex-wrap gap-1.5">{tags.map((t) => <button key={t} onClick={() => start(() => updateConversation(id, { tags: tags.filter((x) => x !== t) }))} className="rounded-full border bg-muted px-2 py-0.5 text-[11px] hover:border-destructive">{t} ×</button>)}</div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const t = tag.trim().toLowerCase(); if (t && !tags.includes(t)) start(() => updateConversation(id, { tags: [...tags, t] })); setTag(""); }}><Input className="h-8" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add tag" /><Button size="sm">Add</Button></form></div>
      <div><div className="mb-1.5 text-xs font-medium text-muted-foreground">Private notes</div><Textarea rows={4} value={n} onChange={(e) => setN(e.target.value)} onBlur={() => n !== notes && start(() => updateConversation(id, { notes: n }))} placeholder="Only you can see this" /></div>
      <Button size="sm" variant="ghost" disabled={p} onClick={() => start(() => updateConversation(id, { unread: !unread }))}>Mark as {unread ? "read" : "unread"}</Button>
    </div>
  );
}
