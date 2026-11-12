import { z } from "zod";

import { cleanOverride, effectiveAccess, permissions, roleLabels, roles, type Role } from "@/server/auth/authorization";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { accessLayers, lockStaffAccess, readStaffAccess, supabaseAdmin, writeStaffAccess, type StaffAccess } from "@/server/auth/staff-access";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

/**
 * Settings › Users & Roles, for owners only: every login at the motel, what
 * each may open, and whether it may sign in at all. An owner creates every
 * login here (username = email, and a password), including another owner
 * (a partner), who then has full access too. The Platform makes the first
 * owner when the motel is set up. Nobody changes their own login here, and
 * the motel always keeps at least one active owner.
 */
const staffRoles = roles.filter((role): role is Exclude<Role, "owner"> => role !== "owner");
/** A built-in role ("front_desk") or one the owner made ("custom:<id>"). */
const staffRoleSchema = z.string().trim().min(1).max(60);
type StaffRole = Exclude<Role, "owner">;

/** The database role, the owner's role (if any) and the name shown for a role key. */
function resolveRole(staffAccess: StaffAccess, key: string): { dbRole: Role; customId?: string; label: string } | null {
  if (roles.includes(key as Role)) return { dbRole: key as Role, label: roleLabels[key as Role] };
  const custom = key.startsWith("custom:") ? staffAccess.customRoles.find((item) => `custom:${item.id}` === key) : undefined;
  return custom ? { dbRole: custom.basedOn, customId: custom.id, label: custom.name } : null;
}
const scopeSchema = z.union([z.literal("all"), z.array(z.string().max(80)).max(200)]);
const accessSchema = z.object({
  permissions: z.array(z.enum(permissions)).optional(),
  reports: scopeSchema.optional(),
  settings: scopeSchema.optional(),
}).nullable();
const createSchema = z.object({
  name: z.string().trim().min(1, "Enter the person's name.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email; it is the username."),
  password: z.string().min(10, "The password needs at least 10 characters.").max(128),
  role: staffRoleSchema,
  access: accessSchema.optional(),
});
const updateSchema = z.object({
  employeeId: z.string().uuid(),
  role: staffRoleSchema.optional(),
  password: z.string().min(10, "The password needs at least 10 characters.").max(128).optional(),
  /** false = this login can no longer sign in to the motel. */
  active: z.boolean().optional(),
  /** null = back to the role's defaults. */
  access: accessSchema.optional(),
});

type UserRow = { employeeId: string; authUserId: string; name: string; email: string; role: Role; active: boolean; lastSignIn: string | null };

/** Every login at the motel with the access it has now, and each role's starting access. */
async function listUsers(propertyId: string) {
  const sql = productionSql();
  const [rows, staffAccess] = await Promise.all([
    sql<UserRow[]>`
      select e.id as "employeeId", m.auth_user_id::text as "authUserId", e.name, e.email, m.role, m.active,
        (select u.last_sign_in_at::text from auth.users u where u.id=m.auth_user_id) as "lastSignIn"
      from employees e join property_memberships m on m.id=e.membership_id
      where e.property_id=${propertyId}::uuid order by (m.role='owner') desc, e.created_at asc
    `.catch(() => sql<UserRow[]>`
      select e.id as "employeeId", m.auth_user_id::text as "authUserId", e.name, e.email, m.role, m.active, null as "lastSignIn"
      from employees e join property_memberships m on m.id=e.membership_id
      where e.property_id=${propertyId}::uuid order by (m.role='owner') desc, e.created_at asc
    `),
    readStaffAccess(sql, propertyId),
  ]);
  const shown = (access: ReturnType<typeof effectiveAccess>) => ({ permissions: [...access.permissions].filter((permission) => permission !== "property.read"), reports: access.reports, settings: access.settings });
  const users = rows.map((row) => {
    const role: Role = roles.includes(row.role) ? row.role : "front_desk";
    const layers = accessLayers(staffAccess, row.authUserId, role);
    const access = effectiveAccess(role, layers.override, layers.roleOverride);
    // roleKey: what the role picker shows ("front_desk" or "custom:<id>").
    return { ...row, role, roleKey: layers.custom ? `custom:${layers.custom.id}` : role, roleLabel: layers.custom?.name ?? roleLabels[role], customized: access.customized, access: shown(access) };
  });
  // What each role can open at this motel (with the owner's changes), and InnSeva's own starting point.
  const builtInRoles = staffRoles.map((role) => ({
    key: role as string,
    label: roleLabels[role],
    custom: false,
    basedOn: role,
    access: shown(effectiveAccess(role, null, staffAccess.roles[role])),
    builtIn: shown(effectiveAccess(role)),
    customized: Boolean(staffAccess.roles[role]),
  }));
  const customRoles = staffAccess.customRoles.map((custom) => ({
    key: `custom:${custom.id}`,
    label: custom.name,
    custom: true,
    basedOn: custom.basedOn as StaffRole,
    access: shown(effectiveAccess(custom.basedOn, null, custom.access)),
    builtIn: shown(effectiveAccess(custom.basedOn)),
    customized: true,
  }));
  const roleAccess = [...builtInRoles, ...customRoles].map((item) => ({
    ...item,
    logins: users.filter((user) => user.roleKey === item.key).length,
    ownAccess: users.filter((user) => user.roleKey === item.key && user.customized).length,
  }));
  const roleDefaults = Object.fromEntries(roleAccess.map((item) => [item.key, item.access]));
  return { users, roleDefaults, roleAccess };
}

