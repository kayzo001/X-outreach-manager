import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma, Tx } from "./db";
import { CredentialKeyError, credentialsKeyConfigured, decryptCredential, encryptCredential } from "./crypto";
import { logActivity } from "./activity";
import { X_TOKEN_URL } from "./oauth";

/**
 * Single source of X OAuth client configuration for the web app, the OAuth routes, token refresh and the worker.
 * Priority: credentials saved in Settings (database) → environment variables → none.
 * Secrets are decrypted only here and are never returned to the browser (see getXCredentialSummary).
 */
export const X_SECRET_PURPOSE = "x.oauth.client_secret";
const PROVIDER = "x";

export interface XOAuthConfig {
  source: "database" | "environment" | "none";
  clientId: string;
  clientSecret: string;
  confidential: boolean;
  redirectUri: string;
  version: number;
  /** Changes whenever the effective client id/secret/version changes. OAuth handshakes are pinned to it. */
  fingerprint: string;
  error?: string;
}

export const appUrl = () => (process.env.APP_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
export const redirectUri = () => process.env.X_REDIRECT_URI?.trim() || `${appUrl()}/api/x/callback`;
const fp = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);

export async function getXOAuthConfig(db: Tx = prisma): Promise<XOAuthConfig> {
  const row = await db.integrationCredential.findUnique({ where: { provider: PROVIDER } });
  if (row) {
    let secret = "", error: string | undefined;
    if (row.clientSecretEnc) {
      try { secret = decryptCredential(row.clientSecretEnc, X_SECRET_PURPOSE); }
      catch (e) { error = e instanceof CredentialKeyError ? e.message : "The saved Client Secret can't be decrypted — CREDENTIALS_ENCRYPTION_KEY was changed. Re-enter the secret."; }
    }
    return { source: "database", clientId: row.clientId, clientSecret: secret, confidential: !!row.clientSecretEnc, redirectUri: redirectUri(), version: row.version, fingerprint: fp("db", row.version, row.clientId, secret), error };
  }
  const id = process.env.X_CLIENT_ID?.trim() || "", secret = process.env.X_CLIENT_SECRET?.trim() || "";
  if (id) return { source: "environment", clientId: id, clientSecret: secret, confidential: !!secret, redirectUri: redirectUri(), version: 0, fingerprint: fp("env", id, secret) };
  return { source: "none", clientId: "", clientSecret: "", confidential: false, redirectUri: redirectUri(), version: 0, fingerprint: "none" };
}

/** X's OAuth 2.0 Client IDs are base64 of "<id>:1:ci". API Keys (consumer keys) are 25 plain alphanumerics. Heuristic only. */
export function looksLikeOAuth2ClientId(id: string) {
  try { return /:\d+:ci$/.test(Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return false; }
}
const apiKeyHint = (id: string) => (looksLikeOAuth2ClientId(id) ? "" : " Note: the saved Client ID doesn’t look like an OAuth 2.0 Client ID — it may be the API Key (Consumer Key) instead. Use the values under “OAuth 2.0 Client ID and Client Secret”.");

export const maskClientId = (id: string) => (id.length <= 8 ? "••••" : `${id.slice(0, 4)}••••••${id.slice(-4)}`);

/** Browser-safe view: no secret, masked id. */
export async function getXCredentialSummary() {
  const [cfg, row] = await Promise.all([getXOAuthConfig(), prisma.integrationCredential.findUnique({ where: { provider: PROVIDER } })]);
  return {
    source: cfg.source, configured: cfg.source !== "none", clientIdMasked: cfg.clientId ? maskClientId(cfg.clientId) : null,
    hasSecret: cfg.confidential, version: cfg.version, redirectUri: cfg.redirectUri, error: cfg.error ?? null,
    keyConfigured: credentialsKeyConfigured(), lastTestedAt: row?.lastTestedAt ?? null, lastTestOk: row?.lastTestOk ?? null,
    lastTestMessage: row?.lastTestMessage ?? null, updatedAt: row?.updatedAt ?? null,
  };
}
export type XCredentialSummary = Awaited<ReturnType<typeof getXCredentialSummary>>;

const inputSchema = z.object({
  clientId: z.string().trim().min(10, "Client ID looks too short").max(100, "Client ID looks too long").regex(/^[A-Za-z0-9_\-:.]+$/, "Client ID contains unexpected characters — copy the OAuth 2.0 Client ID from Keys and tokens"),
  clientSecret: z.string().trim().max(200, "Client Secret looks too long").regex(/^[\x21-\x7E]*$/, "Client Secret contains spaces or unexpected characters").optional(),
});

/** Every credential change invalidates OAuth accounts: their tokens belong to the old app configuration. */
async function requireReconnect(tx: Tx, reason: string) {
  const r = await tx.xAccount.updateMany({ where: { status: "ACTIVE", lastVerifiedAt: { not: null } }, data: { status: "EXPIRED", lastError: reason } });
  return r.count;
}

export { apiKeyHint };

export async function saveXCredentials(input: { clientId?: string | null; clientSecret?: string | null }, actor: string) {
  // Blank Client ID on update = keep the saved one (the browser only ever sees a masked version).
  const saved = input.clientId?.trim() ? null : await prisma.integrationCredential.findUnique({ where: { provider: PROVIDER } });
  const parsed = inputSchema.parse({ clientId: input.clientId?.trim() || saved?.clientId || "", clientSecret: input.clientSecret ?? undefined });
  if (!credentialsKeyConfigured()) throw new CredentialKeyError("CREDENTIALS_ENCRYPTION_KEY is not set on the server — credentials can't be stored securely");
  const newSecret = parsed.clientSecret || "";
  return prisma.$transaction(async (tx) => {
    const existing = await tx.integrationCredential.findUnique({ where: { provider: PROVIDER } });
    // Blank secret on update = keep the saved one (the form never shows it back).
    const secretEnc = newSecret ? encryptCredential(newSecret, X_SECRET_PURPOSE) : existing?.clientSecretEnc ?? null;
    const idChanged = !existing || existing.clientId !== parsed.clientId;
    const secretChanged = !!newSecret;
    if (existing && !idChanged && !secretChanged) return { changed: false, reconnectRequired: 0 };
    await tx.integrationCredential.upsert({
      where: { provider: PROVIDER },
      create: { provider: PROVIDER, clientId: parsed.clientId, clientSecretEnc: secretEnc, version: 1, updatedBy: actor },
      update: { clientId: parsed.clientId, clientSecretEnc: secretEnc, version: { increment: 1 }, updatedBy: actor, lastTestedAt: null, lastTestOk: null, lastTestMessage: null },
    });
    const reconnect = existing ? await requireReconnect(tx, "X developer credentials were changed — click Reconnect") : 0;
    await logActivity({
      type: existing ? "integration.x_credentials_updated" : "integration.x_credentials_saved",
      message: `X developer credentials ${existing ? "updated" : "saved"} (Client ID ${maskClientId(parsed.clientId)}${secretChanged ? ", secret changed" : existing ? ", secret unchanged" : secretEnc ? "" : ", no secret — public client"})${reconnect ? ` — ${reconnect} account(s) must reconnect` : ""}`,
      meta: { actor, idChanged, secretChanged, hasSecret: !!secretEnc },
    }, tx);
    return { changed: true, reconnectRequired: reconnect };
  });
}

export async function deleteXCredentials(actor: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.integrationCredential.deleteMany({ where: { provider: PROVIDER } });
    if (!r.count) return { deleted: false, reconnectRequired: 0 };
    const reconnect = await requireReconnect(tx, "X developer credentials were deleted — save credentials, then Reconnect");
    await logActivity({ type: "integration.x_credentials_deleted", level: "warn", message: `X developer credentials deleted${reconnect ? ` — ${reconnect} account(s) must reconnect` : ""}`, meta: { actor } }, tx);
    return { deleted: true, reconnectRequired: reconnect };
  });
}

