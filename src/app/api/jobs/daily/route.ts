import { timingSafeEqual } from "node:crypto";
import { KEEP_FOREVER } from "@/domain/rules/retention";
import { deletePrivateFiles } from "@/server/storage/private-files";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { postDueRecurringExpenses } from "@/server/expenses/recurring";
import { autoDepositCards } from "@/server/finance/card-settlements";
import { settleStaleTerminalPayments, syncPayouts } from "@/server/terminal/terminal-service";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (hasProductionDatabase()) {
    const sql = productionSql();
    // Guest ID photos are not kept (owner's rule): any photo still stored is
    // deleted from private storage, while the guest and their ID type and
    // number stay. Old "ID photo deletion" notices are cleared.
    const photos = await sql<Array<{ storageKey: string }>>`
      select storage_key as "storageKey" from guest_identities where storage_key is not null
      union select storage_key from attachments where resource_type like 'guest-id%' and storage_key is not null`;
    // In batches; a batch's database entries are cleared only after its files are gone.
    for (let start = 0; start < photos.length; start += 500) {
      const keys = photos.slice(start, start + 500).map((photo) => photo.storageKey);
      await deletePrivateFiles(keys);
      // Only the photo goes: the ID type and number stay visible on the guest.
      await sql`update guest_identities set storage_key=null, delete_after=${KEEP_FOREVER}::timestamptz, warned_at=null where storage_key = any(${keys}::text[])`;
      await sql`delete from attachments where resource_type like 'guest-id%' and storage_key = any(${keys}::text[])`;
    }
    // The old one-year photo rule hid the whole ID record when it removed a
    // photo. The ID details are guest data and are kept: show them again.
    await sql`update guest_identities set deleted_at=null, delete_after=${KEEP_FOREVER}::timestamptz, warned_at=null where deleted_at is not null and storage_key is null`;
    await sql`update notifications set read_at=coalesce(read_at,now()), resolved_at=coalesce(resolved_at,now()) where type='ID_IMAGE_DELETION' and resolved_at is null`.catch(() => undefined);
    const reminders = await sql<Array<{ id: string; propertyId: string; number: string; dueDate: string }>>`
      select i.id,i.property_id as "propertyId",i.number,i.due_date::text as "dueDate"
      from invoices i
      where i.status in ('sent','partially_paid','overdue') and i.due_date <= current_date
        and not exists (
          select 1 from notifications n where n.property_id=i.property_id and n.resource_type='invoice'
            and n.resource_id=i.id and n.type='INVOICE_REMINDER' and n.created_at > now()-interval '7 days'
        )
    `;
    for (const invoice of reminders) await sql.begin(async (tx) => {
      await tx`update invoices set status=case when due_date<current_date then 'overdue' else status end,updated_at=now() where id=${invoice.id}::uuid`;
      await tx`insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
        values (${invoice.propertyId}::uuid,'manager','INVOICE_REMINDER','Company invoice requires follow-up',${`${invoice.number} was due ${invoice.dueDate}.`},'invoice',${invoice.id}::uuid)`;
    });
    const recurringExpensesPosted = await sql.begin((tx) => postDueRecurringExpenses(tx));
    // Automatic card deposits, one motel at a time so one motel's problem never stops another's.
    let cardDeposits = 0;
    const autoDepositMotels = await sql<Array<{ propertyId: string }>>`select property_id as "propertyId" from property_settings where key='card_deposits' and coalesce((value->>'enabled')::boolean,false)`;
    for (const motel of autoDepositMotels) {
      try { cardDeposits += await sql.begin((tx) => autoDepositCards(tx, motel.propertyId)); }
      catch (error) { console.error("Automatic card deposit failed", motel.propertyId, error instanceof Error ? error.message : "unknown error"); }
    }
    // Connected card terminals: finish charges left waiting, then turn paid payouts into deposits with exact fees.
    const terminalMotels = await sql<Array<{ propertyId: string }>>`select property_id as "propertyId" from payment_terminal_connections where status<>'disconnected'`;
    for (const motel of terminalMotels) {
      try {
        await settleStaleTerminalPayments(sql, motel.propertyId, 120);
        cardDeposits += (await syncPayouts(sql, motel.propertyId)).deposits;
      } catch (error) { console.error("Card terminal sync failed", motel.propertyId, error instanceof Error ? error.message : "unknown error"); }
    }
    // Pay reminders: the day before and on each employee's pay date (in the
    // motel's time zone), for pay not paid, deleted or only a custom range.
    const payDue = await sql<Array<{ id: string; propertyId: string; name: string; cents: number; start: string; end: string; payDate: string; when: "today" | "tomorrow" }>>`
      with local as (select id,(now() at time zone coalesce(timezone,'America/Los_Angeles'))::date as today from properties)
      select pe.id,pe.property_id as "propertyId",e.name,
        (pe.gross_pay_cents + coalesce(case when pe.description ~ '^\\s*\\{' then (pe.description::jsonb->>'adjustmentCents')::int end,0))::int as cents,
        pp.starts_on::text as start,pp.ends_on::text as "end",pp.scheduled_pay_date::text as "payDate",
        case when pp.scheduled_pay_date=l.today then 'today' else 'tomorrow' end as "when"
      from payroll_entries pe join pay_periods pp on pp.id=pe.pay_period_id join employees e on e.id=pe.employee_id join local l on l.id=pe.property_id
      where pe.paid=false and e.active and pp.scheduled_pay_date in (l.today, l.today + 1)
        and coalesce(pe.description,'') !~ '"removed": ?true'
        and (pp.status<>'custom' or coalesce(pe.description,'') like '%"Approved"%')
        and pe.gross_pay_cents > 0
    `;
    let payReminders = 0;
    for (const due of payDue) {
      const title = `Pay ${due.name} ${due.when}`;
      const message = `$${(due.cents / 100).toFixed(2)} for ${due.start} to ${due.end}, pay date ${due.payDate}. Open Payroll and press Pay.`;
      const inserted = await sql`
        insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
        select ${due.propertyId}::uuid,role,'PAYROLL_REMINDER',${title},${message},'payroll_entry',${due.id}::uuid from unnest(array['owner','manager']) as role
        where not exists (select 1 from notifications n where n.property_id=${due.propertyId}::uuid and n.type='PAYROLL_REMINDER' and n.resource_id=${due.id}::uuid and n.title=${title})
        returning id
      `;
      if (inserted.length) payReminders += 1;
    }
    return Response.json({ idPhotosDeleted: photos.length, invoiceReminders: reminders.length, recurringExpensesPosted, cardDeposits, payReminders });
  }
  // Demo database: nothing is deleted on a schedule either.
  return Response.json({ idPhotosDeleted: 0 });
}

export const GET = POST;
