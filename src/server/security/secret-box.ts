import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Encrypts secrets the PMS must keep (a card processor key) with AES-256-GCM.
// Set PMS_ENCRYPTION_KEY (32 random bytes, base64) on the API. Without it the
// key is derived from the server-only Supabase secret, which is never sent
// to a browser. Changing either makes stored secrets unreadable: the motel
// then connects its terminal again.
function key() {
  const configured = process.env.PMS_ENCRYPTION_KEY;
  if (configured) {
    const bytes = Buffer.from(configured, "base64");
    if (bytes.length !== 32) throw new Error("PMS_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
    return bytes;
  }
  const fallback = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!fallback) throw new Error("Set PMS_ENCRYPTION_KEY before connecting a card terminal.");
  return createHash("sha256").update(`pms-secret-box:${fallback}`).digest();
}

export function sealSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

export function openSecret(sealed: string) {
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("The stored secret is unreadable.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
