import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redis } from "@/lib/queue";

export const dynamic = "force-dynamic";
export async function GET() {
  const [db, rd] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redis().ping().then(() => true).catch(() => false),
  ]);
  // Commit id only (public anyway on GitHub) so deploys can be verified without logging in.
  const version = (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7);
  return NextResponse.json({ ok: db && rd, db, redis: rd, version }, { status: db && rd ? 200 : 503 });
}
