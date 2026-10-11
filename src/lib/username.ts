/** X usernames: 1–15 chars, letters/digits/underscore. Case-insensitive. */
const USERNAME_RE = /^[a-z0-9_]{1,15}$/;
const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const RESERVED_PATHS = new Set(["home", "i", "intent", "search", "explore", "settings", "messages", "notifications", "share", "hashtag", "login", "signup", "compose", "tos", "privacy"]);

export type UsernameResult = { ok: true; username: string } | { ok: false; reason: string };

export function normalizeUsername(input: unknown): UsernameResult {
  if (input === null || input === undefined) return { ok: false, reason: "Empty username" };
  let s = String(input).trim();
  if (!s) return { ok: false, reason: "Empty username" };

  if (/^(https?:\/\/|www\.|(x|twitter)\.com\/)/i.test(s)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return { ok: false, reason: "Malformed URL" }; }
    if (!X_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: "URL is not an X/Twitter profile" };
    const seg = url.pathname.split("/").filter(Boolean)[0];
    if (!seg) return { ok: false, reason: "URL has no profile path" };
    if (RESERVED_PATHS.has(seg.toLowerCase())) return { ok: false, reason: "URL is not a profile page" };
    s = seg;
  }
  s = s.replace(/^@+/, "").trim().toLowerCase();
  if (!s) return { ok: false, reason: "Empty username" };
  if (!USERNAME_RE.test(s)) {
    if (s.length > 15) return { ok: false, reason: "Username longer than 15 characters" };
    return { ok: false, reason: "Username contains invalid characters" };
  }
  return { ok: true, username: s };
}

export const profileUrl = (username: string) => `https://x.com/${username}`;
