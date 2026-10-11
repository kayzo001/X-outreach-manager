import Papa from "papaparse";
import { normalizeUsername } from "./username";

/** Contact fields a CSV column can map to. */
export const IMPORT_FIELDS = [
  "username", "founder_name", "company", "website", "product", "mrr", "industry", "location", "country", "language",
  "followers", "bio", "message", "notes", "campaign", "source_url", "consent_status", "custom_hook", "verified",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, string>>; // field -> csv header

const ALIASES: Record<ImportField, string[]> = {
  username: ["username", "handle", "x_username", "twitter", "twitter_handle", "x_handle", "x", "profile", "profile_url", "url", "user"],
  founder_name: ["founder_name", "founder", "name", "full_name"],
  company: ["company", "company_name", "startup", "org"],
  website: ["website", "site", "domain"],
  product: ["product", "product_name"],
  mrr: ["mrr", "revenue", "monthly_revenue"],
  industry: ["industry", "category", "saas_category", "vertical"],
  location: ["location", "city"],
  country: ["country"],
  language: ["language", "lang"],
  followers: ["followers", "follower_count"],
  bio: ["bio", "description"],
  message: ["message", "custom_message", "dm"],
  notes: ["notes", "note", "comments"],
  campaign: ["campaign", "campaign_name"],
  source_url: ["source_url", "source", "source_link"],
  consent_status: ["consent_status", "consent", "opt_in"],
  custom_hook: ["custom_hook", "hook", "personal_hook"],
  verified: ["verified", "is_verified"],
};

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function autoDetectMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<string>();
  // The first column is `username` per spec; fall back to alias matching.
  for (const field of IMPORT_FIELDS) {
    const hit = headers.find((h) => !used.has(h) && ALIASES[field].includes(norm(h)));
    if (hit) { m[field] = hit; used.add(hit); }
  }
  if (!m.username && headers[0]) m.username = headers[0];
  return m;
}

export type RawRow = Record<string, string>;

export function parseCsvText(text: string): { headers: string[]; rows: RawRow[] } {
  const res = Papa.parse<RawRow>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const headers = (res.meta.fields ?? []).filter((h) => h !== "");
  return { headers, rows: res.data };
}

export interface MappedRow {
  username: string | null;
  usernameError?: string;
  fields: Partial<Record<ImportField, string>>;
}

export function mapRow(raw: RawRow, mapping: Mapping): MappedRow {
  const fields: Partial<Record<ImportField, string>> = {};
  for (const f of IMPORT_FIELDS) {
    const col = mapping[f];
    if (!col) continue;
    const v = raw[col];
    if (v !== undefined && v !== null && String(v).trim() !== "") fields[f] = String(v).trim();
  }
  const n = normalizeUsername(fields.username);
  return n.ok ? { username: n.username, fields } : { username: null, usernameError: n.reason, fields };
}

export function parseMrr(v?: string): number | null {
  if (!v) return null;
  const m = v.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2]?.toLowerCase() === "k") n *= 1_000;
  if (m[2]?.toLowerCase() === "m") n *= 1_000_000;
  return Math.round(n);
}

export function parseIntSafe(v?: string): number | null {
  if (!v) return null;
  const m = parseMrr(v);
  return m;
}

/** Neutralise spreadsheet formula injection for any CSV we export. */
export function safeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = safeCell(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
}
