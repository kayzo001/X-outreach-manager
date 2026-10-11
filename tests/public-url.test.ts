import { afterEach, describe, expect, it } from "vitest";
import { publicOrigin, publicUrl } from "@/lib/public-url";

const internal = (headers: Record<string, string> = {}) => new Request("https://localhost:10000/api/auth/login", { headers });
const saved = { APP_URL: process.env.APP_URL, RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL };
afterEach(() => { process.env.APP_URL = saved.APP_URL; process.env.RENDER_EXTERNAL_URL = saved.RENDER_EXTERNAL_URL; if (saved.APP_URL === undefined) delete process.env.APP_URL; if (saved.RENDER_EXTERNAL_URL === undefined) delete process.env.RENDER_EXTERNAL_URL; });

describe("public redirect origin (behind Render's proxy)", () => {
  it("never redirects to the internal localhost:10000 address on Render", () => {
    delete process.env.APP_URL; process.env.RENDER_EXTERNAL_URL = "https://xom-web.onrender.com";
    expect(publicUrl(internal(), "/login?error=1").toString()).toBe("https://xom-web.onrender.com/login?error=1");
    expect(publicUrl(internal(), "/").toString()).toBe("https://xom-web.onrender.com/");
  });
  it("APP_URL (custom domain) wins over Render's URL", () => {
    process.env.APP_URL = "https://outreach.example.com/"; process.env.RENDER_EXTERNAL_URL = "https://xom-web.onrender.com";
    expect(publicOrigin(internal())).toBe("https://outreach.example.com");
  });
  it("falls back to forwarded headers, then the Host header", () => {
    delete process.env.APP_URL; delete process.env.RENDER_EXTERNAL_URL;
    expect(publicOrigin(internal({ "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" }))).toBe("https://app.example.com");
    expect(publicOrigin(new Request("http://localhost:3100/x", { headers: { host: "localhost:3100" } }))).toBe("http://localhost:3100");
  });
});
