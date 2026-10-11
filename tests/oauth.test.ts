import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { buildAuthorizeUrl, newOAuthState, openState, sealState, X_SCOPES, OAUTH_COOKIE } from "@/lib/oauth";
import { GET as callback } from "@/app/api/x/callback/route";
import { getXOAuthConfig } from "@/lib/x-config";
import { middleware } from "@/middleware";
import { resetDb } from "./helpers";

const ACCESS = "ACCESS-TOKEN-SECRET-123", REFRESH = "REFRESH-TOKEN-SECRET-456";
const CB = "http://localhost:3100/api/x/callback";
let uid = "";
let calls: { url: string; init: RequestInit }[] = [];

function stubX(o: { token?: { status: number; body: unknown }; me?: { status: number; body: unknown } } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = String(url).includes("/oauth2/token") ? (o.token ?? { status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 7200, scope: X_SCOPES.join(" ") } })
      : (o.me ?? { status: 200, body: { data: { id: "777", username: "RealFounder" } } });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
}
function cbRequest(params: Record<string, string>, cookie?: string) {
  const req = new NextRequest(`${CB}?${new URLSearchParams(params)}`);
  if (cookie) req.cookies.set(OAUTH_COOKIE, cookie);
  return req;
}
const loc = (r: Response) => new URL(r.headers.get("location")!);
const stateFor = async () => newOAuthState(uid, (await getXOAuthConfig()).fingerprint);

beforeEach(async () => {
  await resetDb();
  uid = (await prisma.user.create({ data: { email: "o@o.test", passwordHash: "x" } })).id;
  Object.assign(process.env, { X_CLIENT_ID: "client-abc", X_CLIENT_SECRET: "secret-xyz", X_REDIRECT_URI: CB });
});
afterEach(() => vi.unstubAllGlobals());

describe("authorize URL", () => {
  it("has the documented endpoint, exact redirect, PKCE S256 and %20-separated scopes", async () => {
    const s = await stateFor();
    const u = buildAuthorizeUrl(s, await getXOAuthConfig());
    expect(u.startsWith("https://x.com/i/oauth2/authorize?")).toBe(true);
    expect(u).toContain("scope=tweet.read%20users.read%20dm.read%20dm.write%20offline.access");
    const q = new URL(u).searchParams;
    expect(q.get("redirect_uri")).toBe(CB);
    expect(q.get("client_id")).toBe("client-abc");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(s.verifier).digest("base64url"));
    expect(u).not.toContain(s.verifier);
  });
});

describe("state cookie", () => {
  it("rejects missing, tampered, mismatched and expired state", async () => {
    const s = await stateFor(), c = sealState(s);
    expect(openState(undefined, s.state)).toMatchObject({ ok: false, reason: "missing" });
    expect(openState(c.slice(0, -4) + "AAAA", s.state)).toMatchObject({ ok: false, reason: "tampered" });
    expect(openState(c, "other")).toMatchObject({ ok: false, reason: "mismatch" });
    expect(openState(c, s.state, s.iat + 11 * 60_000)).toMatchObject({ ok: false, reason: "expired" });
    expect(openState(c, s.state)).toMatchObject({ ok: true });
  });
});

