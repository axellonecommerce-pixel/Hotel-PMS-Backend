import { setRequestActor } from "@/server/db/request-context";

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
  const user = await response.json() as { id?: string; email?: string; email_confirmed_at?: string | null };
  const email = user.email?.trim().toLowerCase();
  if (!user.id || !email) throw new PlatformAdminAccessError(401, "The login session has no email address.");
  // An address someone signed up with but never confirmed proves nothing.
  if (!user.email_confirmed_at) throw new PlatformAdminAccessError(403, "Confirm this account's email address before using the Platform Admin.");
  if (!configuredEmails().has(email)) throw new PlatformAdminAccessError(403, "This account is not a Platform Admin.");
  setRequestActor({ authUserId: user.id, label: `Platform admin ${email}` });
  return { id: user.id, email };
}

export function platformAdminAccessResponse(error: unknown) {
  if (error instanceof PlatformAdminAccessError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
}
