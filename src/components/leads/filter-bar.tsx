"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Search, Trash2, X } from "lucide-react";
import { Button, Card, Input, Select } from "@/components/ui";
import { FILTER_FIELDS } from "@/lib/filters";
import { deleteFilter, saveFilter } from "@/app/actions";

type Cond = { field: string; operator: string; value?: unknown };
type Def = { op: "AND" | "OR"; conditions: Cond[]; q?: string };
const OPS: Record<string, [string, string][]> = {
  text: [["contains", "contains"], ["equals", "is"], ["not_contains", "doesn’t contain"], ["empty", "is empty"]],
  number: [["gt", ">"], ["lt", "<"], ["eq", "="]],
  enum: [["is", "is"], ["is_not", "is not"]], bool: [["is", "is"]], campaign: [["is", "is"]],
};

export function FilterBar({ initial, presets, campaigns }: { initial: Def; presets: { id: string; name: string; definition: Def }[]; campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [def, setDef] = useState<Def>(initial);
  const [, start] = useTransition();
  const apply = (d: Def) => router.push(`/leads?f=${encodeURIComponent(JSON.stringify(d))}`);
  const set = (i: number, patch: Partial<Cond>) => setDef({ ...def, conditions: def.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search username, company, founder…" value={def.q ?? ""} onChange={(e) => setDef({ ...def, q: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply(def)} /></div>
        <Select className="w-44" value="" onChange={(e) => { const p = presets.find((x) => x.id === e.target.value); if (p) { setDef(p.definition); apply(p.definition); } }}>
          <option value="">Saved filters…</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Button onClick={() => setDef({ ...def, conditions: [...def.conditions, { field: "company", operator: "contains", value: "" }] })}><Plus className="h-4 w-4" />Filter</Button>
        <Button variant="primary" onClick={() => apply(def)}>Apply</Button>
        {(def.conditions.length > 0 || def.q) && <Button variant="ghost" onClick={() => { const d: Def = { op: "AND", conditions: [] }; setDef(d); apply(d); }}>Clear</Button>}
      </div>
      {def.conditions.length > 0 && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">Match
            <Select className="h-8 w-20" value={def.op} onChange={(e) => setDef({ ...def, op: e.target.value as "AND" | "OR" })}><option value="AND">ALL</option><option value="OR">ANY</option></Select> of these conditions</div>
          {def.conditions.map((c, i) => {
            const f = FILTER_FIELDS.find((x) => x.field === c.field) ?? FILTER_FIELDS[0];
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select className="h-8 w-48" value={c.field} onChange={(e) => { const nf = FILTER_FIELDS.find((x) => x.field === e.target.value)!; set(i, { field: nf.field, operator: OPS[nf.type][0][0], value: nf.type === "bool" ? true : "" }); }}>
                  {FILTER_FIELDS.map((x) => <option key={x.field} value={x.field}>{x.label}</option>)}</Select>
                <Select className="h-8 w-36" value={c.operator} onChange={(e) => set(i, { operator: e.target.value })}>{OPS[f.type].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                {f.type === "bool" ? <Select className="h-8 w-28" value={String(c.value ?? true)} onChange={(e) => set(i, { value: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></Select>
                  : f.type === "enum" ? <Select className="h-8 w-48" value={String(c.value ?? "")} onChange={(e) => set(i, { value: e.target.value })}><option value="">Select…</option>{f.options!.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ").toLowerCase()}</option>)}</Select>
                  : f.type === "campaign" ? <Select className="h-8 w-48" value={String(c.value ?? "")} onChange={(e) => set(i, { value: e.target.value })}><option value="">Select…</option>{campaigns.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
                  : c.operator === "empty" ? null : <Input className="h-8 w-48" type={f.type === "number" ? "number" : "text"} value={String(c.value ?? "")} onChange={(e) => set(i, { value: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply(def)} />}
                <button className="text-muted-foreground hover:text-destructive" onClick={() => setDef({ ...def, conditions: def.conditions.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></button>
              </div>
            );
          })}
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={() => { const name = prompt("Name this filter"); if (name) start(() => saveFilter(name, JSON.stringify(def))); }}><Save className="h-3.5 w-3.5" />Save as preset</Button>
            {presets.length > 0 && <Button size="sm" variant="ghost" onClick={() => { const name = prompt(`Delete which preset? (${presets.map((p) => p.name).join(", ")})`); const p = presets.find((x) => x.name === name); if (p) start(() => deleteFilter(p.id)); }}><Trash2 className="h-3.5 w-3.5" />Delete preset</Button>}
          </div>
        </div>
      )}
    </Card>
  );
}
