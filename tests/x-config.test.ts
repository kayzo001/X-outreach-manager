import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CredentialKeyError, decryptCredential, encrypt, encryptCredential } from "@/lib/crypto";
import { X_SECRET_PURPOSE, deleteXCredentials, getXCredentialSummary, getXOAuthConfig, saveXCredentials, testXConfiguration } from "@/lib/x-config";
import { OAUTH_COOKIE, X_SCOPES, buildAuthorizeUrl, newOAuthState, sealState } from "@/lib/oauth";
import { GET as callback } from "@/app/api/x/callback/route";
import { syncAccount } from "@/lib/sync";
import { resetDb } from "./helpers";

const ID = "Q2xpZW50SWQtZnJvbS1kYg", SECRET = "db-secret-Zz9_~!xyz", ID2 = "U2Vjb25kQ2xpZW50SWQ", SECRET2 = "second-secret-123";
const CB = "http://localhost:3100/api/x/callback";
const KEY = process.env.CREDENTIALS_ENCRYPTION_KEY!;
let calls: { url: string; init?: RequestInit }[] = [];
const basicOf = (id: string, sec: string) => `Basic ${Buffer.from(`${id}:${sec}`).toString("base64")}`;
const authHeader = (c: { init?: RequestInit }) => (c.init?.headers as Record<string, string> | undefined)?.Authorization;

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
}
const xOk = (url: string) => url.includes("/oauth2/token") ? { status: 200, body: { access_token: "AT-1", refresh_token: "RT-1", expires_in: 7200, scope: X_SCOPES.join(" ") } }
  : url.includes("/users/me") ? { status: 200, body: { data: { id: "777", username: "founder" } } } : { status: 200, body: { data: [] } };

beforeEach(async () => {
  await resetDb();
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY;
  delete process.env.X_CLIENT_ID; delete process.env.X_CLIENT_SECRET;
  process.env.X_REDIRECT_URI = CB;
});
afterEach(() => vi.unstubAllGlobals());

describe("1–5 · save, retrieve, update, delete, encryption", () => {
  it("saves the secret encrypted (never plaintext) and the service decrypts it", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "owner@test");
    const row = await prisma.integrationCredential.findUniqueOrThrow({ where: { provider: "x" } });
    expect(row.clientSecretEnc).not.toContain(SECRET);
    expect(row.clientSecretEnc!.startsWith("c1.")).toBe(true);
    expect(decryptCredential(row.clientSecretEnc!, X_SECRET_PURPOSE)).toBe(SECRET);
    expect(await getXOAuthConfig()).toMatchObject({ source: "database", clientId: ID, clientSecret: SECRET, confidential: true, version: 1 });
  });

  it("browser-safe summary exposes only a masked id and no secret", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const sum = await getXCredentialSummary();
    const json = JSON.stringify(sum);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(ID);
    expect(sum).toMatchObject({ configured: true, hasSecret: true, source: "database", clientIdMasked: "Q2xp••••••XzYg".replace("XzYg", ID.slice(-4)) });
  });

  it("updates: blank secret keeps the saved one, blank id keeps the saved id, version bumps, accounts must reconnect", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const user = await prisma.user.create({ data: { email: "u@u.t", passwordHash: "x" } });
    await prisma.xAccount.create({ data: { userId: user.id, xUserId: "777", username: "founder", accessTokenEnc: encrypt("t"), scopes: [], lastVerifiedAt: new Date(), oauthClientId: ID } });

    expect(await saveXCredentials({ clientId: ID, clientSecret: "" }, "o")).toMatchObject({ changed: false });
    await saveXCredentials({ clientId: "", clientSecret: SECRET2 }, "o");
    expect(await getXOAuthConfig()).toMatchObject({ clientId: ID, clientSecret: SECRET2, version: 2 });
    expect(await prisma.xAccount.findUniqueOrThrow({ where: { xUserId: "777" } })).toMatchObject({ status: "EXPIRED", lastError: expect.stringContaining("Reconnect") });

    await saveXCredentials({ clientId: ID2 }, "o");
    expect(await getXOAuthConfig()).toMatchObject({ clientId: ID2, clientSecret: SECRET2, version: 3 });
  });

  it("delete removes credentials and disconnects OAuth accounts", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const user = await prisma.user.create({ data: { email: "u@u.t", passwordHash: "x" } });
    await prisma.xAccount.create({ data: { userId: user.id, xUserId: "777", username: "f", accessTokenEnc: encrypt("t"), scopes: [], lastVerifiedAt: new Date() } });
    expect(await deleteXCredentials("o")).toMatchObject({ deleted: true, reconnectRequired: 1 });
    expect(await prisma.integrationCredential.count()).toBe(0);
    expect((await getXOAuthConfig()).source).toBe("none");
    expect(await deleteXCredentials("o")).toMatchObject({ deleted: false });
  });

  it("ciphertext is bound to its purpose and to the key; DB rejects plaintext secrets", async () => {
    const c = encryptCredential("s3cret", X_SECRET_PURPOSE);
    expect(() => decryptCredential(c, "some.other.field")).toThrow();
    process.env.CREDENTIALS_ENCRYPTION_KEY = "2".repeat(64);
    expect(() => decryptCredential(c, X_SECRET_PURPOSE)).toThrow();
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY;
    await expect(prisma.integrationCredential.create({ data: { provider: "x", clientId: ID, clientSecretEnc: "plaintext-secret" } })).rejects.toThrow();
  });

  it("a changed CREDENTIALS_ENCRYPTION_KEY surfaces a clear error instead of a broken secret", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    process.env.CREDENTIALS_ENCRYPTION_KEY = "3".repeat(64);
    const cfg = await getXOAuthConfig();
    expect(cfg.clientSecret).toBe("");
    expect(cfg.error).toMatch(/can.t be decrypted/);
  });
});

