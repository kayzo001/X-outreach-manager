export interface AccountCtx { id: string; xUserId: string; username: string }

export interface ResolvedUser {
  username: string; // normalised input
  status: "ok" | "not_found" | "suspended" | "error";
  id?: string; name?: string; verified?: boolean; followers?: number; description?: string; location?: string; currentUsername?: string;
}

export type SendOutcome =
  | { kind: "sent"; eventId: string; conversationId: string; apiStatus: number }
  | { kind: "rate_limited"; resetAt: Date; apiStatus: 429 }
  | { kind: "auth"; apiStatus: number; message: string }                       // 401: token revoked/expired — never auto-retried
  | { kind: "permanent"; apiStatus: number; category: string; message: string } // 400/403/404: recipient can't be messaged
  | { kind: "uncertain"; reason: string; apiStatus?: number };                 // timeout / 5xx / network — message may or may not exist

export interface DmEvent {
  id: string; conversationId: string; senderId: string; text: string; createdAt: Date; participantIds?: string[];
}

export interface DmProvider {
  readonly name: string;
  resolveUsers(account: AccountCtx, usernames: string[]): Promise<ResolvedUser[]>;
  sendDm(account: AccountCtx, req: { toXUserId: string; text: string; idempotencyKey: string }): Promise<SendOutcome>;
  /** Pages of recent DM events (X only exposes ~30 days). */
  /** Newest-first. Stops paginating at the first page containing an already-known event (X bills per event read). */
  listDmEvents(account: AccountCtx, opts?: { maxPages?: number; pageSize?: number; isKnown?: (eventId: string) => boolean }): Promise<{ events: DmEvent[]; truncated: boolean } | { error: "rate_limited"; resetAt: Date } | { error: "auth" }>;
  /** One 1:1 thread, newest ≤10 events (cheap, targeted history check). null = lookup failed. */
  listConversationWith(account: AccountCtx, otherXUserId: string): Promise<DmEvent[] | null>;
  /** Reconciliation: did a DM with this text reach this user since `since`? null = lookup itself failed. */
  findSentDm(account: AccountCtx, q: { toXUserId: string; text: string; since: Date }): Promise<{ found: boolean; eventId?: string; conversationId?: string } | null>;
}
