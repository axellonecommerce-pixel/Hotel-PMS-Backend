export const roles = ["owner", "manager", "front_desk", "accountant"] as const;
export type Role = (typeof roles)[number];

export const permissions = [
  "property.manage",
  "employees.manage",
  "reservations.manage",
  "guests.manage",
  "folios.manage",
  "payments.manage",
  "companies.manage",
  "housekeeping.manage",
  "maintenance.manage",
  "cash.manage",
  "expenses.manage",
  "payroll.manage",
  "reports.view",
  "backups.manage",
] as const;

export type Permission = (typeof permissions)[number];

const allPermissions = new Set<Permission>(permissions);
const policies: Record<Role, ReadonlySet<Permission>> = {
  owner: allPermissions,
  manager: allPermissions,
  front_desk: new Set<Permission>([
    "reservations.manage",
    "guests.manage",
    "folios.manage",
    "payments.manage",
    "companies.manage",
    "housekeeping.manage",
    "maintenance.manage",
    "cash.manage",
    "reports.view",
  ]),
  accountant: new Set<Permission>([
    "payments.manage",
    "expenses.manage",
    "payroll.manage",
    "reports.view",
  ]),
};

export function hasPermission(role: Role, permission: Permission) {
  return policies[role].has(permission);
}

export type PropertySession = {
  authUserId: string;
  propertyId: string;
  role: Role;
  active: boolean;
};

export type MembershipCandidate = {
  propertyId: string;
  role: string;
  active: boolean;
};

export function selectPropertyMembership(memberships: MembershipCandidate[], requestedPropertyId?: string | null) {
  const active = memberships.filter((membership) => membership.active);
  if (requestedPropertyId) return active.find((membership) => membership.propertyId === requestedPropertyId) ?? null;
  return active.length === 1 ? active[0] : null;
}

export function hasEditConflict(currentVersion: number, expectedVersion: number) {
  return currentVersion !== expectedVersion;
}

export function authorizePropertyAccess(
  session: PropertySession | null,
  requestedPropertyId: string,
  permission: Permission,
) {
  if (!session || !session.active) return { allowed: false, status: 401 as const, reason: "UNAUTHENTICATED" as const };
  if (session.propertyId !== requestedPropertyId) return { allowed: false, status: 403 as const, reason: "WRONG_PROPERTY" as const };
  if (!hasPermission(session.role, permission)) return { allowed: false, status: 403 as const, reason: "MISSING_PERMISSION" as const };
  return { allowed: true, status: 200 as const };
}
