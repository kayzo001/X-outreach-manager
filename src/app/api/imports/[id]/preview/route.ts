import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { previewImport } from "@/lib/import";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const { mapping } = await req.json();
    const counts = await previewImport(id, mapping);
    const sample = await prisma.csvImportRow.findMany({ where: { importId: id }, orderBy: { rowNumber: "asc" }, take: 25, select: { rowNumber: true, status: true, reason: true, usernameNormalized: true } });
    return NextResponse.json({ counts, sample });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
