import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const filterSchema = z.object({
  op: z.enum(["AND", "OR"]).default("AND"),
  conditions: z.array(z.object({ field: z.string(), operator: z.string(), value: z.any().optional() })).default([]),
  q: z.string().optional(),
});
export type FilterDef = z.infer<typeof filterSchema>;

export const FILTER_FIELDS: { field: string; label: string; type: "text" | "number" | "enum" | "bool" | "campaign"; options?: string[] }[] = [
  { field: "company", label: "Company", type: "text" },
  { field: "industry", label: "SaaS category", type: "text" },
  { field: "mrr", label: "Reported MRR ($)", type: "number" },
  { field: "mrrKind", label: "Revenue source", type: "enum", options: ["VERIFIED", "SELF_REPORTED", "UNKNOWN"] },
  { field: "country", label: "Country", type: "text" },
  { field: "language", label: "Language", type: "text" },
  { field: "followers", label: "Followers", type: "number" },
  { field: "verified", label: "Verified account", type: "bool" },
  { field: "lastActiveAt", label: "Active in last N days", type: "number" },
  { field: "leadSource", label: "Lead source", type: "text" },
  { field: "consentScope", label: "Opted in to (scope contains)", type: "text" },
  { field: "consentStatus", label: "Consent status", type: "enum", options: ["UNKNOWN", "NOT_OPTED_IN", "OPTED_IN", "EXPIRED", "OPTED_OUT"] },
  { field: "hasConversation", label: "Existing conversation", type: "bool" },
  { field: "previouslyMessaged", label: "Previously messaged", type: "bool" },
  { field: "replied", label: "Replied", type: "bool" },
  { field: "optedOut", label: "Opted out", type: "bool" },
  { field: "customerStatus", label: "Customer status", type: "enum", options: ["NONE", "INTERESTED", "NOT_INTERESTED", "POTENTIAL_CUSTOMER", "CUSTOMER"] },
  { field: "campaign", label: "In campaign", type: "campaign" },
  { field: "score", label: "Lead score ≥", type: "number" },
  { field: "tag", label: "Tag", type: "text" },
];

const num = (v: unknown) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const bool = (v: unknown) => v === true || v === "true";

function condition(c: { field: string; operator: string; value?: unknown }): Prisma.ContactWhereInput | null {
  const v = c.value;
  const textOp = (field: "company" | "industry" | "country" | "language" | "leadSource"): Prisma.ContactWhereInput =>
    c.operator === "equals" ? { [field]: { equals: String(v), mode: "insensitive" } } : c.operator === "not_contains" ? { NOT: { [field]: { contains: String(v), mode: "insensitive" } } } : c.operator === "empty" ? { OR: [{ [field]: null }, { [field]: "" }] } : { [field]: { contains: String(v), mode: "insensitive" } };
  switch (c.field) {
    case "company": case "industry": case "country": case "language": case "leadSource": return c.operator === "empty" || v ? textOp(c.field) : null;
    case "mrr": case "followers": {
      const n = num(v); if (isNaN(n)) return null;
      return { [c.field]: c.operator === "lt" ? { lt: n } : c.operator === "eq" ? { equals: n } : { gt: n } };
    }
    case "mrrKind": return v ? (c.operator === "is_not" ? { mrrKind: { not: v as never } } : { mrrKind: v as never }) : null;
    case "consentScope": return v ? { consents: { some: { status: "OPTED_IN", scope: { contains: String(v), mode: "insensitive" } } } } : null;
    case "verified": return { verified: bool(v) };
    case "lastActiveAt": { const n = num(v); return isNaN(n) ? null : { lastActiveAt: { gte: new Date(Date.now() - n * 86_400_000) } }; }
    case "consentStatus": return v ? (c.operator === "is_not" ? { consentStatus: { not: v as never } } : { consentStatus: v as never }) : null;
    case "customerStatus": return v ? (c.operator === "is_not" ? { customerStatus: { not: v as never } } : { customerStatus: v as never }) : null;
    case "hasConversation": return bool(v) ? { conversations: { some: {} } } : { conversations: { none: {} } };
    case "previouslyMessaged": return bool(v) ? { historyStatus: "CONTACTED" } : { historyStatus: { not: "CONTACTED" } };
    case "replied": return bool(v) ? { OR: [{ manualStatus: "REPLIED" }, { conversations: { some: { replied: true } } }] } : { AND: [{ OR: [{ manualStatus: null }, { manualStatus: { not: "REPLIED" } }] }, { conversations: { none: { replied: true } } }] };
    case "optedOut": return bool(v) ? { OR: [{ consentStatus: "OPTED_OUT" }, { doNotContact: true }] } : { consentStatus: { not: "OPTED_OUT" }, doNotContact: false };
    case "campaign": return v ? { campaigns: { some: { campaignId: String(v) } } } : null;
    case "score": { const n = num(v); return isNaN(n) ? null : { score: { score: { gte: n } } }; }
    case "tag": return v ? { tags: { some: { tag: { name: { equals: String(v), mode: "insensitive" } } } } } : null;
  }
  return null;
}

export function buildWhere(def: FilterDef): Prisma.ContactWhereInput {
  const conds = def.conditions.map(condition).filter((x): x is Prisma.ContactWhereInput => !!x);
  const parts: Prisma.ContactWhereInput[] = [];
  if (conds.length) parts.push(def.op === "OR" ? { OR: conds } : { AND: conds });
  if (def.q?.trim()) {
    const q = def.q.trim().replace(/^@/, "");
    parts.push({ OR: [{ usernameNormalized: { contains: q.toLowerCase() } }, { company: { contains: q, mode: "insensitive" } }, { founderName: { contains: q, mode: "insensitive" } }] });
  }
  return parts.length ? { AND: parts } : {};
}
