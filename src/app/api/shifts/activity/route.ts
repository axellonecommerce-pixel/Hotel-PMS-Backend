import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";

type ActivityLine = { at: string; type: string; method: string; reference: string; guest: string; room: string; amountCents: number; note: string };

/**
 * HotelKey "Clerk Activity": every payment, refund, deposit, and paid out
 * taken during one shift (the open shift, or `?shiftId=` for a closed one),
 * with totals by payment method.
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const sql = productionSql();
    const shiftId = new URL(request.url).searchParams.get("shiftId");
    const [shift] = await sql<Array<{ id: string; clerk: string; shiftName: string; openedAt: string; closedAt: string | null; openingCents: number; expectedCents: number | null; countedCents: number | null; droppedCents: number | null; businessDate: string; timezone: string }>>`
      select cs.id, e.name as clerk, split_part(cs.status, ':', 2) as "shiftName",
        to_char(cs.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "openedAt",
        to_char(cs.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "closedAt",
        cs.opening_cents as "openingCents", cs.expected_cents as "expectedCents", cs.counted_cents as "countedCents",
        (select sum(d.amount_cents) from cash_drops d where d.cash_shift_id=cs.id)::int as "droppedCents",
        bd.business_date::text as "businessDate", p.timezone
      from cash_shifts cs join employees e on e.id=cs.employee_id join business_days bd on bd.id=cs.business_day_id join properties p on p.id=cs.property_id
      where cs.property_id=${session.propertyId}::uuid and (${shiftId}::uuid is null and cs.status like 'open:%' or cs.id=${shiftId}::uuid)
      order by cs.opened_at desc limit 1
    `;
    if (!shift) return Response.json({ error: "That shift was not found." }, { status: 404 });
    const from = shift.openedAt;
    const to = shift.closedAt;
    const lines = await sql<ActivityLine[]>`
      with guest_of as (
        select r.id, coalesce(nullif(trim(concat_ws(' ', g.first_name, g.last_name)), ''), '') as guest, r.confirmation_number as confirmation,
          coalesce((select room.number from reservation_rooms rr join rooms room on room.id=rr.room_id where rr.reservation_id=r.id order by rr.created_at limit 1), '') as room
        from reservations r left join guests g on g.id=r.main_guest_id where r.property_id=${session.propertyId}::uuid
      )
      select to_char(x.at at time zone ${shift.timezone}, 'MM/DD HH12:MI AM') as at, x.type, x.method, x.reference, x.guest, x.room, x."amountCents", x.note from (
        select p.created_at as at, 'Payment' as type, p.method || coalesce(' ··' || p.last4, '') as method,
          coalesce(go.confirmation, c.name, ha.name, '') as reference, coalesce(go.guest, c.name, ha.name, '') as guest, coalesce(go.room, '') as room,
          p.amount_cents as "amountCents", coalesce(p.note, '') as note
        from payments p left join guest_of go on go.id=p.reservation_id left join companies c on c.id=p.company_id left join house_accounts ha on ha.id=p.house_account_id
        where p.property_id=${session.propertyId}::uuid and p.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or p.created_at < ${to}::timestamptz)
        union all
        select rf.created_at, 'Refund', p.method || coalesce(' ··' || p.last4, ''), coalesce(go.confirmation, ''), coalesce(go.guest, ''), coalesce(go.room, ''), -rf.amount_cents, coalesce(rf.reason, '')
        from refunds rf join payments p on p.id=rf.payment_id left join guest_of go on go.id=p.reservation_id
        where rf.property_id=${session.propertyId}::uuid and rf.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or rf.created_at < ${to}::timestamptz)
        union all
        select d.created_at, 'Deposit collected', d.method, coalesce(go.confirmation, ''), coalesce(go.guest, ''), coalesce(go.room, ''), d.amount_cents, ''
        from security_deposits d join reservation_rooms rr on rr.id=d.reservation_room_id left join guest_of go on go.id=rr.reservation_id
        where d.property_id=${session.propertyId}::uuid and d.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or d.created_at < ${to}::timestamptz)
        union all
        select dt.created_at, 'Deposit ' || dt.type, d.method, coalesce(go.confirmation, ''), coalesce(go.guest, ''), coalesce(go.room, ''), -dt.amount_cents, coalesce(dt.reason, dt.note, '')
        from deposit_transactions dt join security_deposits d on d.id=dt.deposit_id join reservation_rooms rr on rr.id=d.reservation_room_id left join guest_of go on go.id=rr.reservation_id
        where dt.property_id=${session.propertyId}::uuid and dt.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or dt.created_at < ${to}::timestamptz)
        union all
        select po.created_at, 'Paid out', 'Cash', po.reason, po.paid_to, '', -po.amount_cents, coalesce(po.note, '')
        from paid_outs po
        where po.property_id=${session.propertyId}::uuid and po.created_at >= ${from}::timestamptz and (${to}::timestamptz is null or po.created_at < ${to}::timestamptz)
      ) x order by x.at
    `;
    // Totals by method (card numbers dropped so each card type adds up together).
    const byMethod = new Map<string, number>();
    for (const line of lines) {
      const method = line.method.split(" ··")[0];
      byMethod.set(method, (byMethod.get(method) ?? 0) + line.amountCents);
    }
    return Response.json({
      shift,
      lines,
      totals: [...byMethod.entries()].map(([method, amountCents]) => ({ method, amountCents })).sort((left, right) => left.method.localeCompare(right.method)),
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
