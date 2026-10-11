import { prisma } from "../db";
import { decrypt, encrypt } from "../crypto";
import type { AccountCtx, DmEvent, DmProvider, ResolvedUser, SendOutcome } from "./types";

const API = "https://api.x.com/2";
import { X_TOKEN_URL as TOKEN_URL } from "../oauth";
import { getXOAuthConfig } from "../x-config";
export { X_SCOPES } from "../oauth";

/** Returns a valid access token, refreshing if within 60s of expiry. Never logs tokens. */
async function accessToken(accountId: string): Promise<string | null> {
  const acc = await prisma.xAccount.findUnique({ where: { id: accountId } });
  if (!acc || acc.status !== "ACTIVE") return null;
  const fresh = acc.tokenExpiresAt && acc.tokenExpiresAt.getTime() - Date.now() > 60_000;
  if (fresh) return decrypt(acc.accessTokenEnc);
  if (!acc.refreshTokenEnc) {
    if (!acc.tokenExpiresAt || acc.tokenExpiresAt > new Date()) return decrypt(acc.accessTokenEnc);
    await prisma.xAccount.update({ where: { id: acc.id }, data: { status: "EXPIRED" } });
    return null;
  }
  const cfg = await getXOAuthConfig(); // same DB-backed config the web app uses
  if (cfg.source === "none" || cfg.error || (acc.oauthClientId && acc.oauthClientId !== cfg.clientId)) {
    // Refresh tokens are bound to the X app that issued them — never try them against another app's credentials.
    await prisma.xAccount.update({ where: { id: acc.id }, data: { status: "EXPIRED", lastError: cfg.error ?? "X developer credentials changed or were removed — click Reconnect" } });
    return null;
  }
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cfg.confidential) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST", headers, signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(acc.refreshTokenEnc), client_id: cfg.clientId }),
  });
  if (!res.ok) {
    // 400/401 on refresh = token revoked or expired for good → stop automation for this account.
    if (res.status === 400 || res.status === 401) await prisma.xAccount.update({ where: { id: acc.id }, data: { status: "REVOKED", lastError: `Token refresh rejected by X (${res.status}) — reconnect` } });
    return null;
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  await prisma.xAccount.update({
    where: { id: acc.id },
    data: {
      accessTokenEnc: encrypt(j.access_token),
      refreshTokenEnc: j.refresh_token ? encrypt(j.refresh_token) : acc.refreshTokenEnc,
      tokenExpiresAt: new Date(Date.now() + j.expires_in * 1000), lastVerifiedAt: new Date(), lastError: null,
    },
  });
  return j.access_token;
}

async function call(accountId: string, path: string, init: RequestInit = {}) {
  const token = await accessToken(accountId);
  if (!token) return { authFailed: true as const };
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  return { res };
}

const resetOf = (res: Response) => {
  const r = Number(res.headers.get("x-rate-limit-reset"));
  return new Date(r > 0 ? r * 1000 : Date.now() + 15 * 60_000);
};

export class XProvider implements DmProvider {
  readonly name = "x";

  async resolveUsers(a: AccountCtx, usernames: string[]): Promise<ResolvedUser[]> {
    const out: ResolvedUser[] = [];
    for (let i = 0; i < usernames.length; i += 100) {
      const chunk = usernames.slice(i, i + 100);
      try {
        const r = await call(a.id, `/users/by?usernames=${chunk.join(",")}&user.fields=verified,public_metrics,description,location,name`);
        if ("authFailed" in r) { chunk.forEach((u) => out.push({ username: u, status: "error" })); continue; }
        if (!r.res.ok) { chunk.forEach((u) => out.push({ username: u, status: "error" })); continue; }
        const j = (await r.res.json()) as { data?: any[]; errors?: any[] };
        const found = new Map((j.data ?? []).map((u) => [u.username.toLowerCase(), u]));
        for (const u of chunk) {
          const f = found.get(u);
          if (f) out.push({ username: u, status: "ok", id: f.id, name: f.name, verified: f.verified, followers: f.public_metrics?.followers_count, description: f.description, location: f.location, currentUsername: f.username.toLowerCase() });
          else {
            const err = (j.errors ?? []).find((e) => String(e.value ?? "").toLowerCase() === u);
            out.push({ username: u, status: /suspend/i.test(err?.detail ?? "") ? "suspended" : err ? "not_found" : "error" });
          }
        }
      } catch { chunk.forEach((u) => out.push({ username: u, status: "error" })); }
    }
    return out;
  }

