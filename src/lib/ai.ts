import type { Contact } from "@prisma/client";

const SYSTEM = `You draft short, honest direct messages for a content-marketing agency's outreach to SaaS founders.
Rules you must follow:
- Use ONLY the facts provided in <lead>. Never invent, assume or embellish facts about the person, their product, revenue or audience. If a fact is missing, leave it out.
- Be clearly a business message from a real person at a content agency. Never pretend to be a customer, fan, or someone with a prior relationship. No fake urgency.
- 280 characters or fewer unless asked. Plain text, no emojis spam, no hashtags, no links unless provided.
- If told the recipient opted in, you may reference what they opted in to. Always end with a simple way to decline (e.g. "Reply STOP and I won't message again").
- Output the message text only.`;

export async function draftWithClaude(c: Pick<Contact, "usernameDisplay" | "founderName" | "company" | "product" | "industry" | "customHook" | "bio" | "mrr" | "mrrKind">, opts: { sender: string; offer: string; optedInScope?: string | null }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY on the server to enable AI drafting");
  const facts = [
    c.founderName && `Name: ${c.founderName}`, c.company && `Company: ${c.company}`, c.product && `Product: ${c.product}`, c.industry && `Category: ${c.industry}`,
    c.customHook && `Verified personal hook: ${c.customHook}`, c.bio && `Public bio: ${c.bio.slice(0, 300)}`,
    c.mrr != null && `Revenue (${c.mrrKind === "VERIFIED" ? "verified" : "self-reported, unverified — do not state as fact"}): $${c.mrr}/mo`,
  ].filter(Boolean).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5", max_tokens: 400, system: SYSTEM,
      messages: [{ role: "user", content: `<sender>${opts.sender}</sender>\n<offer>${opts.offer}</offer>\n<opt_in>${opts.optedInScope ? `Recipient opted in to: ${opts.optedInScope}` : "No opt-in on file — this will be sent manually by a human"}</opt_in>\n<lead>\n${facts || "(no facts available)"}\n</lead>\nWrite the DM.` }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}`);
  const j = (await res.json()) as { content: { type: string; text?: string }[] };
  return j.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
