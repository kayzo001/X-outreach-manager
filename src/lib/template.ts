import { sha256 } from "./crypto";

export const TEMPLATE_VARS = ["first_name", "company", "product", "industry", "custom_hook", "username", "founder_name"] as const;
export const MAX_DM_LENGTH = 10000; // X API DM text limit (documented as 10,000 chars)

export interface TemplateContact {
  usernameDisplay: string;
  founderName?: string | null;
  company?: string | null;
  product?: string | null;
  industry?: string | null;
  customHook?: string | null;
}

export function variablesFor(c: TemplateContact): Record<string, string | undefined> {
  const first = c.founderName?.trim().split(/\s+/)[0];
  return {
    first_name: first || undefined,
    founder_name: c.founderName?.trim() || undefined,
    company: c.company?.trim() || undefined,
    product: c.product?.trim() || undefined,
    industry: c.industry?.trim() || undefined,
    custom_hook: c.customHook?.trim() || undefined,
    username: c.usernameDisplay,
  };
}

export function usedVariables(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
}

export interface RenderResult { text: string; missing: string[]; unknown: string[]; length: number; complete: boolean }

/** Never invents data: a missing variable is reported, never filled with a guess. */
export function renderTemplate(template: string, contact: TemplateContact): RenderResult {
  const vars = variablesFor(contact);
  const missing: string[] = [];
  const unknown: string[] = [];
  const text = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (full, name: string) => {
    if (!(TEMPLATE_VARS as readonly string[]).includes(name)) { unknown.push(name); return full; }
    const v = vars[name];
    if (!v) { missing.push(name); return full; }
    return v;
  });
  return { text, missing: [...new Set(missing)], unknown: [...new Set(unknown)], length: text.length, complete: missing.length === 0 && unknown.length === 0 };
}

export const normalizeBody = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export const bodyHash = (s: string) => sha256(normalizeBody(s));

function trigrams(s: string): Set<string> {
  const t = normalizeBody(s).replace(/[^a-z0-9 ]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of character trigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Flags near-identical rendered messages — X treats mass identical DMs as spam. */
export function findNearDuplicates(messages: { id: string; text: string }[], threshold = 0.9): { a: string; b: string; score: number }[] {
  const out: { a: string; b: string; score: number }[] = [];
  const cap = Math.min(messages.length, 400);
  for (let i = 0; i < cap; i++) for (let j = i + 1; j < cap; j++) {
    const s = similarity(messages[i].text, messages[j].text);
    if (s >= threshold) out.push({ a: messages[i].id, b: messages[j].id, score: s });
  }
  return out;
}
