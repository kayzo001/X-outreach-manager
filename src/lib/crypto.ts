import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

export class CredentialKeyError extends Error {}

/** 64 hex chars are used as-is; any other secret of 32+ chars is stretched with SHA-256 (lets hosts like Render auto-generate it). */
function keyFrom(raw: string | undefined, name: string): Buffer {
  const v = (raw ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  if (v.length >= 32) return createHash("sha256").update(v).digest();
  throw new CredentialKeyError(`${name} must be set (64 hex chars from \`openssl rand -hex 32\`, or any random secret of 32+ characters)`);
}
const key = () => keyFrom(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1") throw new Error("Unsupported ciphertext version");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ───────── Integration credentials (separate key, purpose-bound) ─────────

const credentialsKey = () => keyFrom(process.env.CREDENTIALS_ENCRYPTION_KEY, "CREDENTIALS_ENCRYPTION_KEY");
export const credentialsKeyConfigured = () => { try { credentialsKey(); return true; } catch { return false; } };

/** AES-256-GCM with the purpose as additional authenticated data: a ciphertext can't be replayed into another field. */
export function encryptCredential(plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", credentialsKey(), iv);
  c.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["c1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptCredential(blob: string, purpose: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "c1") throw new Error("Unsupported credential ciphertext version");
  const d = createDecipheriv("aes-256-gcm", credentialsKey(), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(purpose));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
