import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  view: z.enum(["folios", "refunds", "bad-debt", "direct-billing", "outstanding-invoices"]),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const sql = productionSql();
    if (input.data.view === "refunds") {
      const records = await sql<Array<{ id: string; date: string; guest: string; method: string; amountCents: number; reason: string | null }>>`
        select ref.id,ref.effective_date::text as date,coalesce(g.first_name||' '||g.last_name,'Unassigned guest') as guest,
          p.method,ref.amount_cents as "amountCents",ref.reason
        from refunds ref join payments p on p.id=ref.payment_id left join reservations r on r.id=p.reservation_id
          left join reservation_guests rg on rg.reservation_id=r.id and rg.primary=true left join guests g on g.id=rg.guest_id
        where ref.property_id=${session.propertyId}::uuid and ref.effective_date between ${input.data.startDate}::date and ${input.data.endDate}::date
        order by ref.effective_date desc,ref.created_at desc
      `;
      const total = records.reduce((sum, record) => sum + record.amountCents, 0);
      return Response.json({ report: { metrics: [{ label: "Refunded", value: total, format: "money" }, { label: "Refund Count", value: records.length, format: "number" }], columns: [{ key: "date", label: "Date", format: "date" }, { key: "guest", label: "Guest" }, { key: "method", label: "Original Payment" }, { key: "reason", label: "Reason" }, { key: "amount", label: "Refund", format: "money", align: "right" }], rows: records.map((record) => ({ id: record.id, date: record.date, guest: record.guest, method: record.method, reason: record.reason ?? "—", amount: record.amountCents })), note: "Refunds are tenant-scoped posted refund records in the selected effective-date range." } });
    }
    if (input.data.view === "bad-debt") {
      const records = await sql<Array<{ id: string; date: string; guest: string; amountCents: number; note: string | null }>>`
        select p.id,p.effective_date::text as date,coalesce(g.first_name||' '||g.last_name,'Unassigned guest') as guest,p.amount_cents as "amountCents",p.note
        from payments p left join reservations r on r.id=p.reservation_id left join reservation_guests rg on rg.reservation_id=r.id and rg.primary=true left join guests g on g.id=rg.guest_id
        where p.property_id=${session.propertyId}::uuid and p.method='BAD DEBT' and p.effective_date between ${input.data.startDate}::date and ${input.data.endDate}::date
        order by p.effective_date desc,p.created_at desc
      `;
      const total = records.reduce((sum, record) => sum + record.amountCents, 0);
      return Response.json({ report: { metrics: [{ label: "Bad Debt Loss", value: total, format: "money" }, { label: "Accounts", value: records.length, format: "number" }], columns: [{ key: "date", label: "Date", format: "date" }, { key: "guest", label: "Guest" }, { key: "amount", label: "Loss", format: "money", align: "right" }, { key: "note", label: "Reason" }], rows: records.map((record) => ({ id: record.id, date: record.date, guest: record.guest, amount: record.amountCents, note: record.note ?? "—" })), note: "Bad debt is reported from its separately recorded loss payment method; it is not revenue." } });
    }
    if (input.data.view === "folios") {
      const records = await sql<Array<{ id: string; number: string; guest: string; created: string; type: string; totalCents: number; allocatedCents: number }>>`
        select f.id,f.number,coalesce(g.first_name||' '||g.last_name,'Unassigned guest') as guest,f.created_at::date::text as created,
          case when r.company_id is null then 'General' else 'Direct Bill' end as type,
          coalesce((select sum(c.amount_cents) from charges c where c.folio_id=f.id and c.status='posted'),0)::int as "totalCents",
          coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0)::int as "allocatedCents"
        from folios f join reservations r on r.id=f.reservation_id left join reservation_guests rg on rg.reservation_id=r.id and rg.primary=true left join guests g on g.id=rg.guest_id
        where f.property_id=${session.propertyId}::uuid and f.created_at::date between ${input.data.startDate}::date and ${input.data.endDate}::date
        order by f.created_at desc
      `;
      return Response.json({ report: { metrics: [{ label: "Folios", value: records.length, format: "number" }, { label: "Total Charges", value: records.reduce((sum, record) => sum + record.totalCents, 0), format: "money" }, { label: "Payments / Credits", value: records.reduce((sum, record) => sum + record.allocatedCents, 0), format: "money" }, { label: "Balance", value: records.reduce((sum, record) => sum + record.totalCents - record.allocatedCents, 0), format: "money" }], columns: [{ key: "folio", label: "Folio Number" }, { key: "guest", label: "Guest" }, { key: "date", label: "Created", format: "date" }, { key: "type", label: "Type" }, { key: "total", label: "Total", format: "money", align: "right" }, { key: "balance", label: "Balance", format: "money", align: "right" }], rows: records.map((record) => ({ id: record.id, folio: record.number, guest: record.guest, date: record.created, type: record.type, total: record.totalCents, balance: record.totalCents-record.allocatedCents })), note: "Folio balances are posted charges less payment allocations. Company invoices are reported separately." } });
    }
    const records = await sql<Array<{ id: string; date: string; number: string; company: string; status: string; totalCents: number; paidCents: number }>>`
      select i.id,i.due_date::text as date,i.number,c.name as company,i.status,
        coalesce((select sum(il.amount_cents) from invoice_lines il where il.invoice_id=i.id),0)::int as "totalCents",
        coalesce((select sum(ipa.amount_cents) from invoice_payment_allocations ipa where ipa.invoice_id=i.id),0)::int as "paidCents"
      from invoices i join companies c on c.id=i.company_id
      where i.property_id=${session.propertyId}::uuid
        and i.due_date between ${input.data.startDate}::date and ${input.data.endDate}::date
        ${input.data.view === "outstanding-invoices" ? sql`and i.status not in ('paid','void')` : sql``}
      order by i.due_date,i.number
    `;
    const outstanding = records.reduce((sum, record) => sum + record.totalCents-record.paidCents, 0);
    return Response.json({ report: { metrics: [{ label: input.data.view === "direct-billing" ? "Invoices" : "Open Invoices", value: records.length, format: "number" }, { label: "Billed", value: records.reduce((sum, record) => sum + record.totalCents, 0), format: "money" }, { label: "Collected", value: records.reduce((sum, record) => sum + record.paidCents, 0), format: "money" }, { label: "Amount Due", value: outstanding, format: "money" }], columns: [{ key: "invoice", label: "Invoice" }, { key: "company", label: "Company" }, { key: "due", label: "Due Date", format: "date" }, { key: "status", label: "Status", format: "status" }, { key: "total", label: "Billed", format: "money", align: "right" }, { key: "paid", label: "Collected", format: "money", align: "right" }, { key: "dueAmount", label: "Amount Due", format: "money", align: "right" }], rows: records.map((record) => ({ id: record.id, invoice: record.number, company: record.company, due: record.date, status: record.status, total: record.totalCents, paid: record.paidCents, dueAmount: record.totalCents-record.paidCents })), note: input.data.view === "direct-billing" ? "Direct-billing invoice balances are calculated from durable invoice lines and company payment allocations." : "Outstanding invoices exclude paid and void invoices and are filtered by due date." } });
  } catch (error) { return propertyAccessResponse(error); }
}
