import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/session";

// /api/x/callback authenticates itself via the encrypted OAuth state cookie (see route).
const PUBLIC = ["/login", "/api/auth/login", "/api/health", "/api/x/callback"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Production: never serve (or accept credentials) over plain http behind the host's TLS proxy.
  if (process.env.NODE_ENV === "production" && req.headers.get("x-forwarded-proto") === "http") {
    const url = req.nextUrl.clone(); url.protocol = "https:";
    return NextResponse.redirect(url, 308);
  }
  if (PUBLIC.some((p) => pathname === p)) return withSecurity(req, NextResponse.next());

  // CSRF defence-in-depth for state-changing API calls: Origin must match Host (cookies are also SameSite=Strict).
  if (pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) return new NextResponse("Bad origin", { status: 403 });
  }

  const ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!ok) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const url = req.nextUrl.clone(); url.pathname = "/login"; url.search = "";
    return NextResponse.redirect(url);
  }
  return withSecurity(req, NextResponse.next());
}

function withSecurity(_req: NextRequest, res: NextResponse) {
  res.headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://pbs.twimg.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://x.com");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
