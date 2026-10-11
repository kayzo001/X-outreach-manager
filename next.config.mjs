import path from "path";
import { fileURLToPath } from "url";
const root = path.dirname(fileURLToPath(import.meta.url));
/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];
export default {
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["bullmq", "ioredis", "bcryptjs"],
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  webpack(config) { config.resolve.alias["@"] = path.join(root, "src"); return config; },
  async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; },
};
