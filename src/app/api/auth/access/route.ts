import {
  propertyAccessResponse,
  requirePropertySession,
} from "@/server/auth/property-session";

/**
 * Verifies that a Supabase identity still belongs to an active motel. This is
 * intentionally separate from Supabase password authentication: deleting a
 * motel must revoke PMS access even when an old browser still has a session.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    return Response.json({
      propertyId: session.propertyId,
      role: session.role,
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
