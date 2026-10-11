import { prisma } from "./db";
import type { Contact } from "@prisma/client";

export interface Factor { key: string; label: string; max: number; points: number; status: "met" | "not_met" | "unknown"; detail: string }
export interface ScoreResult { score: number; factors: Factor[]; incomplete: boolean; knownSignals: number; totalSignals: number }

const has = (s: string | null | undefined, re: RegExp) => !!s && re.test(s);
const cf = (c: Contact) => (c.customFields ?? {}) as Record<string, unknown>;
const truthy = (v: unknown) => v === true || (typeof v === "string" && /^(1|true|yes|y)$/i.test(v));
const monthsAgo = (d: Date) => (Date.now() - d.getTime()) / (30 * 86_400_000);

export const WEIGHTS = { founder: 15, saas: 15, revenue: 20, active: 10, video: 10, marketing: 5, team: 5, suitability: 10, milestone: 5, launch: 5 } as const;

/** Pure function. Missing data scores 0 and is flagged "unknown" — never guessed. */
export function scoreContact(c: Contact): ScoreResult {
  const f: Factor[] = [];
  const add = (key: keyof typeof WEIGHTS, label: string, status: Factor["status"], detail: string, frac = 1) =>
    f.push({ key, label, max: WEIGHTS[key], points: status === "met" ? Math.round(WEIGHTS[key] * frac) : 0, status, detail });
  const x = cf(c);

  add("founder", "Founder-led business", c.bio ? (has(c.bio, /\b(founder|co-?founder|ceo|indie ?hacker|building|maker|bootstrapp)/i) ? "met" : "not_met") : "unknown", c.bio ? "From bio" : "No bio on record");

  const saasText = [c.industry, c.bio, c.product].filter(Boolean).join(" ");
  if (!saasText) add("saas", "SaaS (not unrelated apps)", "unknown", "No industry/bio/product");
  else if (has(saasText, /\bgames?\b|gaming/i) && !has(saasText, /saas/i)) add("saas", "SaaS (not unrelated apps)", "not_met", "Looks like gaming");
  else add("saas", "SaaS (not unrelated apps)", has(saasText, /saas|software|\bapi\b|platform|b2b|tool|\bapp\b|\bai\b/i) ? "met" : "not_met", "From industry/bio/product");

  if (c.mrr == null) add("revenue", "Meaningful revenue", "unknown", "No revenue data");
  else {
    const verified = c.mrrKind === "VERIFIED";
    const tier = c.mrr >= 10_000 ? 1 : c.mrr >= 1_000 ? 0.4 : 0;
    // Self-reported figures earn at most 60% of the revenue weight.
    add("revenue", "Meaningful revenue", tier > 0 ? "met" : "not_met", `$${c.mrr.toLocaleString()} MRR (${verified ? "verified" : "self-reported"})`, tier * (verified ? 1 : 0.6));
  }

  add("active", "Active founder account", c.lastActiveAt ? (monthsAgo(c.lastActiveAt) <= 1 ? "met" : "not_met") : "unknown", c.lastActiveAt ? `Last active ${c.lastActiveAt.toISOString().slice(0, 10)}` : "Activity unknown");

  const videoFlag = x.produces_video;
  if (videoFlag !== undefined) add("video", "Produces video content", truthy(videoFlag) ? "met" : "not_met", "From import data");
  else if (c.bio) add("video", "Produces video content", has(c.bio, /\b(youtube|video|vlog|creator|stream)/i) ? "met" : "unknown", has(c.bio, /\b(youtube|video|vlog|creator|stream)/i) ? "Bio mentions video" : "No evidence either way");
  else add("video", "Produces video content", "unknown", "No data");

  const mk = x.marketing_activity;
  if (mk !== undefined) add("marketing", "Existing marketing activity", truthy(mk) ? "met" : "not_met", "From import data");
  else add("marketing", "Existing marketing activity", c.bio ? (has(c.bio, /marketing|growth|content/i) ? "met" : "unknown") : "unknown", "Bio keyword check only");

  const team = Number(x.team_size);
  add("team", "Small internal team (≤10)", Number.isFinite(team) && x.team_size !== undefined ? (team <= 10 ? "met" : "not_met") : "unknown", Number.isFinite(team) ? `Team size ${team}` : "Team size unknown");

  add("suitability", "Product suits short-form video", c.industry ? (has(c.industry, /design|creator|productivity|marketing|\bai\b|education|e-?commerce|fitness|social|video|consumer|no-?code/i) ? "met" : "not_met") : "unknown", c.industry ? `Industry: ${c.industry}` : "Industry unknown");

  add("milestone", "Funding / growth milestone", x.milestone ? "met" : "unknown", x.milestone ? String(x.milestone).slice(0, 80) : "None recorded");

  const launched = x.launched_at ? new Date(String(x.launched_at)) : null;
  add("launch", "Recent product launch", launched && !isNaN(+launched) ? (monthsAgo(launched) <= 6 ? "met" : "not_met") : "unknown", launched && !isNaN(+launched) ? `Launched ${launched.toISOString().slice(0, 10)}` : "Launch date unknown");

  const known = f.filter((x2) => x2.status !== "unknown").length;
  return { score: Math.min(100, f.reduce((a, b) => a + b.points, 0)), factors: f, incomplete: known < f.length, knownSignals: known, totalSignals: f.length };
}

export async function rescoreContacts(ids?: string[]) {
  const contacts = await prisma.contact.findMany({ where: ids ? { id: { in: ids } } : {} });
  for (let i = 0; i < contacts.length; i += 200) {
    await Promise.all(contacts.slice(i, i + 200).map((c) => {
      const r = scoreContact(c);
      return prisma.leadScore.upsert({ where: { contactId: c.id }, create: { contactId: c.id, score: r.score, factors: r.factors as never, incomplete: r.incomplete }, update: { score: r.score, factors: r.factors as never, incomplete: r.incomplete, computedAt: new Date() } });
    }));
  }
  return contacts.length;
}
