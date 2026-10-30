import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const staffRole = z.enum(["manager", "front_desk", "accountant"]);
const createSchema = z.object({ name: z.string().trim().min(1), email: z.string().trim().email(), password: z.string().min(10).max(128), role: staffRole });
const updateSchema = z.object({ employeeId: z.string().uuid(), role: staffRole.optional(), password: z.string().min(10).max(128).optional(), active: z.boolean().optional() });

// The owner and managers create staff logins, reset passwords and disable users (PRD §2).
const managesStaff = (role: string) => role === "owner" || role === "manager";

function adminConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("Supabase administrator access is not configured.");
  return { url, secret };
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    if (!hasProductionDatabase()) return Response.json({ users: [] });
    const users = await productionSql()<Array<{ employeeId: string; name: string; email: string; role: string; active: boolean }>>`
      select e.id as "employeeId", e.name, e.email, m.role, m.active
      from employees e join property_memberships m on m.id=e.membership_id
      where e.property_id=${session.propertyId}::uuid order by e.created_at asc
    `;
    return Response.json({ users });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    if (!managesStaff(session.role)) return Response.json({ error: "Only the owner or a manager can create staff logins." }, { status: 403 });
    if (!hasProductionDatabase()) return Response.json({ error: "Staff login setup requires the production database." }, { status: 503 });
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the staff account details." }, { status: 400 });
    const { url, secret } = adminConfig();
    const authResponse = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ email: parsed.data.email, password: parsed.data.password, email_confirm: true, user_metadata: { full_name: parsed.data.name } }) });
    if (!authResponse.ok) { const message = await authResponse.json().catch(() => ({})) as { msg?: string; message?: string }; return Response.json({ error: message.msg ?? message.message ?? "The staff login could not be created." }, { status: 409 }); }
    const auth = await authResponse.json() as { id?: string; user?: { id?: string } };
    const authUserId = auth.id ?? auth.user?.id;
    if (!authUserId) throw new Error("The staff account did not return an ID.");
    const membershipId = crypto.randomUUID(); const employeeId = crypto.randomUUID();
    await productionSql().begin(async (tx) => {
      await tx`insert into property_memberships (id,property_id,auth_user_id,role,active) values (${membershipId}::uuid,${session.propertyId}::uuid,${authUserId}::uuid,${parsed.data.role},true)`;
      await tx`insert into employees (id,property_id,membership_id,name,email,job_role,pay_method,active) values (${employeeId}::uuid,${session.propertyId}::uuid,${membershipId}::uuid,${parsed.data.name},${parsed.data.email},${parsed.data.role},'hourly',true)`;
    });
    return Response.json({ user: { employeeId, name: parsed.data.name, email: parsed.data.email, role: parsed.data.role, active: true } }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "property.manage");
    if (!managesStaff(session.role)) return Response.json({ error: "Only the owner or a manager can manage staff logins." }, { status: 403 });
    if (!hasProductionDatabase()) return Response.json({ error: "Staff login setup requires the production database." }, { status: 503 });
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the staff account changes." }, { status: 400 });
    const [user] = await productionSql()<Array<{ authUserId: string; role: string }>>`select m.auth_user_id as "authUserId",m.role from employees e join property_memberships m on m.id=e.membership_id where e.id=${parsed.data.employeeId}::uuid and e.property_id=${session.propertyId}::uuid`;
    if (!user) return Response.json({ error: "Staff account was not found." }, { status: 404 });
    // The owner's own login is changed in Platform › Manage, not here.
    if (user.role === "owner") return Response.json({ error: "The owner login cannot be changed here." }, { status: 403 });
    if (parsed.data.password) { const { url, secret } = adminConfig(); const response = await fetch(`${url}/auth/v1/admin/users/${user.authUserId}`, { method: "PUT", headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ password: parsed.data.password }) }); if (!response.ok) return Response.json({ error: "The password could not be reset." }, { status: 502 }); }
    await productionSql()`update property_memberships set role=coalesce(${parsed.data.role ?? null},role),active=coalesce(${parsed.data.active ?? null},active),updated_at=now() where auth_user_id=${user.authUserId}::uuid and property_id=${session.propertyId}::uuid`;
    return Response.json({ updated: true });
  } catch (error) { return propertyAccessResponse(error); }
}
