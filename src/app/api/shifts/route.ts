import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";

// HotelKey "Start / End Shift": a clerk opens a shift by counting the cash in
// the drawer, takes payments during the shift, and closes it by counting the
// drawer again. Cash activity is attributed to the shift by time, so two
// shifts on one business day never double-count the same payment.
const startSchema = z.object({
  action: z.literal("start"),
  // A shift is identified by its clerk and start time, not a named period.
  shiftName: z.string().trim().min(1).max(40).default("Shift"),
  openingCents: z.number().int().nonnegative().max(10_000_000),
  note: z.string().trim().max(500).optional(),
});
const endSchema = z.object({
  action: z.literal("end"),
  countedCents: z.number().int().nonnegative().max(10_000_000),
  droppedCents: z.number().int().nonnegative().max(10_000_000),
  note: z.string().trim().max(2_000).optional(),
});
const requestSchema = z.discriminatedUnion("action", [startSchema, endSchema]);

type Db = Sql | TransactionSql<Record<string, never>>;
type OpenShift = { id: string; shiftName: string; employeeId: string; clerk: string; openedAt: string; openingCents: number; businessDate: string };

class ShiftError extends Error {}

/** Cash taken in and paid out between two instants. */
async function cashActivityBetween(db: Db, propertyId: string, from: string, to: string | null) {
  const [row] = await db<Array<{ paymentCents: number; refundCents: number; depositCents: number; paidOutCents: number }>>`
    select
      coalesce((select sum(p.amount_cents) from payments p where p.property_id=${propertyId}::uuid and lower(p.method) like '%cash%'
        and p.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or p.created_at < ${to}::timestamptz)),0)::int as "paymentCents",
      coalesce((select sum(r.amount_cents) from refunds r join payments p on p.id=r.payment_id where r.property_id=${propertyId}::uuid and lower(p.method) like '%cash%'
        and r.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or r.created_at < ${to}::timestamptz)),0)::int as "refundCents",
      -- Cash security deposits sit in the drawer until released.
      coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=${propertyId}::uuid and le.account='Cash'
        and le.resource_type in ('deposit-collect','deposit-release')
        and le.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or le.created_at < ${to}::timestamptz)),0)::int as "depositCents",
      coalesce((select sum(po.amount_cents) from paid_outs po where po.property_id=${propertyId}::uuid
        and po.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or po.created_at < ${to}::timestamptz)),0)::int as "paidOutCents"
  `;
  return { ...row, netCents: row.paymentCents - row.refundCents + row.depositCents - row.paidOutCents };
}

async function openShift(db: Db, propertyId: string) {
  const [shift] = await db<OpenShift[]>`
    select cs.id, split_part(cs.status, ':', 2) as "shiftName", cs.employee_id as "employeeId", e.name as clerk,
      to_char(cs.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "openedAt", cs.opening_cents as "openingCents", bd.business_date::text as "businessDate"
    from cash_shifts cs join employees e on e.id=cs.employee_id join business_days bd on bd.id=cs.business_day_id
    where cs.property_id=${propertyId}::uuid and cs.status like 'open:%'
    order by cs.opened_at desc limit 1
  `;
  return shift ?? null;
}

/**
 * The signed-in user's employee record (the clerk). Any staff login can run a
 * shift; a login without an employee record gets one named from its account.
 */