const ownerOnly = () => Response.json({ error: "Only the motel owner can manage logins and access." }, { status: 403 });

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "users.manage");
    if (session.role !== "owner") return ownerOnly();
    if (!hasProductionDatabase()) return Response.json({ users: [], roleDefaults: {} });
    return Response.json(await listUsers(session.propertyId));
  } catch (error) { return propertyAccessResponse(error); }
}

/** A new staff login: username (email), password, role and, optionally, the exact access. */
async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "users.manage");
    if (session.role !== "owner") return ownerOnly();
    if (!hasProductionDatabase()) return Response.json({ error: "Staff login setup requires the production database." }, { status: 503 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.action === "createRole") return createRole(session.propertyId, body);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the login details." }, { status: 400 });
    const input = parsed.data;
    const target = resolveRole(await readStaffAccess(productionSql(), session.propertyId), input.role);
    if (!target) return Response.json({ error: "Choose a role for this login." }, { status: 400 });
    const admin = supabaseAdmin();
    const authResponse = await fetch(`${admin.url}/auth/v1/admin/users`, { method: "POST", headers: admin.headers, body: JSON.stringify({ email: input.email, password: input.password, email_confirm: true, user_metadata: { full_name: input.name } }) });
    if (!authResponse.ok) {
      const message = await authResponse.json().catch(() => ({})) as { msg?: string; message?: string };
      const text = message.msg ?? message.message ?? "";
      return Response.json({ error: /already|registered|exists/i.test(text) ? "This email already has an InnSeva login. Use a different email." : text || "The login could not be created." }, { status: 409 });
    }
    const auth = await authResponse.json() as { id?: string; user?: { id?: string } };
    const authUserId = auth.id ?? auth.user?.id;
    if (!authUserId) throw new Error("The new login did not return an id.");
    const membershipId = crypto.randomUUID();
    const employeeId = crypto.randomUUID();
    try {
      await productionSql().begin(async (tx) => {
        await tx`insert into property_memberships (id,property_id,auth_user_id,role,active) values (${membershipId}::uuid,${session.propertyId}::uuid,${authUserId}::uuid,${target.dbRole},true)`;
        await tx`insert into employees (id,property_id,membership_id,name,email,job_role,pay_method,active) values (${employeeId}::uuid,${session.propertyId}::uuid,${membershipId}::uuid,${input.name},${input.email},${target.label},'hourly',true)`;
        const override = input.access ? cleanOverride(input.access) : undefined;
        if (override || target.customId) {
          const staffAccess = await lockStaffAccess(tx, session.propertyId);
          if (override) staffAccess.users[authUserId] = override;
          if (target.customId) staffAccess.assignments[authUserId] = target.customId;
          await writeStaffAccess(tx, session.propertyId, staffAccess);
        }
      });
    } catch (error) {
      // Undo the sign-in so the owner can try again with the same email.
      await fetch(`${admin.url}/auth/v1/admin/users/${authUserId}`, { method: "DELETE", headers: admin.headers }).catch(() => undefined);
      throw error;
    }
    return Response.json(await listUsers(session.propertyId), { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Change a staff login's role, password, access, or stop / allow its sign-in. */
async function routePATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "users.manage");
    if (session.role !== "owner") return ownerOnly();
    if (!hasProductionDatabase()) return Response.json({ error: "Staff login setup requires the production database." }, { status: 503 });
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the login changes." }, { status: 400 });
    const input = parsed.data;
    const target = input.role ? resolveRole(await readStaffAccess(productionSql(), session.propertyId), input.role) : undefined;
    if (input.role && !target) return Response.json({ error: "That role no longer exists." }, { status: 400 });
    const [user] = await productionSql()<Array<{ authUserId: string; role: string }>>`select m.auth_user_id::text as "authUserId",m.role from employees e join property_memberships m on m.id=e.membership_id where e.id=${input.employeeId}::uuid and e.property_id=${session.propertyId}::uuid`;
    if (!user) return Response.json({ error: "This login was not found." }, { status: 404 });
    if (user.authUserId === session.authUserId) return Response.json({ error: "You cannot change your own login here. Another owner, or the Platform, can." }, { status: 403 });
    if (user.role === "owner" && (input.active === false || (target && target.dbRole !== "owner"))) {
      const [owners] = await productionSql()<Array<{ count: number }>>`select count(*)::int as count from property_memberships where property_id=${session.propertyId}::uuid and role='owner' and active`;
      if (owners.count <= 1) return Response.json({ error: "The motel needs at least one owner who can sign in." }, { status: 403 });
    }
    if (input.password) {
      // A password belongs to the person's login everywhere. Never let one
      // motel reset the password of a login that also works at another motel.
      const [elsewhere] = await productionSql()<Array<{ count: number }>>`
        select count(*)::int as count from property_memberships where auth_user_id=${user.authUserId}::uuid and property_id<>${session.propertyId}::uuid and active
      `;
      if (elsewhere.count > 0) return Response.json({ error: "This login is also used at another motel. Its password can only be reset by the person, or by the Platform Admin." }, { status: 403 });
      const admin = supabaseAdmin();
      const response = await fetch(`${admin.url}/auth/v1/admin/users/${user.authUserId}`, { method: "PUT", headers: admin.headers, body: JSON.stringify({ password: input.password }) });
      if (!response.ok) return Response.json({ error: "The password could not be changed." }, { status: 502 });
    }
    await productionSql().begin(async (tx) => {
      await tx`update property_memberships set role=coalesce(${target?.dbRole ?? null},role),active=coalesce(${input.active ?? null},active),updated_at=now() where auth_user_id=${user.authUserId}::uuid and property_id=${session.propertyId}::uuid`;
      if (target) await tx`update employees set job_role=${target.label},updated_at=now() where id=${input.employeeId}::uuid and property_id=${session.propertyId}::uuid`;
      if (input.access !== undefined || target) {
        const staffAccess = await lockStaffAccess(tx, session.propertyId);
        // A new role brings that role's access, unless access is given too.
        const previousKey = staffAccess.assignments[user.authUserId] ? `custom:${staffAccess.assignments[user.authUserId]}` : user.role;
        const roleChanged = Boolean(target && input.role !== previousKey);
        if (target) {
          if (target.customId) staffAccess.assignments[user.authUserId] = target.customId;
          else delete staffAccess.assignments[user.authUserId];
        }
        const override = input.access ? cleanOverride(input.access) : undefined;
        if (override) staffAccess.users[user.authUserId] = override;
        else if (input.access === null || roleChanged) delete staffAccess.users[user.authUserId];
        await writeStaffAccess(tx, session.propertyId, staffAccess);
      }
    });
    return Response.json(await listUsers(session.propertyId));
  } catch (error) { return propertyAccessResponse(error); }
}

