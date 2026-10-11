/**
 * The address the BROWSER uses to reach this app. Behind a proxy (Render, Railway, nginx) `req.url` in a route
 * handler is the server's internal address (e.g. https://localhost:10000), so redirects must never be built from it.
 * Priority: APP_URL (explicit config) → RENDER_EXTERNAL_URL (set by Render) → forwarded/Host headers → req.url.
 */
export function publicOrigin(req: Request): string {
  const configured = process.env.APP_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || new URL(req.url).protocol.replace(":", "");
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

export const publicUrl = (req: Request, path: string) => new URL(path, publicOrigin(req) + "/");
