import { createHash, randomBytes } from "crypto";
import { decrypt, encrypt } from "./crypto";
import type { XOAuthConfig } from "./x-config";

/** The subset of the central config (src/lib/x-config.ts) the OAuth helpers need. */
export type OAuthClient = Pick<XOAuthConfig, "clientId" | "clientSecret" | "confidential" | "redirectUri">;

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_ME_URL = "https://api.x.com/2/users/me";
/** Minimum scopes for: resolve usernames, read DMs (history/replies), send DMs, refresh without re-login. */
export const X_SCOPES = ["tweet.read", "users.read", "dm.read", "dm.write", "offline.access"];
export const OAUTH_COOKIE = "xom_oauth";
const STATE_TTL_MS = 10 * 60_000;

/** `cfp` pins the handshake to the exact credential configuration it started with. */
export interface OAuthState { verifier: string; state: string; uid: string; iat: number; cfp: string }

export function newOAuthState(uid: string, configFingerprint: string): OAuthState {
  return { verifier: randomBytes(48).toString("base64url"), state: randomBytes(24).toString("base64url"), uid, iat: Date.now(), cfp: configFingerprint };
}

/** The PKCE verifier + state + owner id travel in an encrypted (AES-GCM, server key) cookie — unforgeable, never readable by JS. */
export const sealState = (s: OAuthState) => encrypt(JSON.stringify(s));

export function openState(cookie: string | undefined, stateParam: string | null, now = Date.now()): { ok: true; s: OAuthState } | { ok: false; reason: "missing" | "tampered" | "mismatch" | "expired" } {
  if (!cookie) return { ok: false, reason: "missing" };
  let s: OAuthState;
  try { s = JSON.parse(decrypt(cookie)); } catch { return { ok: false, reason: "tampered" }; }
  if (!s.state || !stateParam || s.state !== stateParam) return { ok: false, reason: "mismatch" };
  if (!s.iat || now - s.iat > STATE_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true, s };
}

export function buildAuthorizeUrl(s: OAuthState, cfg: OAuthClient) {
  const q = new URLSearchParams({
    response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: X_SCOPES.join(" "),
    state: s.state, code_challenge: createHash("sha256").update(s.verifier).digest("base64url"), code_challenge_method: "S256",
  });
  // X expects spaces in `scope` as %20; URLSearchParams would emit "+".
  return `${X_AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`;
}

export interface TokenSet { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
export type ExchangeResult = { ok: true; tokens: TokenSet } | { ok: false; status: number; error: string };

/** Auth-code → tokens. Confidential clients (have a secret) use HTTP Basic; public clients send client_id in the body. */
export async function exchangeCode(code: string, verifier: string, cfg: OAuthClient): Promise<ExchangeResult> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cfg.confidential) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  let res: Response;
  try {
    res = await fetch(X_TOKEN_URL, {
      method: "POST", headers, signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier, client_id: cfg.clientId }),
    });
  } catch (e) { return { ok: false, status: 0, error: `network: ${(e as Error).message}` }; }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok || !body.access_token) return { ok: false, status: res.status, error: describeXError(body) };
  return { ok: true, tokens: body as TokenSet };
}

export async function fetchMe(accessToken: string): Promise<{ ok: true; id: string; username: string } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(X_ME_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const data = (body as { data?: { id: string; username: string } }).data;
    if (!res.ok || !data?.id) return { ok: false, status: res.status, error: describeXError(body) };
    return { ok: true, id: data.id, username: data.username };
  } catch (e) { return { ok: false, status: 0, error: `network: ${(e as Error).message}` }; }
}

/** Only the human-readable error fields from X — never echoes tokens or request bodies. */
function describeXError(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const parts = [b.error, b.error_description, b.title, b.detail].filter((x) => typeof x === "string") as string[];
  return (parts.join(" — ") || "unknown error").slice(0, 300);
}

export const missingScopes = (granted: string[]) => X_SCOPES.filter((s) => !granted.includes(s));
