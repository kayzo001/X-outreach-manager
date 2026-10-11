import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { logActivity } from "@/lib/activity";
import { OAUTH_COOKIE, exchangeCode, fetchMe, missingScopes, openState } from "@/lib/oauth";
import { getXOAuthConfig } from "@/lib/x-config";
import { publicUrl } from "@/lib/public-url";

export const dynamic = "force-dynamic";

/**
 * Public route (X redirects here cross-site, so the login cookie may not be sent).
 * It authenticates itself with the encrypted, owner-bound, 10-minute state cookie created by /api/x/connect.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const back = (code: string, detail?: string) => {
    const url = publicUrl(req, "/settings");
    url.searchParams.set("x", code);
    if (detail) url.searchParams.set("detail", detail.slice(0, 300));
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, "", { path: "/api/x", maxAge: 0 });
    return res;
  };

  if (p.get("error")) {
    await logActivity({ type: "oauth.denied", level: "warn", message: `X authorisation not granted: ${p.get("error")}` });
    return back("denied", p.get("error_description") ?? p.get("error") ?? undefined);
  }
  const st = openState(req.cookies.get(OAUTH_COOKIE)?.value, p.get("state"));
  if (!st.ok) return back(`state_${st.reason}`);
  const code = p.get("code");
  if (!code) return back("denied", "X did not return an authorisation code");
  const user = await prisma.user.findUnique({ where: { id: st.s.uid } });
  if (!user) return back("state_tampered");
  const cfg = await getXOAuthConfig();
  if (cfg.source === "none") return back("missing_client");
  if (cfg.error) return back("config_error", cfg.error);
  // Credentials changed (saved/updated/deleted) after this handshake started: the code was issued to the OLD
  // configuration, so exchanging it with the new one would be wrong. Make the user start over.
  if (st.s.cfp !== cfg.fingerprint) {
    await logActivity({ type: "oauth.failed", level: "warn", message: "X OAuth aborted: developer credentials changed during the handshake" });
    return back("config_changed");
  }

  const ex = await exchangeCode(code, st.s.verifier, cfg);
  if (!ex.ok) {
    await logActivity({ type: "oauth.failed", level: "error", message: `X token exchange failed: ${ex.error}`, apiStatus: ex.status || null });
    return back("token_failed", `${ex.status || "network"}: ${ex.error}`);
  }
  const me = await fetchMe(ex.tokens.access_token);
  if (!me.ok) {
    await logActivity({ type: "oauth.failed", level: "error", message: `Reading your X profile failed: ${me.error}`, apiStatus: me.status || null });
    return back("me_failed", `${me.status || "network"}: ${me.error}`);
  }

  const scopes = (ex.tokens.scope ?? "").split(/\s+/).filter(Boolean);
  const now = new Date();
  const data = {
    username: me.username, status: "ACTIVE" as const, scopes, lastVerifiedAt: now, lastError: null, oauthClientId: cfg.clientId,
    accessTokenEnc: encrypt(ex.tokens.access_token), tokenExpiresAt: new Date(now.getTime() + (ex.tokens.expires_in ?? 7200) * 1000),
  };
  await prisma.xAccount.upsert({
    where: { xUserId: me.id },
    create: { ...data, userId: user.id, xUserId: me.id, refreshTokenEnc: ex.tokens.refresh_token ? encrypt(ex.tokens.refresh_token) : null },
    update: { ...data, refreshTokenEnc: ex.tokens.refresh_token ? encrypt(ex.tokens.refresh_token) : undefined },
  });
  const missing = missingScopes(scopes);
  await logActivity({ type: "oauth.connected", level: missing.length ? "warn" : "info", message: `Connected X account @${me.username}${missing.length ? ` (missing scopes: ${missing.join(", ")})` : ""}` });
  return missing.length ? back("connected_limited", missing.join(" ")) : back("connected", `@${me.username}`);
}