describe("6 · invalid or missing input", () => {
  it("rejects malformed ids/secrets and refuses to store without an encryption key", async () => {
    await expect(saveXCredentials({ clientId: "short", clientSecret: SECRET }, "o")).rejects.toThrow(/too short/);
    await expect(saveXCredentials({ clientId: "has spaces in it!!", clientSecret: SECRET }, "o")).rejects.toThrow(/unexpected characters/);
    await expect(saveXCredentials({ clientId: ID, clientSecret: "has a space" }, "o")).rejects.toThrow(/spaces/);
    await expect(saveXCredentials({ clientId: "", clientSecret: SECRET }, "o")).rejects.toThrow();
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    await expect(saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o")).rejects.toBeInstanceOf(CredentialKeyError);
    expect((await getXCredentialSummary()).keyConfigured).toBe(false);
    expect(await prisma.integrationCredential.count()).toBe(0);
  });
});

describe("Test Configuration — never claims more than X confirmed", () => {
  it("not configured → fails without calling X", async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    expect(await testXConfiguration("o")).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
  it("X rejects the client (401) → ok:false; X rejects only the fake code (400) → ok:true with caveat; other → inconclusive", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    stubFetch(() => ({ status: 401, body: { error: "unauthorized_client", error_description: "Missing valid authorization header" } }));
    expect(await testXConfiguration("o")).toMatchObject({ ok: false, message: expect.stringContaining("rejected the Client ID") });
    expect(authHeader(calls[0])).toBe(basicOf(ID, SECRET));

    stubFetch(() => ({ status: 400, body: { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." } }));
    const okRes = await testXConfiguration("o");
    expect(okRes).toMatchObject({ ok: true, message: expect.stringContaining("Final verification happens when you complete") });
    expect(await prisma.integrationCredential.findUniqueOrThrow({ where: { provider: "x" } })).toMatchObject({ lastTestOk: true });

    stubFetch(() => ({ status: 503, body: {} }));
    expect((await testXConfiguration("o")).ok).toBeNull();
    for (const r of [okRes]) expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it("public client (no secret) is reported as unverifiable in advance", async () => {
    await saveXCredentials({ clientId: ID }, "o");
    stubFetch(() => ({ status: 400, body: {} }));
    expect(await testXConfiguration("o")).toMatchObject({ ok: null });
    expect(calls).toHaveLength(0);
  });
});

describe("7–8 · OAuth login + callback use the database credentials", () => {
  async function startHandshake() {
    const user = await prisma.user.create({ data: { email: "u@u.t", passwordHash: "x" } });
    const cfg = await getXOAuthConfig();
    const s = newOAuthState(user.id, cfg.fingerprint);
    return { s, url: buildAuthorizeUrl(s, cfg) };
  }
  const cb = (s: { state: string }, cookie: string) => { const r = new NextRequest(`${CB}?code=c&state=${s.state}`); r.cookies.set(OAUTH_COOKIE, cookie); return callback(r); };

  it("authorize URL carries the DB client id; callback exchanges with the DB secret and records which app issued the tokens", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const { s, url } = await startHandshake();
    expect(new URL(url).searchParams.get("client_id")).toBe(ID);
    stubFetch(xOk);
    const res = await cb(s, sealState(s));
    expect(new URL(res.headers.get("location")!).searchParams.get("x")).toBe("connected");
    expect(authHeader(calls.find((c) => c.url.includes("/oauth2/token"))!)).toBe(basicOf(ID, SECRET));
    expect(await prisma.xAccount.findUniqueOrThrow({ where: { xUserId: "777" } })).toMatchObject({ status: "ACTIVE", oauthClientId: ID });
    expect(res.headers.get("location")).not.toContain(SECRET);
  });

  it("credentials changed mid-handshake → aborted, nothing exchanged with the wrong app", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const { s } = await startHandshake();
    await saveXCredentials({ clientId: ID2, clientSecret: SECRET2 }, "o");
    stubFetch(xOk);
    const res = await cb(s, sealState(s));
    expect(new URL(res.headers.get("location")!).searchParams.get("x")).toBe("config_changed");
    expect(calls).toHaveLength(0);
    expect(await prisma.xAccount.count()).toBe(0);
  });
});

describe("9 · restart: credentials persist and decrypt with a fresh connection", () => {
  it("a brand-new Prisma client (as after a restart) reads and decrypts the same credentials", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const fresh = new PrismaClient();
    try {
      const cfg = await getXOAuthConfig(fresh);
      expect(cfg).toMatchObject({ source: "database", clientId: ID, clientSecret: SECRET });
    } finally { await fresh.$disconnect(); }
  });
});

describe("10 · worker path: token refresh + sync load credentials from the database", () => {
  async function realAccount(oauthClientId: string) {
    const user = await prisma.user.create({ data: { email: "u@u.t", passwordHash: "x" } });
    return prisma.xAccount.create({ data: {
      userId: user.id, xUserId: "777", username: "founder", scopes: X_SCOPES, lastVerifiedAt: new Date(), oauthClientId, lastSyncAt: new Date(),
      accessTokenEnc: encrypt("expired-token"), refreshTokenEnc: encrypt("refresh-token"), tokenExpiresAt: new Date(Date.now() - 1000),
    } });
  }
  it("Sync DMs on a real OAuth account uses the X client and refreshes with the DB secret", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const acc = await realAccount(ID);
    stubFetch((url) => url.includes("/oauth2/token") ? { status: 200, body: { access_token: "fresh", refresh_token: "rt2", expires_in: 7200 } } : { status: 200, body: { data: [] } });
    const r = await syncAccount(acc.id); // no provider override — same path the worker takes
    expect(r.ok).toBe(true);
    expect(authHeader(calls[0])).toBe(basicOf(ID, SECRET));
    expect(calls.some((c) => c.url.includes("/2/dm_events"))).toBe(true);
  });
  it("refresh is refused (and reconnect required) if the account belongs to a different X app", async () => {
    await saveXCredentials({ clientId: ID2, clientSecret: SECRET2 }, "o");
    const acc = await realAccount(ID);
    stubFetch(() => ({ status: 200, body: {} }));
    const r = await syncAccount(acc.id);
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.url.includes("/oauth2/token"))).toHaveLength(0);
    expect((await prisma.xAccount.findUniqueOrThrow({ where: { id: acc.id } })).lastError).toMatch(/Reconnect/);
  });
});

describe("11 · environment fallback", () => {
  it("uses .env only when nothing is saved; database wins once saved", async () => {
    process.env.X_CLIENT_ID = "envClientId123"; process.env.X_CLIENT_SECRET = "env-secret";
    expect(await getXOAuthConfig()).toMatchObject({ source: "environment", clientId: "envClientId123", clientSecret: "env-secret" });
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    expect(await getXOAuthConfig()).toMatchObject({ source: "database", clientId: ID });
    await deleteXCredentials("o");
    expect((await getXOAuthConfig()).source).toBe("environment");
  });
});

describe("12 · no secret leakage", () => {
  it("activity logs record the change but never the id or secret", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    await saveXCredentials({ clientId: ID2, clientSecret: SECRET2 }, "o");
    stubFetch(() => ({ status: 400, body: { error: "invalid_request" } }));
    await testXConfiguration("o");
    await deleteXCredentials("o");
    const logs = JSON.stringify(await prisma.activityLog.findMany());
    for (const v of [SECRET, SECRET2, ID, ID2]) expect(logs).not.toContain(v);
    expect(logs).toContain("integration.x_credentials_saved");
    expect(logs).toContain("integration.x_credentials_updated");
    expect(logs).toContain("integration.x_credentials_deleted");
  });
});

