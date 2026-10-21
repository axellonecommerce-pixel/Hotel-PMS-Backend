import { productionSql } from "@/server/db/production";

type AuthUser = { authUserId: string };

function supabaseAdminConfig() {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !secret) throw new Error("Supabase administrator access is not configured.");
  return { baseUrl, secret };
}

async function deleteAuthUser(authUserId: string) {
  const { baseUrl, secret } = supabaseAdminConfig();
  const response = await fetch(`${baseUrl}/auth/v1/admin/users/${authUserId}`, {
    method: "DELETE",
    headers: { apikey: secret, authorization: `Bearer ${secret}` },
  });
  if (!response.ok && response.status !== 404) {
    const result = await response.json().catch(() => ({})) as { msg?: string; message?: string };
    throw new Error(result.msg ?? result.message ?? "A motel login could not be removed.");
  }
}

/**
 * Permanently removes one motel's tenant data. The production migration makes
 * every property relationship cascade, so property data cannot be orphaned.
 * Auth users are removed only if they no longer belong to any other motel.
 */
export async function purgeMotel(propertyId: string) {
  const members = await productionSql()<AuthUser[]>`
    select auth_user_id as "authUserId" from property_memberships where property_id=${propertyId}::uuid
  `;
  const deleted = await productionSql()<Array<{ id: string }>>`
    delete from properties where id=${propertyId}::uuid returning id
  `;
  if (!deleted.length) return false;

  for (const member of members) {
    const [remaining] = await productionSql()<Array<{ count: number }>>`
      select count(*)::int as count from property_memberships where auth_user_id=${member.authUserId}::uuid
    `;
    if (!remaining || remaining.count === 0) await deleteAuthUser(member.authUserId);
  }
  return true;
}

/** Remove legacy archive records before reusing their owner email. */
export async function purgeArchivedMotelsForOwnerEmail(ownerEmail: string) {
  const archived = await productionSql()<Array<{ propertyId: string }>>`
    select distinct p.id as "propertyId"
    from properties p
    join employees e on e.property_id=p.id
    where p.status='deleted' and lower(e.email)=lower(${ownerEmail})
  `;
  for (const motel of archived) await purgeMotel(motel.propertyId);
}
