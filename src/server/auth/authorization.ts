export const roles = ["owner", "manager", "front_desk", "accountant", "housekeeping"] as const;
export type Role = (typeof roles)[number];

export const roleLabels: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  front_desk: "Front Desk",
  accountant: "Accountant",
  housekeeping: "Housekeeper",
};

/**
 * What a login may do at its motel. Each role starts with the defaults
 * below; the owner can then switch any of them on or off per person
 * (Settings › Users & Roles), including which reports and which Settings
 * sections they see. The owner always has everything.
 *
 * "property.read" is not a choice: every active login can read the motel's
 * basic setup (rooms, room types, business date), which every page needs.
 */
export const permissions = [
  "property.read",
  "dashboard.view",
  "reservations.manage",
  "guests.manage",
  "folios.manage",
  "payments.manage",
  // Deleting a recorded payment (refunds stay under payments.manage).
  "payments.delete",
  "companies.manage",
  "cash.manage",
  "night_audit.run",
  "housekeeping.manage",
  "maintenance.manage",
  "lost_found.manage",
  "revenue.view",
  "expenses.manage",
  "profit_loss.view",
  "rates.manage",
  "payroll.manage",
  "reports.view",
  "property.manage",
  // Download every guest's details at once (one guest's own record needs only guests.manage).
  "guests.export",
  // Owner only: never given to another login.
  "users.manage",
  "backups.manage",
  // Kept for older callers; employees are managed in Settings › Employees.
  "employees.manage",
] as const;

export type Permission = (typeof permissions)[number];

const allPermissions = new Set<Permission>(permissions);
const roleDefaults: Record<Role, ReadonlySet<Permission>> = {
  owner: allPermissions,
  // Only the owner manages logins and access (Settings › Users & Roles).
  // Downloading the whole guest list stays with the owner unless they allow it.
  // Restoring a backup replaces every record: the owner's decision alone.
  manager: new Set<Permission>(permissions.filter((permission) => permission !== "users.manage" && permission !== "guests.export" && permission !== "backups.manage")),
  front_desk: new Set<Permission>([
    "property.read",
    "dashboard.view",
    "reservations.manage",
    "guests.manage",
    "folios.manage",
    "payments.manage",
    "companies.manage",
    "housekeeping.manage",
    "maintenance.manage",
    "lost_found.manage",
    "cash.manage",
    "reports.view",
  ]),
  accountant: new Set<Permission>([
    "property.read",
    "dashboard.view",
    "payments.manage",
    "revenue.view",
    "expenses.manage",
    "profit_loss.view",
    "payroll.manage",
    "reports.view",
    // Settings, limited to Expense & Revenue Categories (see defaultScopes).
    "property.manage",
  ]),
  housekeeping: new Set<Permission>([
    "property.read",
    "housekeeping.manage",
    "maintenance.manage",
    "lost_found.manage",
  ]),
};

/** "all", or the chosen report ids / Settings section names. */
export type AccessScope = "all" | string[];

/** A login's access as the owner customized it. Missing fields use the role's defaults. */
export type AccessOverride = {
  permissions?: string[];
  reports?: AccessScope;
  settings?: AccessScope;
};

/** Reports each role sees by default (report ids from the Reports library). */
const FRONT_DESK_REPORTS = [
  "arrivals", "departures", "in-house-balances", "guest-stay", "no-show-late-cancel", "do-not-rent", "payment-activity", "room-status", "paid-outs", "cash-drop",
  "clerk-shift", "lost-and-found", "housekeeping-board", "room-reconciliation", "room-move", "vacant-rooms", "housekeeping-forecast",
];

export function defaultPermissions(role: Role) {
  return roleDefaults[role];
}

export function defaultScopes(role: Role): { reports: AccessScope; settings: AccessScope } {
  if (role === "owner" || role === "manager") return { reports: "all", settings: "all" };
  if (role === "front_desk") return { reports: FRONT_DESK_REPORTS, settings: [] };
  if (role === "accountant") return { reports: "all", settings: ["Expense & Revenue Categories"] };
  return { reports: [], settings: [] };
}

const isScope = (value: unknown): value is AccessScope =>
  value === "all" || (Array.isArray(value) && value.every((item) => typeof item === "string"));