const roleAccessSchema = z.object({
  role: z.string().trim().min(1).max(60),
  /** null = back to InnSeva's starting access for the role. */
  access: accessSchema,
  /** A role the owner made can be renamed. */
  name: z.string().trim().min(2).max(40).optional(),
});
const roleName = z.string().trim().min(2, "Give the role a name of at least 2 letters.").max(40, "Keep the role name under 40 letters.");
const createRoleSchema = z.object({
  name: roleName,
  basedOn: z.enum(staffRoles as [StaffRole, ...StaffRole[]]),
  access: accessSchema.optional(),
});

/** Names already used by a built-in role or another of the owner's roles. */
function nameTaken(staffAccess: StaffAccess, name: string, exceptId?: string) {
  const wanted = name.trim().toLowerCase();
  return roles.some((role) => roleLabels[role].toLowerCase() === wanted) || staffAccess.customRoles.some((item) => item.id !== exceptId && item.name.toLowerCase() === wanted);
}

/** A new role ("Night Auditor"), starting from a built-in role's access. */
async function createRole(propertyId: string, body: unknown) {
  const parsed = createRoleSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the role." }, { status: 400 });
  const error = await productionSql().begin(async (tx) => {
    const staffAccess = await lockStaffAccess(tx, propertyId);
    if (staffAccess.customRoles.length >= 30) return "A motel can have up to 30 roles of its own.";
    if (nameTaken(staffAccess, parsed.data.name)) return `There is already a role called ${parsed.data.name}.`;
    const base = effectiveAccess(parsed.data.basedOn, null, staffAccess.roles[parsed.data.basedOn]);
    const access = (parsed.data.access ? cleanOverride(parsed.data.access) : undefined)
      ?? { permissions: [...base.permissions].filter((permission) => permission !== "property.read"), reports: base.reports, settings: base.settings };
    staffAccess.customRoles.push({ id: crypto.randomUUID().slice(0, 8), name: parsed.data.name, basedOn: parsed.data.basedOn, access });
    await writeStaffAccess(tx, propertyId, staffAccess);
    return null;
  });
  if (error) return Response.json({ error }, { status: 409 });
  return Response.json(await listUsers(propertyId), { status: 201 });
}

