"use client";
import { useRef, useState, useTransition } from "react";
import { Check, Copy, KeyRound, ShieldCheck, Trash2, FlaskConical } from "lucide-react";
import { Badge, Button, Input, Label } from "./ui";
import { deleteXCredentialsAction, saveXCredentialsAction, testXConfigurationAction } from "@/app/actions";
import type { XCredentialSummary } from "@/lib/x-config";
import { cn } from "@/lib/utils";

export type IntegrationStatus = { label: "Not configured" | "Configured" | "Connected" | "Connection error"; detail: string };
const tone = { "Not configured": "neutral", Configured: "primary", Connected: "success", "Connection error": "danger" } as const;

export function XCredentialsPanel({ summary, status }: { summary: XCredentialSummary; status: IntegrationStatus }) {
  const form = useRef<HTMLFormElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean | null; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const inDb = summary.source === "database";
  const run = (fn: () => Promise<{ ok: boolean | null; message: string }>, reset = false) =>
    start(async () => { const r = await fn(); setMsg(r); if (reset && r.ok) form.current?.reset(); });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/15 text-primary"><KeyRound className="h-5 w-5" /></div>
        <div className="flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">X Developer Credentials <Badge tone={tone[status.label]}>{status.label}</Badge></div>
          <div className="text-xs text-muted-foreground">{status.detail}</div>
        </div>
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs sm:grid-cols-[140px_1fr]">
        <dt className="text-muted-foreground">Source</dt>
        <dd>{summary.source === "database" ? "Saved in Settings (encrypted in the database)" : summary.source === "environment" ? ".env fallback — saving here takes priority" : "—"}</dd>
        <dt className="text-muted-foreground">Client ID</dt><dd className="font-mono">{summary.clientIdMasked ?? "—"}</dd>
        <dt className="text-muted-foreground">Client Secret</dt><dd>{summary.hasSecret ? "•••••••• saved (never shown again)" : summary.configured ? "none — public client" : "—"}</dd>
        <dt className="text-muted-foreground">Callback URL</dt>
        <dd className="flex items-center gap-2"><code className="break-all">{summary.redirectUri}</code>
          <button type="button" className="text-muted-foreground hover:text-foreground" title="Copy" onClick={async () => { await navigator.clipboard.writeText(summary.redirectUri); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}</button></dd>
        {summary.lastTestedAt && <><dt className="text-muted-foreground">Last test</dt><dd className={cn(summary.lastTestOk === false && "text-destructive", summary.lastTestOk === true && "text-success")}>{new Date(summary.lastTestedAt).toLocaleString()} — {summary.lastTestMessage}</dd></>}
      </dl>

      {!summary.keyConfigured && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">CREDENTIALS_ENCRYPTION_KEY is not set on the server, so credentials can’t be stored securely. Ask your host to set it (openssl rand -hex 32) and restart.</div>}
      {summary.error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{summary.error}</div>}

      <form ref={form} className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); run(() => saveXCredentialsAction(fd), true); }}>
        <div>
          <Label hint="Keys and tokens → OAuth 2.0">Client ID</Label>
          <Input name="clientId" autoComplete="off" spellCheck={false} required={!inDb} placeholder={inDb ? `${summary.clientIdMasked} — leave blank to keep` : "Paste your OAuth 2.0 Client ID"} />
        </div>
        <div>
          <Label hint="stored encrypted">Client Secret</Label>
          <Input name="clientSecret" type="password" autoComplete="new-password" spellCheck={false} placeholder={summary.hasSecret && inDb ? "•••••••• saved — leave blank to keep" : "Paste your OAuth 2.0 Client Secret"} />
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button variant="primary" disabled={pending || !summary.keyConfigured}><ShieldCheck className="h-4 w-4" />{inDb ? "Update Credentials" : "Save Credentials"}</Button>
          <Button type="button" disabled={pending || !summary.configured} onClick={() => run(testXConfigurationAction)}><FlaskConical className="h-4 w-4" />Test Configuration</Button>
          {inDb && <Button type="button" variant="danger" disabled={pending} onClick={() => confirm("Delete the saved X credentials? Connected accounts will need to reconnect.") && run(deleteXCredentialsAction)}><Trash2 className="h-4 w-4" />Delete Credentials</Button>}
        </div>
      </form>
      {pending && <p className="text-xs text-muted-foreground">Working…</p>}
      {msg && !pending && <div className={cn("rounded-md border px-3 py-2 text-xs", msg.ok === true ? "border-success/30 bg-success/10 text-success" : msg.ok === false ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-warning/30 bg-warning/10 text-warning")}>{msg.message}</div>}
      <p className="text-[11px] text-muted-foreground">Changing or deleting credentials disconnects OAuth-connected accounts until you reconnect. Saving never turns on live sending or resumes campaigns.</p>
    </div>
  );
}
