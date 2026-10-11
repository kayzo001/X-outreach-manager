import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { rejectedRowsCsv } from "@/lib/import";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  return new NextResponse(await rejectedRowsCsv(id), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="rejected-rows-${id}.csv"` } });
}
