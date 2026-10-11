import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
async function main() {
  if (process.argv.includes("--if-empty") && (await prisma.user.count()) > 0) { console.log("Owner account exists — seed skipped"); return; }
  if (process.argv.includes("--if-empty") && !process.env.ADMIN_EMAIL) { console.log("ADMIN_EMAIL not set — seed skipped"); return; }
  const email = (process.env.ADMIN_EMAIL ?? "").toLowerCase();
  const pw = process.env.ADMIN_PASSWORD ?? "";
  if (!email || pw.length < 10) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ chars) in the environment");
  const passwordHash = await bcrypt.hash(pw, 12);
  await prisma.user.upsert({ where: { email }, create: { email, passwordHash }, update: { passwordHash } });
  console.log(`Owner account ready: ${email}`);
}
main().finally(() => prisma.$disconnect());
