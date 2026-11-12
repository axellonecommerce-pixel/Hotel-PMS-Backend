import { and, eq } from "drizzle-orm";

import { db } from "@/server/db/client";
import { propertyMemberships } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { verifySupabaseToken } from "./jwt";
import { requirePlatformAdmin } from "./platform-admin";
import { accessLayers, cleanStaffAccess, STAFF_ACCESS_KEY } from "./staff-access";
import {
  authorizePropertyAccess,
  effectiveAccess,
  roleLabels,
  inScope,
  roles,
  selectPropertyMembership,
  type Permission,
  type PropertySession,
  type Role,
} from "./authorization";

export { STAFF_ACCESS_KEY };

export class PropertyAccessError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

/** The signed-in Supabase user id, checked (no motel or permission check). */
export async function verifiedAuthUserId(request: Request) {
  const token = bearerToken(request);
  if (!token) throw new PropertyAccessError(401, "Sign in is required.");

  if (process.env.NODE_ENV !== "production" && process.env.PMS_DEMO_AUTH_ENABLED === "true") {
    if (token !== process.env.PMS_DEMO_AUTH_TOKEN) throw new PropertyAccessError(401, "The demo access token is invalid.");
    const demoUserId = process.env.PMS_DEMO_AUTH_USER_ID;
    if (!demoUserId) throw new PropertyAccessError(401, "The demo user is not configured.");
    return demoUserId;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new PropertyAccessError(401, "Authentication is not configured.");
  // Checked here with Supabase's public signing keys; only a token this
  // server cannot check (older format, keys unreachable) goes to Supabase.
  const local = await verifySupabaseToken(token, supabaseUrl);
  if (local === null) throw new PropertyAccessError(401, "The login session is invalid or expired.");
  if (local !== "unverifiable") return local;
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: supabaseKey, authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new PropertyAccessError(401, "The login session is invalid or expired.");
  const user = await response.json() as { id?: string };
  if (!user.id) throw new PropertyAccessError(401, "The login session has no user identity.");
  return user.id;
}

/** Signs the request in to its motel and checks one permission, or any one of several. */
export async function requirePropertySession(request: Request, permission: Permission | readonly Permission[]): Promise<PropertySession> {
  const authUserId = await verifiedAuthUserId(request);
  const requestedPropertyId = request.headers.get("x-property-id");
  const memberships = hasProductionDatabase()
    ? await productionSql()<Array<{ propertyId: string; role: string; active: boolean; authUserId: string; staffAccess: unknown }>>`
        select m.property_id as "propertyId", m.role, m.active,
          m.auth_user_id::text as "authUserId",
          (select ps.value from property_settings ps
            where ps.property_id=m.property_id and ps.key=${STAFF_ACCESS_KEY}) as "staffAccess"
        from property_memberships m
        join properties p on p.id=m.property_id
        where m.auth_user_id = ${authUserId}::uuid and m.active = true and p.status <> 'deleted'
      `
    : await db.query.propertyMemberships.findMany({
        where: and(eq(propertyMemberships.authUserId, authUserId), eq(propertyMemberships.active, true)),
      });
  let membership: { propertyId: string; role: string; active: boolean; staffAccess?: unknown; roleLabel?: string } | null = selectPropertyMembership<{ propertyId: string; role: string; active: boolean; staffAccess?: unknown; roleLabel?: string }>(memberships, requestedPropertyId);
  // A designated Platform Admin may inspect a selected property after
  // provisioning it. Normal users still need an active property membership.
  if (!membership && requestedPropertyId) {
    try {
      await requirePlatformAdmin(request);
      membership = { propertyId: requestedPropertyId, role: "owner", active: true };
    } catch {
      // Keep the ordinary access-denied response below for non-admin users.
    }
  }
  if (!membership || !isRole(membership.role)) {
    throw new PropertyAccessError(403, requestedPropertyId ? "You do not have access to this hotel." : "Select an authorized hotel.");
  }
  // The owner's choices: the role's access (built-in or a custom role) and this login's own.
  const layers = accessLayers(cleanStaffAccess(membership.staffAccess), authUserId, membership.role);
  const session: PropertySession = {
    authUserId,
    propertyId: membership.propertyId,
    role: membership.role,
    active: membership.active,
    access: effectiveAccess(layers.custom ? layers.custom.basedOn : membership.role, layers.override, layers.roleOverride),
    roleLabel: layers.custom?.name ?? roleLabels[membership.role],
  };
  const wanted = typeof permission === "string" ? [permission] : permission;
  const results = wanted.map((item) => authorizePropertyAccess(session, membership!.propertyId, item));
  const authorization = results.find((result) => result.allowed) ?? results[0];
  if (!authorization.allowed) throw new PropertyAccessError(authorization.status === 401 ? 401 : 403, "You do not have permission for this action.");
  return session;
}

export function propertyAccessResponse(error: unknown) {
  if (error instanceof PropertyAccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  // The database's double-booking backstop (migration 0026) says which room
  // and reservation clash; that message is ours and safe to show.
  const dbError = error as { code?: unknown; message?: unknown; severity?: unknown };
  if (dbError && dbError.severity && dbError.code === "23P01" && typeof dbError.message === "string" && dbError.message.startsWith("Room ")) {
    return Response.json({ error: dbError.message }, { status: 409 });
  }
  throw error;
}

/** A change in one Settings section needs that section in the person's access. */
export function requireSettingsSection(session: PropertySession, section: string) {
  const scope = session.access?.settings ?? "all";
  if (session.role !== "owner" && !inScope(scope, section)) {
    throw new PropertyAccessError(403, `You do not have access to Settings › ${section}. Ask the owner to add it in Users & Roles.`);
  }
}
