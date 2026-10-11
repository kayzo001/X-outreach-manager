import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { commitImport } from "@/lib/import";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const { campaignId } = await req.json().catch(() => ({}));
    return NextResponse.json(await commitImport(id, { campaignId: campaignId || null }));
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
