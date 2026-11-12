import { beforeAll, expect, test } from "bun:test";

import { setSigningKeysForTest, verifySupabaseToken } from "./jwt";

const url = "https://example-project.supabase.co";
const userId = "7cd54d29-d34b-45a9-99d6-ccaad47a54f0";
let privateKey: CryptoKey;

const b64 = (value: object | Uint8Array) => Buffer.from(value instanceof Uint8Array ? value : JSON.stringify(value)).toString("base64url");
async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: "key-1", typ: "JWT" }, key = privateKey) {
  const body = `${b64(header)}.${b64(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body)));
  return `${body}.${b64(signature)}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { sub: userId, aud: "authenticated", role: "authenticated", iss: `${url}/auth/v1`, exp: now + 3600, iat: now };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await setSigningKeysForTest(url, [{ ...jwk, kid: "key-1", alg: "ES256" }]);
});

test("a token signed by the project's key gives the user id", async () => {
  expect(await verifySupabaseToken(await sign(good), url)).toBe(userId);
});

test("expired, wrong-issuer, anonymous-role and tampered tokens are refused", async () => {
  expect(await verifySupabaseToken(await sign({ ...good, exp: now - 10 }), url)).toBeNull();
  expect(await verifySupabaseToken(await sign({ ...good, iss: "https://other.supabase.co/auth/v1" }), url)).toBeNull();
  expect(await verifySupabaseToken(await sign({ ...good, role: "anon", aud: "anon" }), url)).toBeNull();
  const token = await sign(good);
  const [header, , signature] = token.split(".");
  const forged = `${header}.${b64({ ...good, sub: "11111111-1111-4111-8111-111111111111" })}.${signature}`;
  expect(await verifySupabaseToken(forged, url)).toBeNull();
});

test("a token signed by another key is refused; an old HS256 token is left to Supabase", async () => {
  const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
  expect(await verifySupabaseToken(await sign(good, undefined, other.privateKey), url)).toBeNull();
  expect(await verifySupabaseToken(await sign(good, { alg: "HS256", typ: "JWT" }), url)).toBe("unverifiable");
  expect(await verifySupabaseToken("not-a-token", url)).toBeNull();
});
