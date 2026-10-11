import { Prisma } from "@prisma/client";
import { prisma, Tx } from "./db";
import { sha256 } from "./crypto";
import { logActivity } from "./activity";
import { getSettings } from "./settings";
import { Blocker, checkAutomatedEligibility } from "./eligibility";
import { renderTemplate, bodyHash } from "./template";
import { Schedule, computeNextSendAt, dayBounds, gateSend, scheduleSchema } from "./schedule";
import { providerFor, DmProvider, SendOutcome, AccountCtx } from "./provider";
import { notify } from "./notify";

const STALE_SENDING_MS = 2 * 60_000;       // SENDING longer than this ⇒ worker died mid-send ⇒ UNCERTAIN
const RECONCILE_GRACE_MS = 60 * 60_000;    // keep looking this long before declaring "not delivered"
const ACCOUNT_15MIN_CAP = 12;              // stay under X's documented 15 / 15 min per-user DM limit
const ACCOUNT_DAILY_CAP = 1000;            // stay under 1,440 / 24h

export const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
const idemKey = (campaignId: string, contactId: string, accountId: string) => sha256(`${campaignId}:${contactId}:${accountId}`);
const ctxOf = (a: { id: string; xUserId: string; username: string }): AccountCtx => ({ id: a.id, xUserId: a.xUserId, username: a.username });

export const scheduleOf = (c: { schedule: unknown }): Schedule => scheduleSchema.parse(c.schedule);

// ───────────────────────── Planning ─────────────────────────
export interface PlanResult { created: number; blocked: Partial<Record<Blocker | "INCOMPLETE_PERSONALIZATION", number>>; transientBlocked: number; needsHuman: number }
const TRANSIENT: Blocker[] = ["HISTORY_STALE", "HISTORY_UNKNOWN", "UNRESOLVED", "ACCOUNT_INACTIVE", "KILL_SWITCH", "ALREADY_QUEUED", "UNCERTAIN_PENDING"];
/** Blockers the owner can fix (record consent, fill data) — the campaign must stay open for them. */
const HUMAN_FIXABLE: Blocker[] = ["NO_CONSENT", "CONSENT_EXPIRED"];

/** Turns eligible campaign contacts into jobs. Idempotent: the unique idempotencyKey + partial unique index make a double call harmless. */
export async function planCampaign(campaignId: string, limit = 500): Promise<PlanResult> {
  const result: PlanResult = { created: 0, blocked: {}, transientBlocked: 0, needsHuman: 0 };
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true } });
  if (!camp || !camp.xAccountId) return result;
  const settings = await getSettings();
  const templateBody = camp.templateBody ?? camp.template?.body ?? "";
  const members = await prisma.campaignContact.findMany({
    where: { campaignId, skipped: false, contact: { jobs: { none: { campaignId } } } },
    include: { contact: true }, take: limit, orderBy: { addedAt: "asc" },
  });
  for (const m of members) {
    const elig = await checkAutomatedEligibility(prisma, { contactId: m.contactId, xAccountId: camp.xAccountId, settings });
    if (!elig.ok) {
      for (const b of elig.blockers) result.blocked[b] = (result.blocked[b] ?? 0) + 1;
      if (elig.blockers.every((b) => TRANSIENT.includes(b))) result.transientBlocked++;
      else if (elig.blockers.every((b) => TRANSIENT.includes(b) || HUMAN_FIXABLE.includes(b))) result.needsHuman++;
      continue;
    }
    const text = m.customMessage?.trim() ? { text: m.customMessage.trim(), complete: true } : renderTemplate(templateBody, m.contact);
    if (!text.complete && settings.requireTemplateComplete) { result.blocked.INCOMPLETE_PERSONALIZATION = (result.blocked.INCOMPLETE_PERSONALIZATION ?? 0) + 1; result.needsHuman++; continue; }
    if (!text.text.trim()) { result.blocked.INCOMPLETE_PERSONALIZATION = (result.blocked.INCOMPLETE_PERSONALIZATION ?? 0) + 1; result.needsHuman++; continue; }
    try {
      const job = await prisma.messageJob.create({
        data: {
          campaignId, contactId: m.contactId, xAccountId: camp.xAccountId, consentRecordId: elig.consentRecordId,
          body: text.text, bodyHash: bodyHash(text.text), idempotencyKey: idemKey(campaignId, m.contactId, camp.xAccountId),
          status: camp.requireApproval ? "PENDING_APPROVAL" : "QUEUED",
        },
      });
      result.created++;
      await logActivity({ type: "job.queued", message: camp.requireApproval ? "Message drafted — awaiting approval" : "Message queued", contactId: m.contactId, campaignId, jobId: job.id, xAccountId: camp.xAccountId, consentRecordId: elig.consentRecordId });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") continue; // duplicate job — exactly what the constraint is for
      throw e;
    }
  }
  return result;
}

