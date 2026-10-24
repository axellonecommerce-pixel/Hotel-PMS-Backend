import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { recordChange } from "@/server/realtime/change-events";

const companyQuerySchema = z.object({ companyId: z.string().uuid() });
const sendInvoiceSchema = z.object({ action: z.literal("send"), invoiceId: z.string().uuid() });
const paymentSchema = z.object({
  companyId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  method: z.string().trim().min(1).max(100),
  reference: z.string().trim().max(200).optional(),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amountCents: z.number().int().positive() })).max(100),
});

function invoiceStatus(status: string) {
  if (status === "partially_paid") return "Partially Paid";
  return status.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = companyQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Select a valid company." }, { status: 400 });
    const { companyId } = parsed.data;
    const sql = productionSql();
    const invoices = await sql<Array<Record<string, unknown>>>`
      select i.id, i.company_id as "companyId", i.number as "invoiceNumber",
        (i.created_at at time zone coalesce((select timezone from properties where id=i.property_id),'UTC'))::date::text as "invoiceDate", i.sent_at::text as "sentAt", i.due_date::text as "dueDate", i.status,
        coalesce((select sum(il.amount_cents) from invoice_lines il where il.invoice_id=i.id),0)::int as "totalCents",
        coalesce((select sum(ipa.amount_cents) from invoice_payment_allocations ipa where ipa.invoice_id=i.id),0)::int as "paymentsCreditsCents",
        r.id as "reservationId", concat(g.first_name, ' ', g.last_name) as "guestName"
      from invoices i
      join reservations r on r.id=i.reservation_id
      left join lateral (
        select g.first_name, g.last_name from reservation_guests rg join guests g on g.id=rg.guest_id
        where rg.reservation_id=r.id and rg."primary"=true limit 1
      ) g on true
      where i.property_id=${session.propertyId}::uuid and i.company_id=${companyId}::uuid
      order by i.created_at desc
    `;
    const payments = await sql<Array<Record<string, unknown>>>`
      select ipa.id, p.company_id as "companyId", i.number as "invoiceNumber", p.effective_date::text as "paymentDate",
        p.method as "paymentType", ipa.amount_cents as "amountCents", coalesce(p.external_reference,p.id::text) as reference,
        p.id as "receiptId"
      from invoice_payment_allocations ipa
      join payments p on p.id=ipa.payment_id
      join invoices i on i.id=ipa.invoice_id
      where p.property_id=${session.propertyId}::uuid and p.company_id=${companyId}::uuid
      order by p.created_at desc, ipa.created_at desc
    `;
    return Response.json({
      invoices: invoices.map((invoice) => {
        const totalCents = Number(invoice.totalCents ?? 0);
        const paymentsCreditsCents = Number(invoice.paymentsCreditsCents ?? 0);
        const amountDueCents = Math.max(0, totalCents - paymentsCreditsCents);
        return { ...invoice, status: invoiceStatus(String(invoice.status)), subtotalCents: totalCents, taxCents: 0, totalCents, paymentsCreditsCents, amountDueCents };
      }),
      payments,
    });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = sendInvoiceSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Invoice action is invalid." }, { status: 400 });
    const [invoice] = await productionSql()<Array<{ id: string; status: string; sentAt: string }>>`
      update invoices
      set status=case when status='draft' then 'sent' else status end,
        sent_at=now(), updated_at=now()
      where id=${parsed.data.invoiceId}::uuid and property_id=${session.propertyId}::uuid
        and status in ('draft','sent','partially_paid','paid','overdue')
      returning id,status,sent_at::text as "sentAt"
    `;
    if (!invoice) return Response.json({ error: "Only a current, non-void invoice can be sent." }, { status: 409 });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "invoice", entityId: invoice.id, action: "updated", entityVersion: Math.floor(Date.now() / 1000), payload: { status: invoice.status, sentAt: invoice.sentAt } });
    return Response.json({ invoice: { id: invoice.id, status: invoiceStatus(invoice.status), sentAt: invoice.sentAt } });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = paymentSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter a valid company payment and invoice allocations." }, { status: 400 });
    const input = parsed.data;
    const allocatedCents = input.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    if (allocatedCents > input.amountCents) return Response.json({ error: "Invoice allocations cannot exceed the payment received." }, { status: 400 });
    const payment = await productionSql().begin(async (tx) => {
      const [company] = await tx<Array<{ id: string }>>`select id from companies where id=${input.companyId}::uuid and property_id=${session.propertyId}::uuid for update`;
      if (!company) throw new Error("Company not found.");
      const invoiceIds = input.allocations.map((allocation) => allocation.invoiceId);
      if (invoiceIds.length !== new Set(invoiceIds).size) throw new Error("Each invoice can be allocated only once per payment.");
      const invoices = invoiceIds.length ? await tx<Array<{ id: string; totalCents: number; paidCents: number }>>`
        select i.id,coalesce((select sum(il.amount_cents) from invoice_lines il where il.invoice_id=i.id),0)::int as "totalCents",
          coalesce((select sum(ipa.amount_cents) from invoice_payment_allocations ipa where ipa.invoice_id=i.id),0)::int as "paidCents"
        from invoices i
        where i.property_id=${session.propertyId}::uuid and i.company_id=${input.companyId}::uuid and i.id in ${tx(invoiceIds)}
          and i.status not in ('void','draft') for update
      ` : [];
      if (invoices.length !== invoiceIds.length) throw new Error("Select only sent company invoices.");
      for (const allocation of input.allocations) {
        const invoice = invoices.find((item) => item.id === allocation.invoiceId)!;
        if (allocation.amountCents > invoice.totalCents - invoice.paidCents) throw new Error("An allocation exceeds its invoice balance.");
      }
      const [created] = await tx<Array<{ id: string; effectiveDate: string }>>`
        insert into payments (property_id,company_id,method,amount_cents,currency_code,effective_date,external_reference)
        values (${session.propertyId}::uuid,${input.companyId}::uuid,${input.method},${input.amountCents},'USD',${await propertyBusinessDate(tx, session.propertyId)}::date,${input.reference ?? null})
        returning id,effective_date::text as "effectiveDate"
      `;
      for (const allocation of input.allocations) {
        await tx`insert into invoice_payment_allocations (property_id,payment_id,invoice_id,amount_cents) values (${session.propertyId}::uuid,${created.id}::uuid,${allocation.invoiceId}::uuid,${allocation.amountCents})`;
        const invoice = invoices.find((item) => item.id === allocation.invoiceId)!;
        const due = invoice.totalCents - invoice.paidCents - allocation.amountCents;
        await tx`update invoices set status=${due === 0 ? "paid" : "partially_paid"},updated_at=now() where id=${allocation.invoiceId}::uuid`;
      }
      const creditCents = input.amountCents - allocatedCents;
      if (creditCents) await tx`insert into company_credits (property_id,company_id,source_payment_id,original_amount_cents,remaining_amount_cents) values (${session.propertyId}::uuid,${input.companyId}::uuid,${created.id}::uuid,${creditCents},${creditCents})`;
      return { id: created.id, effectiveDate: created.effectiveDate, creditCents };
    });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: input.companyId, action: "updated", entityVersion: Math.floor(Date.now() / 1000), payload: { paymentId: payment.id } });
    return Response.json({ payment }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /Company|invoice|allocation/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
