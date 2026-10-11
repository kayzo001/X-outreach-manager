"use client";
import { useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert, Button, Card, CardHeader, Input, Label, Select, Textarea } from "./ui";
import { saveCampaign } from "@/app/actions";
import { renderTemplate, TEMPLATE_VARS, MAX_DM_LENGTH, findNearDuplicates } from "@/lib/template";
import type { Schedule } from "@/lib/schedule";

type Sample = { id: string; usernameDisplay: string; founderName: string | null; company: string | null; product: string | null; industry: string | null; customHook: string | null };
type Campaign = { id?: string; name?: string; description?: string | null; audience?: string | null; xAccountId?: string | null; templateId?: string | null; templateBody?: string | null; requireApproval?: boolean };
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]] as const;
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC"];

export function CampaignForm({ campaign, schedule, accounts, templates, samples }: {
  campaign?: Campaign; schedule: Schedule; accounts: { id: string; username: string }[]; templates: { id: string; name: string; body: string }[]; samples: Sample[];
}) {
  const [body, setBody] = useState(campaign?.templateBody ?? templates.find((t) => t.id === campaign?.templateId)?.body ?? "Hey {{first_name}}, came across {{company}} and wanted to reach out.");
  const [s, setS] = useState(schedule);
  const ta = useRef<HTMLTextAreaElement>(null);
  const previews = useMemo(() => samples.map((c) => ({ c, r: renderTemplate(body, c) })), [body, samples]);
  const dups = useMemo(() => findNearDuplicates(previews.map((p) => ({ id: p.c.id, text: p.r.text })), 0.97), [previews]);
  const insert = (v: string) => { const el = ta.current; const tag = `{{${v}}}`; if (!el) return setBody(body + tag); const a = el.selectionStart, b = el.selectionEnd; setBody(body.slice(0, a) + tag + body.slice(b)); setTimeout(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); }); };
  const num = (k: keyof Schedule) => ({ name: String(k), type: "number" as const, defaultValue: (s[k] as number | null) ?? "", min: 0 });

  return (
    <form action={saveCampaign} className="space-y-5">
      <input type="hidden" name="id" value={campaign?.id ?? ""} />
      <Card><CardHeader title="Campaign" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div><Label>Name *</Label><Input name="name" required defaultValue={campaign?.name} placeholder="SaaS Founders October" /></div>
          <div><Label>Sending account</Label><Select name="xAccountId" defaultValue={campaign?.xAccountId ?? ""}><option value="">Manual outreach only (none)</option>{accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}</Select></div>
          <div className="sm:col-span-2"><Label>Description</Label><Input name="description" defaultValue={campaign?.description ?? ""} /></div>
          <div className="sm:col-span-2"><Label>Target audience</Label><Input name="audience" defaultValue={campaign?.audience ?? ""} placeholder="Founder-led SaaS, $5k+ MRR, active on X" /></div>
        </div></Card>

      <Card><CardHeader title="Message template" desc="Variables are only filled from data you’ve stored. Missing data is flagged, never invented." />
        <div className="grid gap-5 p-5 lg:grid-cols-2">
          <div>
            <Label>Saved template</Label>
            <Select name="templateId" defaultValue={campaign?.templateId ?? ""} onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) setBody(t.body); }}><option value="">— none (use text below) —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
            <Label className="mt-3">Message</Label>
            <Textarea ref={ta} name="templateBody" rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={MAX_DM_LENGTH} />
            <div className="mt-2 flex flex-wrap gap-1.5">{TEMPLATE_VARS.map((v) => <button type="button" key={v} onClick={() => insert(v)} className="rounded-md border bg-muted px-2 py-0.5 font-mono text-[11px] hover:border-primary">{`{{${v}}}`}</button>)}</div>
            <p className="mt-2 text-xs text-muted-foreground">{body.length.toLocaleString()} characters · X allows up to {MAX_DM_LENGTH.toLocaleString()} per DM. Keep it human, honest and clearly from you; include a simple way to opt out.</p>
          </div>
          <div className="space-y-3">
            <Label>Live preview (sample leads)</Label>
            {previews.length === 0 && <p className="text-xs text-muted-foreground">Add leads to the campaign to preview real messages.</p>}
            {previews.map(({ c, r }) => (
              <div key={c.id} className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>@{c.usernameDisplay}</span><span>{r.length} chars</span></div>
                <div className="whitespace-pre-wrap">{r.text}</div>
                {r.missing.length > 0 && <div className="mt-2 flex items-center gap-1.5 text-[11px] text-warning"><AlertTriangle className="h-3 w-3" />Missing data: {r.missing.join(", ")} — this lead won’t be queued.</div>}
                {r.unknown.length > 0 && <div className="mt-1 text-[11px] text-destructive">Unknown variable: {r.unknown.join(", ")}</div>}
              </div>
            ))}
            {dups.length > 0 && <Alert tone="warning" title="Near-identical messages">Some previews are almost word-for-word identical. X treats mass identical DMs as spam — add genuine, verified personalization.</Alert>}
          </div>
        </div>
        <div className="border-t px-5 py-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireApproval" defaultChecked={campaign?.requireApproval ?? true} />Require my approval of every message before it can send <span className="text-xs text-muted-foreground">(recommended)</span></label></div>
      </Card>

      <Card><CardHeader title="Schedule & batch controls" desc="Workload management only. Timing is deterministic — no randomisation, and limits are enforced on top of X’s own API rate limits." />
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div><Label>Timezone</Label><Select name="timezone" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>{[...new Set([s.timezone, ...ZONES])].map((z) => <option key={z}>{z}</option>)}</Select></div>
          <div><Label>Start date</Label><Input name="startDate" type="date" defaultValue={s.startDate ?? ""} /></div>
          <div><Label>End date</Label><Input name="endDate" type="date" defaultValue={s.endDate ?? ""} /></div>
          <div><Label>Window</Label><div className="flex items-center gap-2"><Input name="windowStart" type="time" defaultValue={s.windowStart} /><span className="text-muted-foreground">–</span><Input name="windowEnd" type="time" defaultValue={s.windowEnd} /></div></div>
          <div className="sm:col-span-2"><Label>Sending days</Label><div className="flex flex-wrap gap-1.5">{DAYS.map(([d, l]) => <label key={d} className="flex cursor-pointer items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1.5 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/15"><input type="checkbox" name="days" value={d} defaultChecked={s.days.includes(d)} className="hidden" />{l}</label>)}</div></div>
          <div className="space-y-1.5 pt-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" name="allowWeekends" defaultChecked={s.allowWeekends} />Allow weekends</label><label className="flex items-center gap-2"><input type="checkbox" name="excludeHolidays" defaultChecked={s.excludeHolidays} />Exclude holidays</label></div>
          <div><Label hint="YYYY-MM-DD, comma separated">Holidays</Label><Input name="holidays" defaultValue={s.holidays.join(", ")} placeholder="2026-11-26, 2026-12-25" /></div>
          <div><Label>Max / hour</Label><Input {...num("maxPerHour")} /></div>
          <div><Label>Max / day</Label><Input {...num("maxPerDay")} /></div>
          <div><Label hint="blank = unlimited">Max / campaign</Label><Input {...num("maxPerCampaign")} /></div>
          <div><Label>Batch size</Label><Input {...num("batchSize")} /></div>
          <div><Label hint="min between batches">Batch delay (min)</Label><Input {...num("batchDelayMinMinutes")} /></div>
          <div><Label hint="upper bound; must be ≥ min">Batch delay max</Label><Input {...num("batchDelayMaxMinutes")} /></div>
          <div><Label hint="minutes">Between messages</Label><Input {...num("messageDelayMinutes")} /></div>
          <div><Label>Max consecutive errors</Label><Input {...num("maxConsecutiveErrors")} /></div>
          <div className="space-y-1.5 text-sm sm:col-span-2"><label className="flex items-center gap-2"><input type="checkbox" name="autoPauseOnErrors" defaultChecked={s.autoPauseOnErrors} />Auto-pause when the error limit is reached</label><label className="flex items-center gap-2"><input type="checkbox" name="stopOnReply" defaultChecked={s.stopOnReply} />Stop messaging a recipient after they reply <span className="text-xs text-muted-foreground">(always enforced)</span></label></div>
        </div></Card>
      <div className="flex justify-end gap-2"><Button variant="primary" size="md">{campaign?.id ? "Save changes" : "Create campaign"}</Button></div>
    </form>
  );
}
