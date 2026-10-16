import { and, eq } from "drizzle-orm";

import { db } from "@/server/db/client";
import { propertyMemberships } from "@/server/db/schema";
import {
  authorizePropertyAccess,
  roles,
  selectPropertyMembership,
  type Permission,
  type PropertySession,
  type Role,
} from "./authorization";

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

async function verifiedAuthUserId(request: Request) {
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
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: supabaseKey, authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new PropertyAccessError(401, "The login session is invalid or expired.");
  const user = await response.json() as { id?: string };
  if (!user.id) throw new PropertyAccessError(401, "The login session has no user identity.");
  return user.id;
}

export async function requirePropertySession(request: Request, permission: Permission): Promise<PropertySession> {
  const authUserId = await verifiedAuthUserId(request);
  const requestedPropertyId = request.headers.get("x-property-id");
  const memberships = await db.query.propertyMemberships.findMany({
    where: and(eq(propertyMemberships.authUserId, authUserId), eq(propertyMemberships.active, true)),
  });
  const membership = selectPropertyMembership(memberships, requestedPropertyId);
  if (!membership || !isRole(membership.role)) {
    throw new PropertyAccessError(403, requestedPropertyId ? "You do not have access to this hotel." : "Select an authorized hotel.");
  }
  const session: PropertySession = {
    authUserId,
    propertyId: membership.propertyId,
    role: membership.role,
    active: membership.active,
  };
  const authorization = authorizePropertyAccess(session, membership.propertyId, permission);
  if (!authorization.allowed) throw new PropertyAccessError(authorization.status === 401 ? 401 : 403, "You do not have permission for this action.");
  return session;
}

export function propertyAccessResponse(error: unknown) {
  if (error instanceof PropertyAccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}
