import { effectiveAccess, roleLabels } from "@/server/auth/authorization";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
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
    const session = await requirePropertySession(request, "property.read");
    // Who is signed in (shown at the top right): their employee name and login email.
    const [user] = hasProductionDatabase() && /^[0-9a-f-]{36}$/i.test(session.authUserId) ? await productionSql()<Array<{ name: string | null; email: string | null }>>`
      select
        (select e.name from employees e join property_memberships m on m.id=e.membership_id
          where m.auth_user_id=${session.authUserId}::uuid and m.property_id=${session.propertyId}::uuid order by e.created_at limit 1) as name,
        (select u.email from auth.users u where u.id=${session.authUserId}::uuid) as email
    `.catch(() => [{ name: null, email: null }]) : [{ name: null, email: null }];
    const access = session.access ?? effectiveAccess(session.role);
    return Response.json({
      access: "property",
      propertyId: session.propertyId,
      role: session.role,
      roleLabel: session.roleLabel ?? roleLabels[session.role],
      name: user?.name ?? null,
      email: user?.email ?? null,
      // What this person may open (pages, reports, Settings sections). The server checks every action again.
      permissions: [...access.permissions],
      reports: access.reports,
      settings: access.settings,
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