async function clerkFor(db: Db, propertyId: string, authUserId: string) {
  const [employee] = await db<Array<{ id: string; name: string }>>`
    select e.id, e.name from employees e join property_memberships m on m.id=e.membership_id
    where m.auth_user_id=${authUserId}::uuid and m.property_id=${propertyId}::uuid and e.active order by e.created_at limit 1
  `;
  if (employee) return employee;
  const [membership] = await db<Array<{ id: string; role: string; name: string; email: string | null }>>`
    select m.id, m.role,
      coalesce(nullif(u.raw_user_meta_data->>'full_name',''), nullif(u.raw_user_meta_data->>'name',''), split_part(u.email,'@',1), initcap(replace(m.role,'_',' '))) as name,
      u.email
    from property_memberships m left join auth.users u on u.id=m.auth_user_id
    where m.auth_user_id=${authUserId}::uuid and m.property_id=${propertyId}::uuid and m.active limit 1
  `;
  if (!membership) return null;
  const [created] = await db<Array<{ id: string; name: string }>>`
    insert into employees (property_id, membership_id, name, email, job_role, pay_method)
    values (${propertyId}::uuid, ${membership.id}::uuid, ${membership.name}, ${membership.email}, ${membership.role === "front_desk" ? "Front Desk" : membership.role.charAt(0).toUpperCase() + membership.role.slice(1)}, 'hourly')
    returning id, name
  `;
  return created;
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const sql = productionSql();
    const shift = await openShift(sql, session.propertyId);
    if (!shift) return Response.json({ shift: null });
    const activity = await cashActivityBetween(sql, session.propertyId, shift.openedAt, null);
    return Response.json({ shift: { ...shift, activity, expectedCents: Math.max(0, shift.openingCents + activity.netCents) } });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter the cash counted in the drawer." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      // One drawer: serialize shift changes for the property.
      await tx`select pg_advisory_xact_lock(hashtext(${`shift:${session.propertyId}`}))`;
      const current = await openShift(tx, session.propertyId);
      if (input.action === "start") {
        if (current) throw new ShiftError(`${current.clerk} already has the ${current.shiftName} open. End that shift first.`);
        const clerk = await clerkFor(tx, session.propertyId, session.authUserId);
        if (!clerk) throw new ShiftError("Your login is not linked to an active employee. Add yourself under Settings → Employees.");
        const businessDate = await propertyBusinessDate(tx, session.propertyId);
        const [businessDay] = await tx<Array<{ id: string }>>`
          insert into business_days (property_id,business_date,status,opened_at) values (${session.propertyId}::uuid,${businessDate}::date,'open',now())
          on conflict (property_id,business_date) do update set business_date=excluded.business_date returning id
        `;
        // The clerk enters the drawer balance; there is no fixed float, so the drawer's float is what it opened with.
        const [created] = await tx<Array<{ id: string; openedAt: string }>>`
          insert into cash_shifts (property_id,business_day_id,employee_id,opening_cents,drawer_float_cents,status,opened_at)
          values (${session.propertyId}::uuid,${businessDay.id}::uuid,${clerk.id}::uuid,${input.openingCents},${input.openingCents},${`open:${input.shiftName}`},now())
          returning id, to_char(opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "openedAt"
        `;
        if (input.note) {
          await tx`insert into cash_shift_transactions (property_id,cash_shift_id,type,amount_cents,note)
            values (${session.propertyId}::uuid,${created.id}::uuid,'opening_count',${input.openingCents},${input.note})`;
        }
        return { started: { id: created.id, clerk: clerk.name, shiftName: input.shiftName, openedAt: created.openedAt } };
      }
      if (!current) throw new ShiftError("There is no open shift to end.");
      const activity = await cashActivityBetween(tx, session.propertyId, current.openedAt, null);
      const expectedCents = Math.max(0, current.openingCents + activity.netCents);
      if (input.droppedCents > input.countedCents) throw new ShiftError(`You counted $${(input.countedCents / 100).toFixed(2)}; you cannot drop more than that.`);
      if (input.countedCents !== expectedCents && !input.note) throw new ShiftError(`The drawer is ${input.countedCents < expectedCents ? "short" : "over"} by $${(Math.abs(input.countedCents - expectedCents) / 100).toFixed(2)}. Add a note explaining the difference.`);
      await tx`
        update cash_shifts set status=${`closed:${current.shiftName}`}, expected_cents=${expectedCents}, counted_cents=${input.countedCents}, closed_at=now()
        where id=${current.id}::uuid
      `;
      await tx`insert into cash_drops (property_id,cash_shift_id,amount_cents,note) values (${session.propertyId}::uuid,${current.id}::uuid,${input.droppedCents},${input.note ?? null})`;
      return { ended: { id: current.id, clerk: current.clerk, shiftName: current.shiftName, openedAt: current.openedAt, openingCents: current.openingCents, activity, expectedCents, countedCents: input.countedCents, droppedCents: input.droppedCents, differenceCents: input.countedCents - expectedCents } };
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ShiftError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