/**
 * What a whole role can open (every Front Desk login, every Night Auditor,
 * …). Logins given their own access keep it; the rest follow the role at once.
 */
async function routePUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "users.manage");
    if (session.role !== "owner") return ownerOnly();
    if (!hasProductionDatabase()) return Response.json({ error: "Role access needs the production database." }, { status: 503 });
    const parsed = roleAccessSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Choose a role and its access." }, { status: 400 });
    const { role, access, name } = parsed.data;
    const error = await productionSql().begin(async (tx) => {
      const staffAccess = await lockStaffAccess(tx, session.propertyId);
      const override = access ? cleanOverride(access) : undefined;
      const custom = role.startsWith("custom:") ? staffAccess.customRoles.find((item) => `custom:${item.id}` === role) : undefined;
      if (custom) {
        if (name && name !== custom.name) {
          if (nameTaken(staffAccess, name, custom.id)) return `There is already a role called ${name}.`;
          custom.name = name;
          // The job title on each of its logins follows the new name.
          const ids = Object.entries(staffAccess.assignments).filter(([, id]) => id === custom.id).map(([userId]) => userId);
          if (ids.length) await tx`update employees e set job_role=${name},updated_at=now() from property_memberships m where m.id=e.membership_id and e.property_id=${session.propertyId}::uuid and m.auth_user_id::text = any(${ids}::text[])`;
        }
        // Back to defaults: the access of the role it is based on.
        if (override) custom.access = override;
        else if (access === null) {
          const base = effectiveAccess(custom.basedOn, null, staffAccess.roles[custom.basedOn]);
          custom.access = { permissions: [...base.permissions].filter((permission) => permission !== "property.read"), reports: base.reports, settings: base.settings };
        }
      } else if (staffRoles.includes(role as StaffRole)) {
        const builtInRole = role as StaffRole;
        // Exactly InnSeva's starting access is stored as nothing, so it follows future defaults.
        const builtIn = effectiveAccess(builtInRole);
        const same = override && JSON.stringify([[...effectiveAccess(builtInRole, null, override).permissions].sort(), override.reports ?? builtIn.reports, override.settings ?? builtIn.settings])
          === JSON.stringify([[...builtIn.permissions].sort(), builtIn.reports, builtIn.settings]);
        if (override && !same) staffAccess.roles[builtInRole] = override;
        else delete staffAccess.roles[builtInRole];
      } else return "That role no longer exists.";
      await writeStaffAccess(tx, session.propertyId, staffAccess);
      return null;
    });
    if (error) return Response.json({ error }, { status: 409 });
    return Response.json(await listUsers(session.propertyId));
  } catch (error) { return propertyAccessResponse(error); }
}

/** Delete a role the owner made. Its logins must be moved to another role first. */
async function routeDELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "users.manage");
    if (session.role !== "owner") return ownerOnly();
    if (!hasProductionDatabase()) return Response.json({ error: "Roles need the production database." }, { status: 503 });
    const role = new URL(request.url).searchParams.get("role") ?? "";
    const error = await productionSql().begin(async (tx) => {
      const staffAccess = await lockStaffAccess(tx, session.propertyId);
      const custom = staffAccess.customRoles.find((item) => `custom:${item.id}` === role);
      if (!custom) return "Only roles you made can be deleted.";
      const using = Object.values(staffAccess.assignments).filter((id) => id === custom.id).length;
      if (using) return `${using} login${using === 1 ? " has" : "s have"} the ${custom.name} role. Give ${using === 1 ? "it" : "them"} another role first.`;
      staffAccess.customRoles = staffAccess.customRoles.filter((item) => item !== custom);
      await writeStaffAccess(tx, session.propertyId, staffAccess);
      return null;
    });
    if (error) return Response.json({ error }, { status: 409 });
    return Response.json(await listUsers(session.propertyId));
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
export const PUT = withRequestContext(routePUT);
export const PATCH = withRequestContext(routePATCH);
export const DELETE = withRequestContext(routeDELETE);
