import { prisma } from "./db";
import { logActivity } from "./activity";
import { providerFor, DmProvider } from "./provider";
import { checkContactHistory } from "./sync";

/** Resolve usernames → numeric X IDs (the stable identifier). Prioritises contacts in active/draft campaigns. */
/** scope "all" = explicit button / tests; the worker passes the cost-limited scope from settings. */
export async function resolvePending(accountId: string, limit = 100, providerOverride?: DmProvider, scope: "opted_in" | "campaigns" | "all" = "all") {
  const acc = await prisma.xAccount.findUnique({ where: { id: accountId } });
  if (!acc || acc.status !== "ACTIVE") return { resolved: 0, failed: 0, conflicts: 0 };
  const provider = providerOverride ?? providerFor(acc);
  const contacts = await prisma.contact.findMany({
    where: { resolveStatus: "UNRESOLVED", xUserId: null, doNotContact: false, ...(scope === "opted_in" ? { consentStatus: "OPTED_IN" as const } : scope === "campaigns" ? { campaigns: { some: { campaign: { status: { in: ["ACTIVE", "DRAFT", "PAUSED"] as ("ACTIVE" | "DRAFT" | "PAUSED")[] } } } } } : {}) },
    orderBy: [{ campaigns: { _count: "desc" } }, { createdAt: "asc" }], take: limit,
  });
  if (!contacts.length) return { resolved: 0, failed: 0, conflicts: 0 };
  const res = await provider.resolveUsers({ id: acc.id, xUserId: acc.xUserId, username: acc.username }, contacts.map((c) => c.usernameNormalized));
  const byName = new Map(res.map((r) => [r.username, r]));
  let resolved = 0, failed = 0, conflicts = 0;
  const newlyResolved: string[] = [];
  for (const c of contacts) {
    const r = byName.get(c.usernameNormalized);
    if (!r || r.status === "error") continue; // transient; try again next time
    if (r.status === "not_found" || r.status === "suspended") {
      await prisma.contact.update({ where: { id: c.id }, data: { resolveStatus: r.status === "suspended" ? "SUSPENDED" : "NOT_FOUND" } });
      await logActivity({ type: "contact.resolve_failed", level: "warn", message: `@${c.usernameNormalized}: account ${r.status === "suspended" ? "suspended" : "not found / deleted"}`, contactId: c.id, errorCategory: r.status.toUpperCase() });
      failed++; continue;
    }
    const clash = await prisma.contact.findUnique({ where: { xUserId: r.id! } });
    if (clash && clash.id !== c.id) { // same X account under two usernames (rename): refuse to merge silently
      await logActivity({ type: "contact.identity_conflict", level: "warn", message: `@${c.usernameNormalized} resolves to the same X ID as @${clash.usernameNormalized}. Review and merge manually.`, contactId: c.id });
      conflicts++; continue;
    }
    await prisma.contact.update({
      where: { id: c.id },
      data: {
        xUserId: r.id, resolveStatus: "RESOLVED", verified: r.verified ?? undefined, followers: r.followers ?? undefined,
        founderName: c.founderName ?? r.name ?? undefined, bio: c.bio ?? r.description ?? undefined, location: c.location ?? r.location ?? undefined,
      },
    });
    await prisma.contactIdentifier.createMany({ skipDuplicates: true, data: [{ contactId: c.id, type: "X_USER_ID", value: r.id! }] });
    resolved++; newlyResolved.push(c.id);
  }
  // Their older threads may predate our incremental sync window — check each one directly.
  if (newlyResolved.length && acc.lastSyncAt) await checkContactHistory(acc.id, newlyResolved, provider);
  return { resolved, failed, conflicts };
}
