import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "xom_session";
export const SESSION_TTL_S = 60 * 60 * 24 * 7;

const key = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return new TextEncoder().encode(s);
};

export async function signSession(userId: string) {
  return new SignJWT({ uid: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${SESSION_TTL_S}s`).sign(key());
}

export async function verifySession(token?: string | null): Promise<{ uid: string } | null> {
  if (!token) return null;
  try { const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] }); return typeof payload.uid === "string" ? { uid: payload.uid } : null; }
  catch { return null; }
}
