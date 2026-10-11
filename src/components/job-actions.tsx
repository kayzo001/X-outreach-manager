"use client";
import { useState, useTransition } from "react";
import { Button, Textarea } from "./ui";
import { approveJobs, editJobBody, rejectJobs, retryFailedJob } from "@/app/actions";

export function ApprovalBar({ ids }: { ids: string[] }) {
  const [p, start] = useTransition();
  if (!ids.length) return null;
  return <div className="flex gap-2"><Button variant="success" size="sm" disabled={p} onClick={() => confirm(`Approve all ${ids.length} messages on this page?`) && start(() => approveJobs(ids))}>Approve all ({ids.length})</Button><Button variant="danger" size="sm" disabled={p} onClick={() => confirm(`Reject ${ids.length} messages?`) && start(() => rejectJobs(ids))}>Reject all</Button></div>;
}

export function JobRowActions({ id, status, body }: { id: string; status: string; body: string }) {
  const [edit, setEdit] = useState(false); const [text, setText] = useState(body); const [p, start] = useTransition();
  if (status === "PENDING_APPROVAL") return (
    <div className="space-y-2">
      {edit && <><Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /><div className="flex gap-2"><Button size="sm" variant="primary" disabled={p} onClick={() => start(async () => { await editJobBody(id, text); setEdit(false); })}>Save</Button><Button size="sm" onClick={() => { setEdit(false); setText(body); }}>Cancel</Button></div></>}
      {!edit && <div className="flex gap-1.5"><Button size="sm" variant="success" disabled={p} onClick={() => start(() => approveJobs([id]))}>Approve</Button><Button size="sm" onClick={() => setEdit(true)}>Edit</Button><Button size="sm" variant="danger" disabled={p} onClick={() => start(() => rejectJobs([id]))}>Reject</Button></div>}
    </div>);
  if (status === "QUEUED") return <Button size="sm" variant="danger" disabled={p} onClick={() => start(() => rejectJobs([id]))}>Cancel</Button>;
  if (status === "FAILED") return <Button size="sm" disabled={p} onClick={() => start(async () => { try { await retryFailedJob(id); } catch (e) { alert((e as Error).message); } })}>Re-queue for approval</Button>;
  return null;
}
