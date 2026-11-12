/**
 * Checks a Supabase sign-in token (JWT) on this server with the project's
 * published signing keys (JWKS), instead of asking Supabase over the network
 * on every request. Supabase signs with ES256; the public keys come from
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` and are cached.
 *
 * Returns the user id, null when the token is invalid or expired, or
 * "unverifiable" when this server cannot check it locally (an older HS256
 * token, an unknown key, keys unreachable): the caller then asks Supabase.
 * Access is still checked against the database on every request, so a login
 * the owner stops is refused at once.
 */
type Jwk = JsonWebKey & { kid?: string; alg?: string };

const KEYS_TTL_MS = 10 * 60_000;
let cachedKeys: { url: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

const base64UrlBytes = (value: string) => Uint8Array.from(Buffer.from(value, "base64url"));
const decodeJson = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;

async function importKeys(jwks: Jwk[]) {
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks) {
    if (!jwk.kid || jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
    } catch {
      // A key this server cannot use is skipped; tokens signed with it fall back to Supabase.
    }
  }
  return keys;
}

async function signingKeys(supabaseUrl: string, refresh = false) {
  const url = `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
  if (!refresh && cachedKeys?.url === url && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS) return cachedKeys.keys;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Signing keys unavailable (${response.status}).`);
  const body = await response.json() as { keys?: Jwk[] };
  cachedKeys = { url, fetchedAt: Date.now(), keys: await importKeys(body.keys ?? []) };
  return cachedKeys.keys;
}

/** For tests: use these keys instead of fetching them. */
export async function setSigningKeysForTest(supabaseUrl: string, jwks: Jwk[]) {
  cachedKeys = { url: `${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`, fetchedAt: Date.now(), keys: await importKeys(jwks) };
}

export async function verifySupabaseToken(token: string, supabaseUrl: string, now = Date.now()): Promise<string | null | "unverifiable"> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string") return "unverifiable";
  let keys: Map<string, CryptoKey>;
  try {
    keys = await signingKeys(supabaseUrl);
    // A key rotated in since the last fetch: look once more.
    if (!keys.has(header.kid)) keys = await signingKeys(supabaseUrl, true);
  } catch {
    return "unverifiable";
  }
  const key = keys.get(header.kid);
  if (!key) return "unverifiable";
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;
  const seconds = Math.floor(now / 1000);
  const issuer = `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 30) return null;
  if (claims.iss !== issuer) return null;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes("authenticated") || claims.role !== "authenticated") return null;
  return typeof claims.sub === "string" && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
}
