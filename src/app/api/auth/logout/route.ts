import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { publicUrl } from "@/lib/public-url";

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(publicUrl(req, "/login"), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
