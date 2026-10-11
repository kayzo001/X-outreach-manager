import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redis } from "@/lib/queue";

export const dynamic = "force-dynamic";
export async function GET() {
  const [db, rd] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redis().ping().then(() => true).catch(() => false),
  ]);
  return NextResponse.json({ ok: db && rd, db, redis: rd }, { status: db && rd ? 200 : 503 });
}
