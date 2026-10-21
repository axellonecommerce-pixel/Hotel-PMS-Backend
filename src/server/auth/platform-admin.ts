import { timingSafeEqual } from "node:crypto";

export class PlatformAdminAccessError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

function configuredEmails() {
  return new Set(
    (process.env.PMS_PLATFORM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function requirePlatformAdmin(request: Request) {
  const token = bearerToken(request);
  if (!token) throw new PlatformAdminAccessError(401, "Sign in is required.");
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) throw new PlatformAdminAccessError(401, "Authentication is not configured.");
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new PlatformAdminAccessError(401, "The login session is invalid or expired.");
  const user = await response.json() as { id?: string; email?: string };
  const email = user.email?.trim().toLowerCase();
  if (!user.id || !email) throw new PlatformAdminAccessError(401, "The login session has no email address.");
  if (!configuredEmails().has(email)) throw new PlatformAdminAccessError(403, "This account is not a Platform Admin.");
  return { id: user.id, email };
}

export function platformAdminAccessResponse(error: unknown) {
  if (error instanceof PlatformAdminAccessError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}

export function validProvisioningKey(request: Request) {
  const expected = process.env.PMS_PROVISIONING_KEY;
  const supplied = request.headers.get("x-pms-provisioning-key");
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
