import { createHash } from "crypto";
import type { AccountCtx, DmEvent, DmProvider, ResolvedUser, SendOutcome } from "./types";

/** Deterministic fake X. Lets tests (and demos) inject failures without touching the network. */
export class MockProvider implements DmProvider {
  readonly name = "mock";
  sent: { toXUserId: string; text: string; eventId: string; conversationId: string; at: Date; accountId: string }[] = [];
  inbound: DmEvent[] = [];
  missingUsers = new Set<string>();
  suspendedUsers = new Set<string>();
  /** Queue of forced outcomes consumed one per sendDm call. */
  forced: Array<SendOutcome | { kind: "delivered_but_timeout" } | { kind: "throw" }> = [];
  sendCalls = 0;
  now: () => Date = () => new Date();
  lookupFails = false;
  private seq = 0;

  reset() {
    this.sent = []; this.inbound = []; this.missingUsers.clear(); this.suspendedUsers.clear();
    this.forced = []; this.sendCalls = 0; this.lookupFails = false; this.seq = 0;
  }

  idFor(username: string) { return String(parseInt(createHash("md5").update(username).digest("hex").slice(0, 10), 16)); }

  async resolveUsers(_a: AccountCtx, usernames: string[]): Promise<ResolvedUser[]> {
    return usernames.map((u) => {
      if (this.missingUsers.has(u)) return { username: u, status: "not_found" as const };
      if (this.suspendedUsers.has(u)) return { username: u, status: "suspended" as const };
      return { username: u, status: "ok" as const, id: this.idFor(u), currentUsername: u };
    });
  }

  async sendDm(a: AccountCtx, req: { toXUserId: string; text: string; idempotencyKey: string }): Promise<SendOutcome> {
    this.sendCalls++;
    const forced = this.forced.shift();
    const record = () => {
      const eventId = `evt_${++this.seq}`;
      const conversationId = `${[a.xUserId, req.toXUserId].sort().join("-")}`;
      this.sent.push({ toXUserId: req.toXUserId, text: req.text, eventId, conversationId, at: this.now(), accountId: a.id });
      return { eventId, conversationId };
    };
    if (forced?.kind === "throw") throw new Error("ECONNRESET");
    if (forced?.kind === "delivered_but_timeout") { record(); return { kind: "uncertain", reason: "timeout after request was sent" }; }
    if (forced) return forced as SendOutcome;
    const r = record();
    return { kind: "sent", ...r, apiStatus: 201 };
  }

  async listDmEvents(a: AccountCtx) {
    const out: DmEvent[] = this.sent.filter((s) => s.accountId === a.id).map((s) => ({
      id: s.eventId, conversationId: s.conversationId, senderId: a.xUserId, text: s.text, createdAt: s.at, participantIds: [a.xUserId, s.toXUserId],
    }));
    return { events: [...out, ...this.inbound], truncated: false };
  }

  async listConversationWith(a: AccountCtx, other: string): Promise<DmEvent[] | null> {
    if (this.lookupFails) return null;
    const r = await this.listDmEvents(a);
    return r.events.filter((e) => e.participantIds?.includes(other) || e.senderId === other).slice(-10);
  }

  async findSentDm(a: AccountCtx, q: { toXUserId: string; text: string; since: Date }) {
    if (this.lookupFails) return null;
    const hit = this.sent.find((s) => s.accountId === a.id && s.toXUserId === q.toXUserId && s.text === q.text && s.at >= q.since);
    return hit ? { found: true, eventId: hit.eventId, conversationId: hit.conversationId } : { found: false };
  }
}