/** Only what an override may hold, whatever was stored. */
export function cleanOverride(value: unknown): AccessOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: AccessOverride = {};
  if (Array.isArray(raw.permissions)) result.permissions = raw.permissions.filter((item): item is Permission => allPermissions.has(item as Permission));
  if (isScope(raw.reports)) result.reports = raw.reports === "all" ? "all" : raw.reports.slice(0, 200);
  if (isScope(raw.settings)) result.settings = raw.settings === "all" ? "all" : raw.settings.slice(0, 50);
  return Object.keys(result).length ? result : undefined;
}

export type EffectiveAccess = {
  permissions: ReadonlySet<Permission>;
  reports: AccessScope;
  settings: AccessScope;
  customized: boolean;
};

/** Resolve one access layer over another: the chosen permissions, reports and Settings sections. */
function apply(base: { permissions: ReadonlySet<Permission>; reports: AccessScope; settings: AccessScope }, override?: AccessOverride | null) {
  if (!override) return base;
  // Logins and access stay the owner's alone, whatever is stored.
  const chosen = new Set<Permission>(override.permissions ? ["property.read", ...override.permissions as Permission[]] : base.permissions);
  chosen.delete("users.manage");
  return { permissions: chosen, reports: override.reports ?? base.reports, settings: override.settings ?? base.settings };
}

/**
 * What a login may open: InnSeva's defaults for the role, then the owner's
 * changes to that role (every Front Desk login, say), then the owner's
 * changes for this one person. The owner is never limited.
 */
export function effectiveAccess(role: Role, override?: AccessOverride | null, roleOverride?: AccessOverride | null): EffectiveAccess {
  const builtIn = { permissions: roleDefaults[role], ...defaultScopes(role) };
  if (role === "owner") return { ...builtIn, customized: false };
  const forRole = apply(builtIn, roleOverride);
  return { ...apply(forRole, override), customized: Boolean(override) };
}

export function hasPermission(role: Role, permission: Permission, access?: EffectiveAccess) {
  return (access?.permissions ?? roleDefaults[role]).has(permission);
}

export const inScope = (scope: AccessScope, item: string) => scope === "all" || scope.includes(item);

export type PropertySession = {
  authUserId: string;
  propertyId: string;
  role: Role;
  active: boolean;
  access?: EffectiveAccess;
  /** "Front Desk", or the owner's own role name ("Night Auditor"). */
  roleLabel?: string;
};

export type MembershipCandidate = {
  propertyId: string;
  role: string;
  active: boolean;
  access?: unknown;
};

export function selectPropertyMembership<T extends MembershipCandidate>(memberships: T[], requestedPropertyId?: string | null): T | null {
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
  if (!hasPermission(session.role, permission, session.access)) return { allowed: false, status: 403 as const, reason: "MISSING_PERMISSION" as const };
  return { allowed: true, status: 200 as const };
}

/**
 * The Settings section each saved setting belongs to, so a person allowed
 * only some sections cannot change the others. Settings not listed here
 * (option on/off switches) may be changed from any section they can open.
 */
export const settingsKeySections: Record<string, string> = {
  property: "Property",
  roomTypes: "Room Types",
  rooms: "Rooms",
  buildings: "Rooms",
  floorMapLocations: "Floor Plan Layout",
  rateCodes: "Rate Plans",
  promotions: "Rate Plans",
  reservationSources: "Reservation Sources",
  bookingChannels: "Reservation Sources",
  otaCommissionRules: "Reservation Sources",
  emailImport: "Online Bookings",
  paymentTypes: "Payment Types",
  chargeTypes: "Charge Types",
  expenseCategories: "Expense & Revenue Categories",
  expenseCategoryGroups: "Expense & Revenue Categories",
  miscRevenueCategories: "Expense & Revenue Categories",
  cashAdjustmentCategories: "Expense & Revenue Categories",
  profitLoss: "Expense & Revenue Categories",
  employees: "Employees",
  payrollFrequencies: "Employees",
  payroll: "Employees",
  invoice: "Invoice Settings",
  tax: "Tax Settings",
  users: "Users & Roles",
  userRoles: "Users & Roles",
};
