import {
  propertyAccessResponse,
  requirePropertySession,
} from "@/server/auth/property-session";
import {
  platformAdminAccessResponse,
  requirePlatformAdmin,
} from "@/server/auth/platform-admin";

/**
 * Verifies that a Supabase identity still belongs to an active motel. This is
 * intentionally separate from Supabase password authentication: deleting a
 * motel must revoke PMS access even when an old browser still has a session.
 */
export async function GET(request: Request) {
  const wantsPlatform =
    new URL(request.url).searchParams.get("scope") === "platform";
  if (wantsPlatform) {
    try {
      const admin = await requirePlatformAdmin(request);
      return Response.json({ access: "platform", email: admin.email });
    } catch (error) {
      return platformAdminAccessResponse(error);
    }
  }
  try {
    const session = await requirePropertySession(request, "reports.view");
    return Response.json({
      access: "property",
      propertyId: session.propertyId,
      role: session.role,
    });
  } catch (propertyError) {
    // Platform administrators do not belong to a motel. Check that separate,
    // explicitly configured role before rejecting the Supabase session.
    try {
      const admin = await requirePlatformAdmin(request);
      return Response.json({ access: "platform", email: admin.email });
    } catch {
      return propertyAccessResponse(propertyError);
    }
  }
}
