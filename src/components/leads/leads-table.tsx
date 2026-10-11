"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge, Button, Select, StatusBadge, Table, Td, Th, ScorePill, Empty } from "@/components/ui";
import { addContactsToCampaign, addFilteredToCampaign } from "@/app/actions";
import { profileUrl } from "@/lib/username";

export interface LeadRow {
  id: string; username: string; founder: string | null; company: string | null; industry: string | null; mrr: number | null; mrrKind: string;
  consent: string; history: string; customer: string; dnc: boolean; replied: boolean; score: number | null; incomplete: boolean; tags: string[]; campaigns: number;
}
const historyLabel: Record<string, string> = { UNKNOWN: "history unknown", NONE_FOUND: "no DM in last 30d", CONTACTED: "contacted" };

export function LeadsTable({ rows, total, campaigns, filterJson }: { rows: LeadRow[]; total: number; campaigns: { id: string; name: string }[]; filterJson: string }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [camp, setCamp] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const all = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Select className="h-8 w-56" value={camp} onChange={(e) => setCamp(e.target.value)}><option value="">Add to campaign…</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Button size="sm" disabled={!camp || !sel.size || pending} onClick={() => start(async () => { const n = await addContactsToCampaign(camp, [...sel]); setMsg(`Added ${n} selected lead(s).`); setSel(new Set()); })}>Add {sel.size || ""} selected</Button>
        <Button size="sm" disabled={!camp || pending || !total} onClick={() => { if (confirm(`Add all ${total} leads matching the current filter?`)) start(async () => { const n = await addFilteredToCampaign(camp, filterJson); setMsg(`Added ${n} lead(s) matching the filter.`); }); }}>Add all {total} filtered</Button>
        {msg && <span className="text-xs text-success">{msg}</span>}
        <a className="ml-auto text-xs text-primary hover:underline" href={`/api/export/leads?filter=${encodeURIComponent(filterJson)}`}>Export CSV</a>
      </div>
      <Table>
        <thead><tr><Th><input type="checkbox" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} /></Th><Th>Lead</Th><Th>Company</Th><Th>Score</Th><Th>Revenue</Th><Th>Consent</Th><Th>History</Th><Th>Status</Th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-muted/40">
              <Td><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></Td>
              <Td><Link href={`/leads/${r.id}`} className="font-medium hover:text-primary">@{r.username}</Link><div className="text-xs text-muted-foreground">{r.founder ?? "—"} · <a className="hover:underline" target="_blank" rel="noreferrer" href={profileUrl(r.username)}>profile ↗</a></div></Td>
              <Td>{r.company ?? "—"}<div className="text-xs text-muted-foreground">{r.industry ?? ""}</div></Td>
              <Td><ScorePill score={r.score} incomplete={r.incomplete} /></Td>
              <Td>{r.mrr != null ? <>${r.mrr.toLocaleString()}<div className="text-[11px] text-muted-foreground">{r.mrrKind === "VERIFIED" ? "verified" : "self-reported"}</div></> : <span className="text-muted-foreground">—</span>}</Td>
              <Td><StatusBadge s={r.consent} /></Td>
              <Td><Badge tone={r.history === "CONTACTED" ? "primary" : "neutral"}>{historyLabel[r.history]}</Badge></Td>
              <Td className="space-x-1">{r.dnc && <Badge tone="danger">DNC</Badge>}{r.replied && <Badge tone="success">replied</Badge>}{r.customer !== "NONE" && <StatusBadge s={r.customer} />}{r.tags.map((t) => <Badge key={t}>{t}</Badge>)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {!rows.length && <Empty title="No leads match" desc="Import a CSV or relax your filters." />}
    </>
  );
}
