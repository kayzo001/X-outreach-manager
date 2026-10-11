import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { OAUTH_COOKIE, buildAuthorizeUrl, newOAuthState, sealState } from "@/lib/oauth";
import { getXOAuthConfig } from "@/lib/x-config";
import { publicOrigin, publicUrl } from "@/lib/public-url";
import { logActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(publicUrl(req, "/login"));
  const cfg = await getXOAuthConfig(); // database credentials first, then .env fallback
  if (cfg.source === "none") return NextResponse.redirect(publicUrl(req, "/settings?x=missing_client"));
  if (cfg.error) return NextResponse.redirect(publicUrl(req, `/settings?x=config_error&detail=${encodeURIComponent(cfg.error)}`));
  // The browser must come back to the SAME host the callback is registered on, or the state cookie won't be sent.
  const appHost = new URL(publicOrigin(req)).host, cbHost = new URL(cfg.redirectUri).host;
  if (cbHost !== appHost) {
    return NextResponse.redirect(publicUrl(req, `/settings?x=host_mismatch&detail=${encodeURIComponent(`open the app at ${new URL(cfg.redirectUri).origin} (callback host) instead of ${appHost}`)}`));
  }
  const s = newOAuthState(user.id, cfg.fingerprint);
  await logActivity({ type: "oauth.started", message: "Started X OAuth connection" });
  const res = NextResponse.redirect(buildAuthorizeUrl(s, cfg));
  res.cookies.set(OAUTH_COOKIE, sealState(s), { httpOnly: true, secure: cfg.redirectUri.startsWith("https://"), sameSite: "lax", path: "/api/x", maxAge: 600 });
  return res;
}