// ───────────────────────── Claim (atomic) ─────────────────────────
export type ClaimResult = { claimed: true; jobId: string; dryRun: boolean } | { claimed: false; reason: string; terminal?: boolean };

/**
 * Everything that decides "may we send one message now?" runs inside ONE transaction guarded by a
 * per-campaign advisory lock, so two workers can never both pass the gate for the same campaign.
 */
export async function claimNextJob(campaignId: string, workerId: string, now = new Date()): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"campaign:" + campaignId}))`;
    const settings = await getSettings(tx);
    if (settings.killSwitch) return { claimed: false, reason: "Global emergency stop is on" } as ClaimResult;
    const camp = await tx.campaign.findUnique({ where: { id: campaignId }, include: { xAccount: true } });
    if (!camp || camp.status !== "ACTIVE") return { claimed: false, reason: "Campaign not active" };
    if (!camp.xAccount || camp.xAccount.status !== "ACTIVE") return { claimed: false, reason: "Sending account not connected" };
    if (camp.xAccount.rateLimitedUntil && camp.xAccount.rateLimitedUntil > now) return { claimed: false, reason: "Account is rate limited by X" };

    const sched = scheduleOf(camp);
    const { dayStart, hourAgo } = dayBounds(sched, now);
    const counted = ["SENDING", "SENT", "UNCERTAIN", "DRY_RUN"] as const;
    const [sentLastHour, sentToday, sentTotal, acct15, acctDay] = await Promise.all([
      tx.messageJob.count({ where: { campaignId, status: { in: [...counted] }, claimedAt: { gte: hourAgo } } }),
      tx.messageJob.count({ where: { campaignId, status: { in: [...counted] }, claimedAt: { gte: dayStart } } }),
      tx.messageJob.count({ where: { campaignId, status: { in: [...counted] } } }),
      tx.messageJob.count({ where: { xAccountId: camp.xAccountId!, status: { in: ["SENDING", "SENT", "UNCERTAIN"] }, claimedAt: { gte: new Date(now.getTime() - 15 * 60_000) } } }),
      tx.messageJob.count({ where: { xAccountId: camp.xAccountId!, status: { in: ["SENDING", "SENT", "UNCERTAIN"] }, claimedAt: { gte: new Date(now.getTime() - 86_400_000) } } }),
    ]);
    if (acct15 >= ACCOUNT_15MIN_CAP || acctDay >= ACCOUNT_DAILY_CAP) return { claimed: false, reason: "Account-level API safety cap reached" };

    const gate = gateSend(sched, now, { sentLastHour, sentToday, sentTotal }, camp.nextSendAt);
    if (!gate.ok) return { claimed: false, reason: gate.reason, terminal: gate.terminal };

    // Candidate jobs; SKIP LOCKED means a concurrent worker passes over anything we hold.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM message_jobs
      WHERE "campaignId" = ${campaignId} AND status = 'QUEUED' AND ("notBefore" IS NULL OR "notBefore" <= ${now})
      ORDER BY "createdAt" LIMIT 20 FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return { claimed: false, reason: "No queued jobs" };

    for (const { id } of rows) {
      const job = await tx.messageJob.findUniqueOrThrow({ where: { id } });
      // Serialise per-contact decisions too (covers the same person in two campaigns).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"contact:" + job.contactId}))`;
      const elig = await checkAutomatedEligibility(tx, { contactId: job.contactId, xAccountId: job.xAccountId, ignoreJobId: job.id, now, settings });
      if (!elig.ok) {
        await tx.messageJob.update({ where: { id }, data: { status: "SKIPPED", errorCategory: elig.blockers[0], lastError: elig.blockers.join(", ") } });
        await logActivity({ type: "job.skipped", level: "warn", message: `Skipped at send time: ${elig.blockers.join(", ")}`, contactId: job.contactId, campaignId, jobId: id, errorCategory: elig.blockers[0] }, tx);
        continue;
      }
      const dry = settings.dryRun;
      if (!dry) {
        // Permanent first-contact ledger: insert-or-revive-VOID. Zero rows ⇒ someone already owns this pair.
        const got = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO outreach_ledger (id, "xAccountId", "contactId", state, "jobId", "campaignId", "updatedAt")
          VALUES (${"led_" + id}, ${job.xAccountId}, ${job.contactId}, 'RESERVED', ${id}, ${campaignId}, now())
          ON CONFLICT ("xAccountId", "contactId") DO UPDATE
            SET state = 'RESERVED', "jobId" = EXCLUDED."jobId", "campaignId" = EXCLUDED."campaignId", "updatedAt" = now()
            WHERE outreach_ledger.state = 'VOID'
          RETURNING id`;
        if (!got.length) {
          await tx.messageJob.update({ where: { id }, data: { status: "SKIPPED", errorCategory: "ALREADY_MESSAGED", lastError: "Ledger already holds this sender/recipient pair" } });
          await logActivity({ type: "job.skipped", level: "warn", message: "Duplicate contact skipped (ledger)", contactId: job.contactId, campaignId, jobId: id, errorCategory: "ALREADY_MESSAGED" }, tx);
          continue;
        }
      }
      await tx.messageJob.update({ where: { id }, data: { status: dry ? "DRY_RUN" : "SENDING", claimedBy: workerId, claimedAt: now, attempts: { increment: 1 }, dryRun: dry } });
      const next = computeNextSendAt(sched, now, camp.batchSentCount);
      await tx.campaign.update({ where: { id: campaignId }, data: { nextSendAt: next.nextSendAt, batchSentCount: next.batchSentCount } });
      await logActivity({ type: dry ? "job.dry_run" : "job.claimed", message: dry ? "DRY RUN — message would be sent (nothing transmitted)" : "Eligibility checked — sending", contactId: job.contactId, campaignId, jobId: id, xAccountId: job.xAccountId, consentRecordId: elig.consentRecordId, meta: dry ? { preview: job.body.slice(0, 120) } : undefined }, tx);
      return { claimed: true, jobId: id, dryRun: dry } as ClaimResult;
    }
    return { claimed: false, reason: "All candidates were skipped" };
  }, { timeout: 20_000 });
}

// ───────────────────────── Execute ─────────────────────────
export async function executeClaimedJob(jobId: string, provider?: DmProvider): Promise<string> {
  const job = await prisma.messageJob.findUniqueOrThrow({ where: { id: jobId }, include: { contact: true, xAccount: true, campaign: true } });
  if (job.status !== "SENDING") return `not-sending:${job.status}`;

  // "Stop immediately": re-read stop conditions right before the network call.
  const settings = await getSettings();
  const camp = await prisma.campaign.findUnique({ where: { id: job.campaignId } });
  if (settings.killSwitch || camp?.status !== "ACTIVE") {
    await revertToQueued(jobId, settings.killSwitch ? "Emergency stop" : "Campaign paused");
    return "reverted";
  }

  let outcome: SendOutcome;
  try {
    outcome = await (provider ?? providerFor(job.xAccount)).sendDm(ctxOf(job.xAccount), { toXUserId: job.contact.xUserId!, text: job.body, idempotencyKey: job.idempotencyKey });
  } catch (e) {
    // Any exception after we *might* have transmitted ⇒ uncertain. Never retry blindly.
    outcome = { kind: "uncertain", reason: (e as Error).message };
  }
  await applyOutcome(jobId, outcome);
  return outcome.kind;
}

async function revertToQueued(jobId: string, why: string) {
  await prisma.$transaction(async (tx) => {
    const job = await tx.messageJob.update({ where: { id: jobId }, data: { status: "QUEUED", claimedAt: null, claimedBy: null } });
    await tx.outreachLedger.updateMany({ where: { jobId, state: "RESERVED" }, data: { state: "VOID" } });
    await logActivity({ type: "job.reverted", message: `Send aborted before transmission: ${why}`, contactId: job.contactId, campaignId: job.campaignId, jobId }, tx);
  });
}

export async function applyOutcome(jobId: string, o: SendOutcome) {
  const job = await prisma.messageJob.findUniqueOrThrow({ where: { id: jobId }, include: { campaign: true } });
  const sched = scheduleOf(job.campaign);
  const base = { contactId: job.contactId, campaignId: job.campaignId, jobId, xAccountId: job.xAccountId, retryCount: job.attempts, consentRecordId: job.consentRecordId };

  if (o.kind === "sent") return finalizeSent(jobId, o.eventId, o.conversationId, o.apiStatus);

  if (o.kind === "rate_limited") {
    await prisma.$transaction(async (tx) => {
      await tx.messageJob.update({ where: { id: jobId }, data: { status: "QUEUED", notBefore: o.resetAt, apiStatus: 429, errorCategory: "RATE_LIMITED", lastError: `Rate limited until ${o.resetAt.toISOString()}`, claimedAt: null, claimedBy: null } });
      await tx.outreachLedger.updateMany({ where: { jobId, state: "RESERVED" }, data: { state: "VOID" } });
      await tx.xAccount.update({ where: { id: job.xAccountId }, data: { rateLimitedUntil: o.resetAt } });
      await logActivity({ ...base, type: "job.rate_limited", level: "warn", message: `X rate limit hit — pausing sends until ${o.resetAt.toISOString()}`, apiStatus: 429, errorCategory: "RATE_LIMITED" }, tx);
    });
    return;
  }

  if (o.kind === "uncertain") {
    await prisma.$transaction(async (tx) => {
      await tx.messageJob.update({ where: { id: jobId }, data: { status: "UNCERTAIN", apiStatus: o.apiStatus ?? null, errorCategory: "UNCERTAIN_DELIVERY", lastError: o.reason, notBefore: new Date(Date.now() + 60_000) } });
      await tx.outreachLedger.updateMany({ where: { jobId }, data: { state: "UNCERTAIN" } });
      await logActivity({ ...base, type: "job.uncertain", level: "warn", message: `Delivery uncertain (${o.reason}) — will reconcile, not retry`, apiStatus: o.apiStatus, errorCategory: "UNCERTAIN_DELIVERY" }, tx);
    });
    await bumpErrors(job.campaignId, sched, "Uncertain delivery result");
    return;
  }

  // auth | permanent  ⇒ definitive: nothing was sent, never auto-retry.
  const category = o.kind === "auth" ? "AUTH" : o.category;
  const message = o.kind === "auth" ? o.message : o.message;
  await prisma.$transaction(async (tx) => {
    await tx.messageJob.update({ where: { id: jobId }, data: { status: "FAILED", apiStatus: o.apiStatus, errorCategory: category, lastError: message.slice(0, 500) } });
    await tx.outreachLedger.updateMany({ where: { jobId, state: "RESERVED" }, data: { state: "VOID" } });
    if (o.kind === "auth") await tx.xAccount.update({ where: { id: job.xAccountId }, data: { status: "REVOKED" } });
    if (o.kind === "permanent" && o.category === "RECIPIENT_NOT_FOUND") await tx.contact.update({ where: { id: job.contactId }, data: { resolveStatus: "NOT_FOUND" } });
    await logActivity({ ...base, type: "job.failed", level: "error", message: `Send failed permanently: ${category}`, apiStatus: o.apiStatus, errorCategory: category }, tx);
  });
  if (o.kind === "auth") {
    await prisma.campaign.updateMany({ where: { xAccountId: job.xAccountId, status: "ACTIVE" }, data: { status: "PAUSED", autoPaused: true, pauseReason: "X authorization failed — reconnect the account" } });
    await notify("account.auth_failed", "X account needs reconnecting", "Sends were stopped because X rejected the stored token.");
  } else {
    await bumpErrors(job.campaignId, sched, `Failed send: ${category}`);
  }
}

export async function finalizeSent(jobId: string, eventId: string, conversationId: string, apiStatus = 200, sentAt = new Date()) {
  await prisma.$transaction(async (tx) => {
    const job = await tx.messageJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status === "SENT") return; // idempotent
    await tx.messageJob.update({ where: { id: jobId }, data: { status: "SENT", sentAt, xEventId: eventId, apiStatus, errorCategory: null, lastError: null } });
    await tx.outreachLedger.updateMany({ where: { jobId }, data: { state: "SENT" } });
    const conv = await tx.conversation.upsert({
      where: { xAccountId_contactId: { xAccountId: job.xAccountId, contactId: job.contactId } },
      create: { xAccountId: job.xAccountId, contactId: job.contactId, xConversationId: conversationId, lastOutgoingAt: sentAt, lastPreview: job.body.slice(0, 140) },
      update: { xConversationId: conversationId, lastOutgoingAt: sentAt, lastPreview: job.body.slice(0, 140) },
    });
    await tx.message.upsert({
      where: { xEventId: eventId },
      create: { jobId, campaignId: job.campaignId, contactId: job.contactId, xAccountId: job.xAccountId, conversationId: conv.id, direction: "OUT", xEventId: eventId, text: job.body, sentAt, consentRecordId: job.consentRecordId },
      update: {},
    });
    await tx.contact.update({ where: { id: job.contactId }, data: { historyStatus: "CONTACTED" } });
    await tx.campaign.update({ where: { id: job.campaignId }, data: { consecutiveErrors: 0 } });
    await logActivity({ type: "job.sent", message: "Message delivered through API", contactId: job.contactId, campaignId: job.campaignId, jobId, xAccountId: job.xAccountId, apiStatus, retryCount: job.attempts, consentRecordId: job.consentRecordId, meta: { eventId } }, tx);
  });
}

async function bumpErrors(campaignId: string, sched: Schedule, reason: string) {
  const c = await prisma.campaign.update({ where: { id: campaignId }, data: { consecutiveErrors: { increment: 1 } } });
  if (sched.autoPauseOnErrors && c.consecutiveErrors >= sched.maxConsecutiveErrors && c.status === "ACTIVE") {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED", autoPaused: true, pauseReason: `Auto-paused after ${c.consecutiveErrors} consecutive errors (${reason})` } });
    await logActivity({ type: "campaign.auto_paused", level: "error", message: `Campaign auto-paused after ${c.consecutiveErrors} consecutive errors`, campaignId });
    await notify("campaign.auto_paused", "Campaign auto-paused", `${c.name} stopped after ${c.consecutiveErrors} consecutive errors. Review the activity log.`);
  }
}

// ───────────────────────── Dry run & dry-run provider guard ─────────────────────────
export async function completeDryRun(jobId: string) {
  const job = await prisma.messageJob.findUniqueOrThrow({ where: { id: jobId } });
  await logActivity({ type: "job.dry_run_done", message: "Dry run complete — no message was transmitted", contactId: job.contactId, campaignId: job.campaignId, jobId });
}

// ───────────────────────── Recovery & reconciliation ─────────────────────────
/** Any job stuck in SENDING (worker crashed mid-send) becomes UNCERTAIN — never re-sent blindly. */
export async function recoverStaleSending(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS);
  const stale = await prisma.messageJob.findMany({ where: { status: "SENDING", claimedAt: { lt: cutoff } } });
  for (const j of stale) {
    const r = await prisma.messageJob.updateMany({ where: { id: j.id, status: "SENDING" }, data: { status: "UNCERTAIN", errorCategory: "WORKER_CRASH", lastError: "Worker stopped during send; delivery unconfirmed", notBefore: now } });
    if (r.count) {
      await prisma.outreachLedger.updateMany({ where: { jobId: j.id }, data: { state: "UNCERTAIN" } });
      await logActivity({ type: "job.recovered", level: "warn", message: "Stale SENDING job moved to UNCERTAIN for reconciliation", contactId: j.contactId, campaignId: j.campaignId, jobId: j.id, errorCategory: "WORKER_CRASH" });
    }
  }
  return stale.length;
}

export async function reconcileUncertain(provider?: DmProvider, now = new Date()) {
  const jobs = await prisma.messageJob.findMany({ where: { status: "UNCERTAIN", OR: [{ notBefore: null }, { notBefore: { lte: now } }] }, include: { contact: true, xAccount: true }, take: 25 });
  let resolved = 0;
  for (const j of jobs) {
    if (!j.contact.xUserId || j.xAccount.status !== "ACTIVE") continue;
    const since = new Date((j.claimedAt ?? j.createdAt).getTime() - 2 * 60_000);
    const found = await (provider ?? providerFor(j.xAccount)).findSentDm(ctxOf(j.xAccount), { toXUserId: j.contact.xUserId, text: j.body, since });
    if (found === null) { // lookup failed ⇒ stay uncertain, back off
      await prisma.messageJob.update({ where: { id: j.id }, data: { attempts: { increment: 1 }, notBefore: new Date(now.getTime() + backoffMs(j.attempts)) } });
      await logActivity({ type: "job.reconcile_failed", level: "warn", message: "Reconciliation lookup failed — will retry with backoff", contactId: j.contactId, campaignId: j.campaignId, jobId: j.id, retryCount: j.attempts });
      continue;
    }
    if (found.found) {
      await finalizeSent(j.id, found.eventId!, found.conversationId!, 200);
      await logActivity({ type: "job.reconciled", message: "Reconciled: message WAS delivered", contactId: j.contactId, campaignId: j.campaignId, jobId: j.id });
      resolved++;
    } else if (now.getTime() - (j.claimedAt ?? j.createdAt).getTime() >= RECONCILE_GRACE_MS && j.attempts >= 2) {
      await prisma.$transaction(async (tx) => {
        await tx.messageJob.update({ where: { id: j.id }, data: { status: "FAILED", errorCategory: "NOT_DELIVERED_CONFIRMED", lastError: "Reconciliation found no matching DM after grace period" } });
        await tx.outreachLedger.updateMany({ where: { jobId: j.id }, data: { state: "VOID" } });
        await logActivity({ type: "job.reconciled", level: "warn", message: "Reconciled: no DM found after grace period — marked not delivered (manual re-queue allowed)", contactId: j.contactId, campaignId: j.campaignId, jobId: j.id }, tx);
      });
      resolved++;
    } else {
      await prisma.messageJob.update({ where: { id: j.id }, data: { attempts: { increment: 1 }, notBefore: new Date(now.getTime() + 2 * 60_000) } });
    }
  }
  return resolved;
}

// ───────────────────────── Tick ─────────────────────────
export interface TickSummary { campaigns: number; sent: number; dryRun: number; skipped: Record<string, number> }

export async function runSchedulerTick(workerId: string, now = new Date(), provider?: DmProvider): Promise<TickSummary> {
  const summary: TickSummary = { campaigns: 0, sent: 0, dryRun: 0, skipped: {} };
  const settings = await getSettings();
  if (settings.killSwitch) { summary.skipped["kill-switch"] = 1; return summary; }
  await recoverStaleSending(now);
  const campaigns = await prisma.campaign.findMany({ where: { status: "ACTIVE", autoPaused: false } });
  for (const c of campaigns) {
    summary.campaigns++;
    const plan = await planCampaign(c.id);
    const claim = await claimNextJob(c.id, workerId, now);
    if (claim.claimed) {
      if (claim.dryRun) { await completeDryRun(claim.jobId); summary.dryRun++; }
      else { const r = await executeClaimedJob(claim.jobId, provider); if (r === "sent") summary.sent++; }
      continue;
    }
    summary.skipped[claim.reason] = (summary.skipped[claim.reason] ?? 0) + 1;
    if (claim.terminal) await completeCampaign(c.id, claim.reason);
    else if (claim.reason === "No queued jobs" && plan.created === 0 && plan.transientBlocked === 0 && plan.needsHuman === 0) {
      const live = await prisma.messageJob.count({ where: { campaignId: c.id, status: { in: ["PENDING_APPROVAL", "QUEUED", "SENDING", "UNCERTAIN"] } } });
      if (!live) await completeCampaign(c.id, "All eligible contacts processed");
    }
  }
  return summary;
}

async function completeCampaign(id: string, why: string) {
  const r = await prisma.campaign.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "COMPLETED" } });
  if (r.count) {
    await logActivity({ type: "campaign.completed", message: `Campaign completed: ${why}`, campaignId: id });
    await notify("campaign.completed", "Campaign completed", why);
  }
}

// ───────────────────────── Campaign controls ─────────────────────────
export async function setCampaignStatus(id: string, action: "start" | "pause" | "resume" | "stop" | "archive" | "complete") {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
  const map = { start: "ACTIVE", resume: "ACTIVE", pause: "PAUSED", stop: "PAUSED", archive: "ARCHIVED", complete: "COMPLETED" } as const;
  if ((action === "start" || action === "resume") && c.status === "ARCHIVED") throw new Error("Archived campaigns cannot be started");
  if ((action === "start" || action === "resume") && !c.xAccountId) throw new Error("Select a sending account first");
  await prisma.campaign.update({
    where: { id },
    data: { status: map[action], autoPaused: false, pauseReason: action === "pause" || action === "stop" ? "Paused by user" : null, consecutiveErrors: action === "start" || action === "resume" ? 0 : undefined, startedAt: action === "start" && !c.startedAt ? new Date() : undefined },
  });
  if (action === "stop" || action === "complete") {
    // Stop immediately: pull everything not yet transmitted out of the queue.
    await prisma.messageJob.updateMany({ where: { campaignId: id, status: "QUEUED" }, data: { status: "CANCELLED", errorCategory: "STOPPED", lastError: "Campaign stopped by user" } });
  }
  await logActivity({ type: `campaign.${action}`, message: `Campaign ${action === "start" ? "started" : action === "stop" ? "stopped" : action === "complete" ? "marked complete" : action + "d"}`, campaignId: id });
}

export { Prisma };
export type { Tx };
