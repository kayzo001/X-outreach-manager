import { describe, expect, it } from "vitest";
import { normalizeUsername } from "@/lib/username";

const ok = (s: string) => { const r = normalizeUsername(s); return r.ok ? r.username : null; };
describe("username normalization", () => {
  it("strips @ and lowercases", () => { expect(ok("@JohnDoe")).toBe("johndoe"); expect(ok("@@a_b")).toBe("a_b"); });
  it("trims whitespace", () => expect(ok("  Foo  ")).toBe("foo"));
  it("extracts from profile URLs", () => {
    expect(ok("https://x.com/Alice")).toBe("alice");
    expect(ok("https://twitter.com/Bob?ref=1")).toBe("bob");
    expect(ok("x.com/carol/")).toBe("carol");
    expect(ok("https://www.twitter.com/dave/status/123")).toBe("dave");
  });
  it("rejects invalid input", () => {
    for (const bad of ["", "   ", "a b", "toolongusername12345", "bad-name", "名前", "https://example.com/foo", "https://x.com/", "https://x.com/home", "http://"]) expect(normalizeUsername(bad).ok, bad).toBe(false);
  });
  it("rejects malformed URLs with a reason", () => {
    const r = normalizeUsername("https://");
    expect(r.ok).toBe(false);
  });
});
