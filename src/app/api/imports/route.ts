import { NextRequest, NextResponse } from "next/server";
import { currentUser, rateLimit } from "@/lib/auth";
import { stageImport, MAX_IMPORT_BYTES } from "@/lib/import";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!(await currentUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await rateLimit("upload", 30, 3600))) return NextResponse.json({ error: "Upload rate limit reached" }, { status: 429 });
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.size > MAX_IMPORT_BYTES) return NextResponse.json({ error: "File too large (max 25 MB)" }, { status: 413 });
  try { return NextResponse.json(await stageImport(file.name, Buffer.from(await file.arrayBuffer()))); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
