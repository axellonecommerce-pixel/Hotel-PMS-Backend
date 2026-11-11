import type { Sql, TransactionSql } from "postgres";

import { cleanOverride, roles, type AccessOverride, type Role } from "./authorization";
/** property_settings key holding the owner's access choices (see StaffAccess). */
export const STAFF_ACCESS_KEY = "staff_access";

/**
 * Per-motel access the owner chose (Settings › Users & Roles), kept in
 * property_settings ("staff_access"): for each role, and for each login by
 * Supabase user id. A login with no entry of its own follows its role.
 */
/**
 * A role the owner made ("Night Auditor", "Head Housekeeper", …). Its logins
 * are stored as the built-in role it is based on, with this role's access.
 */
export type CustomRole = { id: string; name: string; basedOn: Exclude<Role, "owner">; access: AccessOverride };

export type StaffAccess = {
  /** The owner's changes to a whole built-in role (every Front Desk login, …). */
  roles: Partial<Record<Role, AccessOverride>>;
  /** Roles the owner made. */
  customRoles: CustomRole[];
  /** Which logins have one of those roles: authUserId -> custom role id. */
  assignments: Record<string, string>;
  /** The owner's changes for one login. */
  users: Record<string, AccessOverride>;
};

/** The access layers for one login: its role's (built-in or custom) and its own. */
export function accessLayers(staffAccess: StaffAccess, authUserId: string, role: Role) {
  const custom = staffAccess.customRoles.find((item) => item.id === staffAccess.assignments[authUserId] && item.basedOn === role);
  return { custom, roleOverride: custom ? custom.access : staffAccess.roles[role], override: staffAccess.users[authUserId] };
}

type Db = Sql | TransactionSql;

export function cleanStaffAccess(value: unknown): StaffAccess {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const users: Record<string, AccessOverride> = {};
  if (raw.users && typeof raw.users === "object" && !Array.isArray(raw.users)) {
    for (const [id, override] of Object.entries(raw.users as Record<string, unknown>)) {
      const cleaned = cleanOverride(override);
      if (cleaned) users[id] = cleaned;
    }
  }
  const roleChanges: Partial<Record<Role, AccessOverride>> = {};
  if (raw.roles && typeof raw.roles === "object" && !Array.isArray(raw.roles)) {
    for (const [role, override] of Object.entries(raw.roles as Record<string, unknown>)) {
      const cleaned = cleanOverride(override);
      if (cleaned && roles.includes(role as Role) && role !== "owner") roleChanges[role as Role] = cleaned;
    }
  }
  const customRoles: CustomRole[] = Array.isArray(raw.customRoles) ? (raw.customRoles as Array<Record<string, unknown>>).flatMap((item) => {
    const access = cleanOverride(item?.access) ?? {};
    return item && typeof item.id === "string" && typeof item.name === "string" && roles.includes(item.basedOn as Role) && item.basedOn !== "owner"
      ? [{ id: item.id, name: item.name.slice(0, 40), basedOn: item.basedOn as Exclude<Role, "owner">, access }] : [];
  }) : [];
  const assignments: Record<string, string> = {};
  if (raw.assignments && typeof raw.assignments === "object" && !Array.isArray(raw.assignments)) {
    for (const [id, roleId] of Object.entries(raw.assignments as Record<string, unknown>)) if (typeof roleId === "string" && customRoles.some((item) => item.id === roleId)) assignments[id] = roleId;
  }
  return { roles: roleChanges, customRoles, assignments, users };
}

export async function readStaffAccess(db: Db, propertyId: string, lock = false): Promise<StaffAccess> {
  const rows = lock
    ? await db<Array<{ value: unknown }>>`select value from property_settings where property_id=${propertyId}::uuid and key=${STAFF_ACCESS_KEY} for update`
    : await db<Array<{ value: unknown }>>`select value from property_settings where property_id=${propertyId}::uuid and key=${STAFF_ACCESS_KEY}`;
  return cleanStaffAccess(rows[0]?.value);
}

export async function writeStaffAccess(db: Db, propertyId: string, value: StaffAccess) {
  await db`insert into property_settings (property_id,key,value) values (${propertyId}::uuid,${STAFF_ACCESS_KEY},${db.json(value as never)})
    on conflict (property_id,key) do update set value=excluded.value,updated_at=now()`;
}

/** Lock the row first (creating it when missing) so two changes never overwrite each other. */
export async function lockStaffAccess(tx: TransactionSql, propertyId: string) {
  await tx`insert into property_settings (property_id,key,value) values (${propertyId}::uuid,${STAFF_ACCESS_KEY},${tx.json({ roles: {}, customRoles: [], assignments: {}, users: {} } as never)}) on conflict (property_id,key) do nothing`;
  return readStaffAccess(tx, propertyId, true);
}

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("Supabase administrator access is not configured.");
  return { url, secret, headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" } };
}
