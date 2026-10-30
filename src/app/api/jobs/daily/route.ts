import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/server/db/client";
import { attachments, notifications } from "@/server/db/schema";
import { deletePrivateFiles } from "@/server/storage/private-files";
import { createHash } from "node:crypto";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { postDueRecurringExpenses } from "@/server/expenses/recurring";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (hasProductionDatabase()) {
    const sql = productionSql();
    const expiring = await sql<Array<{ id: string; propertyId: string; storageKey: string }>>`
      select id,property_id as "propertyId",storage_key as "storageKey" from guest_identities
      where storage_key is not null and warned_at is null and deleted_at is null
        and delete_after <= now() + interval '7 days'
    `;
    for (const file of expiring) await sql.begin(async (tx) => {
      await tx`insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
        values (${file.propertyId}::uuid,'manager','ID_IMAGE_DELETION','Guest ID image will be deleted','A guest ID image is scheduled for automatic deletion within seven days.','guest_identity',${file.id}::uuid)`;
      await tx`update guest_identities set warned_at=now() where id=${file.id}::uuid and warned_at is null`;
    });
    const expired = await sql<Array<{ id: string; propertyId: string; storageKey: string }>>`
      select id,property_id as "propertyId",storage_key as "storageKey" from guest_identities
      where storage_key is not null and deleted_at is null and delete_after <= now()
    `;
    await deletePrivateFiles(expired.map((file) => file.storageKey));
    for (const file of expired) await sql.begin(async (tx) => {
      await tx`update guest_identities set deleted_at=now(),storage_key=null where id=${file.id}::uuid`;
      await tx`insert into retention_tombstones (property_id,resource_type,resource_id,storage_key_hash)
        values (${file.propertyId}::uuid,'guest-id',${file.id}::uuid,${createHash("sha256").update(file.storageKey).digest("hex")})
        on conflict (property_id,resource_type,resource_id) do nothing`;
    });
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
    return Response.json({ warned: expiring.length, deleted: expired.length, invoiceReminders: reminders.length, recurringExpensesPosted, payReminders });
  }
  const now = new Date();
  const warningCutoff = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const expiring = await db.query.attachments.findMany({ where: and(eq(attachments.resourceType, "guest-id"), isNull(attachments.warnedAt), isNull(attachments.deletedAt), lte(attachments.deleteAfter, warningCutoff)) });
  for (const file of expiring) {
    db.insert(notifications).values({ id: `notification-${crypto.randomUUID()}`, propertyId: file.propertyId, type: "ID_IMAGE_DELETION", title: "Guest ID image will be deleted", detail: `${file.originalName} is scheduled for automatic deletion within seven days.`, href: "/guests", status: "Unread", createdAt: now.toISOString() }).run();
    db.update(attachments).set({ warnedAt: now.toISOString() }).where(eq(attachments.id, file.id)).run();
  }
  const expired = await db.query.attachments.findMany({ where: and(eq(attachments.resourceType, "guest-id"), isNull(attachments.deletedAt), lte(attachments.deleteAfter, now.toISOString())) });
  await deletePrivateFiles(expired.map((file) => file.storageKey));
  for (const file of expired) db.update(attachments).set({ deletedAt: now.toISOString() }).where(eq(attachments.id, file.id)).run();
  return Response.json({ warned: expiring.length, deleted: expired.length });
}

export const GET = POST;
