"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileSpreadsheet, Loader2, UploadCloud } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, LinkButton, Select, StatCard, Table, Td, Th } from "./ui";
import { cn } from "@/lib/utils";

const FIELDS: [string, string][] = [
  ["username", "Username *"], ["founder_name", "Founder name"], ["company", "Company"], ["website", "Website"], ["product", "Product"], ["mrr", "MRR (self-reported)"],
  ["industry", "Industry / category"], ["location", "Location"], ["country", "Country"], ["language", "Language"], ["followers", "Followers"], ["bio", "Bio"],
  ["message", "Custom message"], ["notes", "Notes"], ["campaign", "Campaign (name)"], ["source_url", "Source URL"], ["consent_status", "Consent status (reference only)"], ["custom_hook", "Custom hook"], ["verified", "Verified"],
];
type Counts = { total: number; valid: number; newRows: number; existing: number; dupInFile: number; invalid: number };

export function ImportWizard({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [staged, setStaged] = useState<{ importId: string; headers: string[]; totalRows: number; sample: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Counts | null>(null);
  const [sample, setSample] = useState<{ rowNumber: number; status: string; reason: string | null; usernameNormalized: string | null }[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [result, setResult] = useState<{ created: number; linked: number; backfilled: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function call(url: string, init?: RequestInit) {
    const r = await fetch(url, init); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  }
  async function upload(file: File) {
    setErr(null); setBusy(`Uploading and staging ${file.name}…`);
    try {
      const fd = new FormData(); fd.append("file", file);
      const j = await call("/api/imports", { method: "POST", body: fd });
      setStaged(j); setMapping(j.mapping); setStep("map");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function preview() {
    if (!staged) return; setErr(null); setBusy("Validating every row…");
    try {
      const clean = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));
      const j = await call(`/api/imports/${staged.importId}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mapping: clean }) });
      setCounts(j.counts); setSample(j.sample); setStep("preview");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function commit() {
    if (!staged) return; setErr(null); setBusy("Saving contacts — safe to wait, nothing is overwritten…");
    try {
      setResult(await call(`/api/imports/${staged.importId}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ campaignId }) }));
      setStep("done"); router.refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  const steps = ["Upload", "Map columns", "Preview", "Done"];
  const idx = ["upload", "map", "preview", "done"].indexOf(step);
  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {steps.map((s, i) => <li key={s} className={cn("flex items-center gap-2 rounded-full border px-3 py-1", i === idx ? "border-primary/40 bg-primary/10 text-primary" : i < idx ? "text-success" : "text-muted-foreground")}>{i < idx ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span>{i + 1}</span>}{s}</li>)}
      </ol>
      {err && <Alert tone="danger" title="Import problem">{err}</Alert>}
      {busy && <Alert tone="primary"><span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{busy}</span></Alert>}

      {step === "upload" && (
        <Card>
          <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
            onClick={() => input.current?.click()}
            className={cn("m-5 flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-16 text-center transition", drag ? "border-primary bg-primary/10" : "hover:border-primary/50 hover:bg-muted/40")}>
            <UploadCloud className="h-9 w-9 text-primary" />
            <div className="text-sm font-medium">Drop a CSV or XLSX file here, or click to browse</div>
            <div className="max-w-md text-xs text-muted-foreground">First column should be <code className="rounded bg-muted px-1">username</code>. @handles and x.com profile URLs both work. Up to 25 MB — 10,000+ rows are fine. Importing never implies consent and never overwrites existing history.</div>
            <input ref={input} type="file" hidden accept=".csv,.txt,.xlsx" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </div>
        </Card>
      )}

      {step === "map" && staged && (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" />Map columns</span>} desc={`${staged.totalRows.toLocaleString()} rows detected. Headers were matched automatically — adjust anything that's off.`}
            right={<Button variant="primary" onClick={preview} disabled={!!busy || !mapping.username}>Validate & preview →</Button>} />
          <div className="grid gap-x-6 gap-y-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map(([f, label]) => (
              <div key={f}><div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
                <Select value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}><option value="">— skip —</option>{staged.headers.map((h) => <option key={h} value={h}>{h}</option>)}</Select></div>
            ))}
          </div>
          <div className="border-t p-5"><div className="mb-2 text-xs font-medium text-muted-foreground">First rows of your file</div>
            <Table><thead><tr>{staged.headers.map((h) => <Th key={h}>{h}</Th>)}</tr></thead><tbody>{staged.sample.map((r, i) => <tr key={i}>{staged.headers.map((h) => <Td key={h} className="max-w-[200px] truncate">{r[h]}</Td>)}</tr>)}</tbody></Table></div>
        </Card>
      )}

      {step === "preview" && counts && staged && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Total rows" value={counts.total.toLocaleString()} />
            <StatCard label="Valid" value={counts.valid.toLocaleString()} tone="success" />
            <StatCard label="New contacts" value={counts.newRows.toLocaleString()} tone="primary" />
            <StatCard label="Already in database" value={counts.existing.toLocaleString()} sub="history preserved" />
            <StatCard label="Rejected" value={(counts.invalid + counts.dupInFile).toLocaleString()} tone={counts.invalid + counts.dupInFile ? "warning" : undefined} sub={`${counts.dupInFile} duplicates · ${counts.invalid} invalid`} />
          </div>
          <Card>
            <CardHeader title="Preview" desc="Nothing has been saved yet." right={counts.invalid + counts.dupInFile > 0 ? <a href={`/api/imports/${staged.importId}/rejected`} className="text-xs text-primary hover:underline">Download rejected rows (CSV)</a> : null} />
            <Table><thead><tr><Th>Row</Th><Th>Username</Th><Th>Result</Th><Th>Detail</Th></tr></thead>
              <tbody>{sample.map((r) => <tr key={r.rowNumber}><Td>{r.rowNumber}</Td><Td>{r.usernameNormalized ? `@${r.usernameNormalized}` : "—"}</Td><Td><Badge tone={r.status === "NEW" ? "success" : r.status === "EXISTING" ? "primary" : "danger"}>{r.status.replace("_", " ").toLowerCase()}</Badge></Td><Td className="text-xs text-muted-foreground">{r.reason}</Td></tr>)}</tbody></Table>
            <div className="flex flex-wrap items-end justify-between gap-4 border-t p-5">
              <div className="min-w-64"><div className="mb-1 text-xs font-medium text-muted-foreground">Add these contacts to a campaign (optional)</div>
                <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}><option value="">Don’t add to a campaign</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
              <div className="flex gap-2"><Button onClick={() => setStep("map")}>← Back</Button><Button variant="primary" disabled={!!busy || counts.valid === 0} onClick={commit}>Import {counts.valid.toLocaleString()} contacts</Button></div>
            </div>
          </Card>
        </>
      )}

      {step === "done" && result && (
        <Card className="p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
          <h2 className="mt-3 text-lg font-semibold">Import complete</h2>
          <p className="mt-1 text-sm text-muted-foreground">{result.created.toLocaleString()} new contacts · {result.linked.toLocaleString()} campaign links · {result.backfilled.toLocaleString()} existing contacts had blank fields filled</p>
          <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">Consent for all imported contacts is “unknown”, so they appear in the manual outreach queue until you record a documented opt-in.</p>
          <div className="mt-5 flex justify-center gap-2"><LinkButton href="/leads" variant="primary">View leads</LinkButton><LinkButton href="/queue/manual">Manual queue</LinkButton><Button onClick={() => { setStep("upload"); setStaged(null); setCounts(null); }}>Import another</Button></div>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">Past imports are listed on the <Link className="text-primary hover:underline" href="/import#history">history</Link> below.</p>
    </div>
  );
}
