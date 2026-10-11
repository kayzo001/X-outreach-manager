import nodemailer from "nodemailer";
import { prisma } from "./db";
import { getSettings } from "./settings";

/** In-app notification, plus an email when SMTP_URL and a notify address are configured. */
export async function notify(type: string, title: string, body?: string, contactId?: string) {
  await prisma.notification.create({ data: { type, title, body, contactId } });
  const to = (await getSettings()).notifyEmail ?? process.env.NOTIFY_EMAIL;
  if (!process.env.SMTP_URL || !to) return;
  try {
    await nodemailer.createTransport(process.env.SMTP_URL).sendMail({ from: process.env.NOTIFY_FROM ?? to, to, subject: `[X Outreach] ${title}`, text: body ?? title });
  } catch (e) {
    console.error("[notify] email failed:", (e as Error).message);
  }
}