  async sendDm(a: AccountCtx, req: { toXUserId: string; text: string }): Promise<SendOutcome> {
    let r;
    try {
      r = await call(a.id, `/dm_conversations/with/${req.toXUserId}/messages`, { method: "POST", body: JSON.stringify({ text: req.text }) });
    } catch (e) {
      // Timeout / network drop AFTER we may have sent the request: delivery is unknown.
      return { kind: "uncertain", reason: (e as Error).name === "TimeoutError" ? "request timeout" : "network error" };
    }
    if ("authFailed" in r) return { kind: "auth", apiStatus: 401, message: "No valid access token for this account" };
    const { res } = r;
    if (res.status === 200 || res.status === 201) {
      const j = (await res.json()) as { data?: { dm_conversation_id: string; dm_event_id: string } };
      if (!j.data?.dm_event_id) return { kind: "uncertain", reason: "success status without event id", apiStatus: res.status };
      return { kind: "sent", eventId: j.data.dm_event_id, conversationId: j.data.dm_conversation_id, apiStatus: res.status };
    }
    if (res.status === 429) return { kind: "rate_limited", resetAt: resetOf(res), apiStatus: 429 };
    if (res.status === 401) return { kind: "auth", apiStatus: 401, message: "Unauthorized — token revoked or expired" };
    const body = await res.text().catch(() => "");
    if (res.status >= 500 || res.status === 408) return { kind: "uncertain", reason: `server error ${res.status}`, apiStatus: res.status };
    const category = res.status === 403 ? "RECIPIENT_RESTRICTED" : res.status === 404 ? "RECIPIENT_NOT_FOUND" : "BAD_REQUEST";
    return { kind: "permanent", apiStatus: res.status, category, message: body.slice(0, 300) };
  }

  async listDmEvents(a: AccountCtx, opts: { maxPages?: number; pageSize?: number; isKnown?: (eventId: string) => boolean } = {}) {
    const events: DmEvent[] = [];
    let token: string | undefined;
    const max = opts.maxPages ?? 5;
    for (let page = 0; page < max; page++) {
      const q = new URLSearchParams({ max_results: String(Math.min(100, Math.max(1, opts.pageSize ?? 100))), "dm_event.fields": "id,text,event_type,created_at,sender_id,dm_conversation_id,participant_ids", event_types: "MessageCreate" });
      if (token) q.set("pagination_token", token);
      let r;
      try { r = await call(a.id, `/dm_events?${q}`); } catch { return { events, truncated: true }; }
      if ("authFailed" in r) return { error: "auth" as const };
      if (r.res.status === 429) return { error: "rate_limited" as const, resetAt: resetOf(r.res) };
      if (r.res.status === 401) return { error: "auth" as const };
      if (!r.res.ok) return { events, truncated: true };
      const j = (await r.res.json()) as { data?: any[]; meta?: { next_token?: string } };
      for (const e of j.data ?? []) events.push({ id: e.id, conversationId: e.dm_conversation_id, senderId: e.sender_id, text: e.text ?? "", createdAt: new Date(e.created_at), participantIds: e.participant_ids });
      token = j.meta?.next_token;
      if (!token) return { events, truncated: false };
      // Incremental: once we reach events we already stored, older pages are known too — stop paying for them.
      if (opts.isKnown && (j.data ?? []).some((e) => opts.isKnown!(e.id))) return { events, truncated: false };
    }
    return { events, truncated: true };
  }

  async listConversationWith(a: AccountCtx, other: string): Promise<DmEvent[] | null> {
    try {
      const r = await call(a.id, `/dm_conversations/with/${other}/dm_events?max_results=10&event_types=MessageCreate&dm_event.fields=id,text,created_at,sender_id,dm_conversation_id,participant_ids`);
      if ("authFailed" in r || !r.res.ok) return null;
      const j = (await r.res.json()) as { data?: any[] };
      return (j.data ?? []).map((e) => ({ id: e.id, conversationId: e.dm_conversation_id, senderId: e.sender_id, text: e.text ?? "", createdAt: new Date(e.created_at), participantIds: e.participant_ids ?? [a.xUserId, other] }));
    } catch { return null; }
  }

  async findSentDm(a: AccountCtx, q: { toXUserId: string; text: string; since: Date }) {
    try {
      const r = await call(a.id, `/dm_conversations/with/${q.toXUserId}/dm_events?max_results=10&event_types=MessageCreate&dm_event.fields=id,text,created_at,sender_id,dm_conversation_id`);
      if ("authFailed" in r || !r.res.ok) return null;
      const j = (await r.res.json()) as { data?: any[] };
      // We only ever send ONE first-contact DM per recipient, and X rewrites links (t.co), so exact text can't be trusted.
      // Any DM from us to this person after the claim time counts as delivered — the safe direction (prevents duplicates).
      const hit = (j.data ?? []).find((e) => e.sender_id === a.xUserId && new Date(e.created_at) >= new Date(q.since.getTime() - 60_000));
      return hit ? { found: true, eventId: hit.id, conversationId: hit.dm_conversation_id } : { found: false };
    } catch { return null; }
  }
}