describe("callback", () => {
  it("connects end-to-end: exchanges code, reads profile, stores ENCRYPTED tokens, leaks nothing", async () => {
    stubX();
    const s = await stateFor();
    const res = await callback(cbRequest({ code: "the-code", state: s.state }, sealState(s)));
    expect(loc(res).pathname).toBe("/settings");
    expect(loc(res).searchParams.get("x")).toBe("connected");
    expect(loc(res).searchParams.get("detail")).toBe("@RealFounder");

    // token request: confidential client → Basic auth, PKCE verifier, exact redirect
    const tok = calls.find((c) => c.url.includes("/oauth2/token"))!;
    expect((tok.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("client-abc:secret-xyz").toString("base64")}`);
    const body = new URLSearchParams(String(tok.init.body));
    expect(body.get("code_verifier")).toBe(s.verifier);
    expect(body.get("redirect_uri")).toBe(CB);

    const acc = await prisma.xAccount.findUniqueOrThrow({ where: { xUserId: "777" } });
    expect(acc).toMatchObject({ username: "RealFounder", status: "ACTIVE", userId: uid });
    expect(acc.lastVerifiedAt).not.toBeNull();
    expect(acc.accessTokenEnc).not.toContain(ACCESS);
    expect(decrypt(acc.accessTokenEnc)).toBe(ACCESS);
    expect(decrypt(acc.refreshTokenEnc!)).toBe(REFRESH);
    expect(acc.scopes).toEqual(X_SCOPES);

    // no secret anywhere the browser or logs can see
    const visible = JSON.stringify([res.headers.get("location"), res.headers.get("set-cookie"), await prisma.activityLog.findMany()]);
    for (const secret of [ACCESS, REFRESH, "secret-xyz", s.verifier]) expect(visible).not.toContain(secret);
    expect(res.headers.get("set-cookie")).toMatch(/xom_oauth=;.*Max-Age=0/i); // one-time state cookie cleared
  });

  it("public client (no secret): no Basic header, client_id in body", async () => {
    process.env.X_CLIENT_SECRET = "";
    stubX();
    const s = await stateFor();
    await callback(cbRequest({ code: "c", state: s.state }, sealState(s)));
    const tok = calls.find((c) => c.url.includes("/oauth2/token"))!;
    expect((tok.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(new URLSearchParams(String(tok.init.body)).get("client_id")).toBe("client-abc");
  });

  it("reports X's token error clearly and stores nothing", async () => {
    stubX({ token: { status: 400, body: { error: "invalid_request", error_description: "Value passed for the redirect uri did not match" } } });
    const s = await stateFor();
    const res = await callback(cbRequest({ code: "c", state: s.state }, sealState(s)));
    expect(loc(res).searchParams.get("x")).toBe("token_failed");
    expect(loc(res).searchParams.get("detail")).toContain("redirect uri did not match");
    expect(await prisma.xAccount.count()).toBe(0);
  });

  it("rejects a forged/mismatched state without calling X", async () => {
    stubX();
    const s = await stateFor();
    const res = await callback(cbRequest({ code: "c", state: "attacker" }, sealState(s)));
    expect(loc(res).searchParams.get("x")).toBe("state_mismatch");
    expect(calls).toHaveLength(0);
    const res2 = await callback(cbRequest({ code: "c", state: s.state }));
    expect(loc(res2).searchParams.get("x")).toBe("state_missing");
  });

  it("handles the user pressing Cancel on X", async () => {
    stubX();
    const res = await callback(cbRequest({ error: "access_denied", state: "x" }));
    expect(loc(res).searchParams.get("x")).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  it("flags missing DM scopes instead of pretending it can send", async () => {
    stubX({ token: { status: 200, body: { access_token: ACCESS, expires_in: 7200, scope: "tweet.read users.read" } } });
    const s = await stateFor();
    const res = await callback(cbRequest({ code: "c", state: s.state }, sealState(s)));
    expect(loc(res).searchParams.get("x")).toBe("connected_limited");
    expect(loc(res).searchParams.get("detail")).toBe("dm.read dm.write offline.access");
  });

  it("reconnecting updates the same account (ledger/history keep their sender)", async () => {
    stubX();
    for (let i = 0; i < 2; i++) { const s = await stateFor(); await callback(cbRequest({ code: "c", state: s.state }, sealState(s))); }
    expect(await prisma.xAccount.count()).toBe(1);
  });

  it("is reachable through middleware without a session (X redirects cross-site)", async () => {
    const res = await middleware(new NextRequest(`${CB}?code=x&state=y`));
    expect(res.status).not.toBe(401);
    const blocked = await middleware(new NextRequest("http://localhost:3100/api/x/connect"));
    expect(blocked.status).toBe(401);
  });
});
