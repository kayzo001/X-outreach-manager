import { MockProvider } from "./mock";
import { XProvider } from "./x";
import type { AccountCtx, DmProvider, SendOutcome } from "./types";

export * from "./types";

const g = globalThis as unknown as { __mock?: MockProvider; __x?: XProvider };
export const mockProvider = (g.__mock ??= new MockProvider());

/**
 * Wraps a provider so sendDm can NEVER reach the network: used for dry-run mode.
 * Reads (resolve/list/find) still pass through so a dry run exercises real eligibility logic.
 */
export class DryRunProvider implements DmProvider {
  readonly name: string;
  constructor(private inner: DmProvider) { this.name = `dry-run(${inner.name})`; }
  resolveUsers = (a: AccountCtx, u: string[]) => this.inner.resolveUsers(a, u);
  listDmEvents = (a: AccountCtx, o?: { maxPages?: number; pageSize?: number; isKnown?: (eventId: string) => boolean }) => this.inner.listDmEvents(a, o);
  listConversationWith = (a: AccountCtx, id: string) => this.inner.listConversationWith(a, id);
  findSentDm = (a: AccountCtx, q: Parameters<DmProvider["findSentDm"]>[1]) => this.inner.findSentDm(a, q);
  async sendDm(): Promise<SendOutcome> { throw new Error("DRY_RUN: sendDm must not be called"); }
}

export const DEMO_X_USER_ID = "900000001";

/** Accounts that completed real OAuth (callback sets lastVerifiedAt) — anything else is the demo/test account. */
export const isRealOAuthAccount = (a: { lastVerifiedAt: Date | null; xUserId: string }) => !!a.lastVerifiedAt && a.xUserId !== DEMO_X_USER_ID;

/**
 * Provider for a specific account. Real OAuth accounts ALWAYS use the official X API (so "Sync DMs" reads your real
 * inbox regardless of X_PROVIDER); demo/test accounts use X_PROVIDER (mock by default).
 * Sending is still gated by dry-run mode in the engine — this only chooses which API a live call would hit.
 */
export function providerFor(a: { lastVerifiedAt: Date | null; xUserId: string }): DmProvider {
  return isRealOAuthAccount(a) ? (g.__x ??= new XProvider()) : getProvider();
}

/** Default provider for non-OAuth (demo/test) accounts. */
export function getProvider(): DmProvider {
  if (process.env.X_PROVIDER === "x") return (g.__x ??= new XProvider());
  return mockProvider;
}