export interface TestResult { ok: boolean | null; message: string }

/**
 * Validates what can be validated without a user login. X has no "check my app credentials" endpoint, so for
 * confidential clients we send the token endpoint a deliberately invalid authorisation code:
 *   • 401 / invalid_client  → X rejected the Client ID/Secret.
 *   • 400 invalid_request / invalid_grant about the code → client authentication passed; only the fake code failed.
 * This is strong evidence, not proof — the real proof is completing "Continue with X".
 */
export async function testXConfiguration(actor: string): Promise<TestResult> {
  const cfg = await getXOAuthConfig();
  let result: TestResult;
  if (cfg.source === "none") result = { ok: false, message: "No X credentials configured. Save your Client ID and Client Secret first." };
  else if (cfg.error) result = { ok: false, message: cfg.error };
  else if (process.env.NODE_ENV === "production" && !cfg.redirectUri.startsWith("https://")) result = { ok: false, message: `Callback URL must use https in production (currently ${cfg.redirectUri}). Set APP_URL / X_REDIRECT_URI.` };
  else if (!cfg.confidential) result = { ok: null, message: "Client ID format is valid. Without a Client Secret (public client) X offers no way to check it in advance — complete “Continue with X” to verify." };
  else result = await probeTokenEndpoint(cfg);

  if (cfg.source === "database") {
    await prisma.integrationCredential.update({ where: { provider: PROVIDER }, data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message.slice(0, 500) } });
  }
  await logActivity({ type: "integration.x_credentials_tested", level: result.ok === false ? "warn" : "info", message: `X configuration test (${cfg.source}): ${result.ok === true ? "client credentials accepted" : result.ok === false ? "failed" : "inconclusive"}`, meta: { actor } });
  return result;
}

async function probeTokenEndpoint(cfg: XOAuthConfig): Promise<TestResult> {
  let res: Response;
  try {
    res = await fetch(X_TOKEN_URL, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: `xom-config-test-${randomBytes(8).toString("hex")}`, redirect_uri: cfg.redirectUri, code_verifier: randomBytes(48).toString("base64url"), client_id: cfg.clientId }),
    });
  } catch (e) {
    return { ok: null, message: `Couldn't reach X to test (${(e as Error).name === "TimeoutError" ? "timeout" : "network error"}). Try again.` };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  const said = [body.error, body.error_description].filter(Boolean).join(" — ").slice(0, 200);
  if (res.status === 401 || body.error === "invalid_client" || body.error === "unauthorized_client")
    return { ok: false, message: `X rejected the Client ID / Client Secret (HTTP ${res.status}${said ? `: ${said}` : ""}). Re-copy both from Keys and tokens → OAuth 2.0 Client ID and Client Secret (regenerate the secret if unsure — they must come from the same app).${apiKeyHint(cfg.clientId)}` };
  if (res.status === 400 && (body.error === "invalid_request" || body.error === "invalid_grant"))
    return { ok: true, message: `X accepted the Client ID / Client Secret (it rejected only the test’s deliberately invalid code). Final verification happens when you complete “Continue with X”.${said ? ` X said: ${said}` : ""}` };
  return { ok: null, message: `Inconclusive: X answered HTTP ${res.status}${said ? ` (${said})` : ""}. Try “Continue with X” to verify.` };
}