describe("API Key vs OAuth 2.0 Client ID heuristic", () => {
  it("recognises OAuth 2.0 client ids (base64 of '<id>:1:ci') and flags API-key-shaped values", async () => {
    const { looksLikeOAuth2ClientId } = await import("@/lib/x-config");
    expect(looksLikeOAuth2ClientId(Buffer.from("abcDEF123xyz:1:ci").toString("base64url"))).toBe(true);
    expect(looksLikeOAuth2ClientId("aB3dE5gH7jK9mN1pQ3sT5vW7y")).toBe(false); // 25-char API key shape
  });
  it("a 401 test result points at the API-key mix-up when the id looks like one", async () => {
    await saveXCredentials({ clientId: "aB3dE5gH7jK9mN1pQ3sT5vW7y", clientSecret: SECRET }, "o");
    stubFetch(() => ({ status: 401, body: { error: "unauthorized_client", error_description: "Missing valid authorization header" } }));
    expect((await testXConfiguration("o")).message).toContain("may be the API Key");
  });
});

describe("public-client detection", () => {
  it("401 with the secret but 400 without it ⇒ tells you the X app is a public client", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    stubFetch(() => ({ status: 400, body: {} }));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const withAuth = !!(init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify(withAuth ? { error: "unauthorized_client", error_description: "Missing valid authorization header" } : { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." }), { status: withAuth ? 401 : 400 });
    }));
    const r = await testXConfiguration("o");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("public client");
  });
  it("summary exposes only length + last 4 of the secret", async () => {
    await saveXCredentials({ clientId: ID, clientSecret: SECRET }, "o");
    const sum = await getXCredentialSummary();
    expect(sum.secretHint).toBe(`${SECRET.length} chars, ends …${SECRET.slice(-4)}`);
    expect(JSON.stringify(sum)).not.toContain(SECRET);
  });
});
