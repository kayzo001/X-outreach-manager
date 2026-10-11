import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/auth";
import { SESSION_COOKIE, SESSION_TTL_S, signSession } from "@/lib/session";
import { logActivity } from "@/lib/activity";

const DUMMY = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO5H3pQ5x3p9QG0Vbq2w6k7m9R7q1W1iK";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!(await rateLimit(`login:${ip}`, 10, 15 * 60))) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY); // constant-ish time even for unknown emails
  if (!user || !ok) {
    await logActivity({ type: "auth.failed", level: "warn", message: "Failed login attempt", meta: { ip } });
    return NextResponse.redirect(new URL("/login?error=1", req.url), 303);
  }
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(SESSION_COOKIE, await signSession(user.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_TTL_S });
  return res;
}
