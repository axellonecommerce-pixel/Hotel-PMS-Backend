import { NextResponse } from "next/server";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";
import { requireOpenShift, ShiftRequiredError } from "@/server/finance/shift-guard";

const paymentSchema = z.object({
  // The existing workspace uses a client folio handle. The authoritative
  // production folio is resolved server-side from the tenant reservation.
  folioId: z.string().trim().min(1),
  amountCents: z.number().int().positive(),
  method: z.string().trim().min(1).max(100).refine((value) => value !== "Select a payment method", {
    message: "Select a payment method.",
  }),
  note: z.string().trim().max(2_000).optional(),
  last4: z.string().trim().regex(/^\d{4}$/).optional(),
  reference: z.string().trim().max(200).optional(),
}).superRefine((value, context) => {
  if (value.method.toUpperCase() === "BAD DEBT" && !value.note?.trim()) {
    context.addIssue({ code: "custom", path: ["note"], message: "A reason is required when recording bad debt." });
  }
  if (value.method.toUpperCase() === "OTA COMMISSION") {
    context.addIssue({ code: "custom", path: ["method"], message: "OTA commission is settled automatically from the reservation source." });
  }
  if (value.method.toUpperCase() === "DIRECT BILL") {
    context.addIssue({ code: "custom", path: ["method"], message: "Direct bill balances move to the company invoice automatically at checkout." });
  }
});

const refundSchema = z.object({ paymentId: z.string().uuid(), folioId: z.string().uuid(), amountCents: z.number().int().positive() });
const deleteSchema = z.object({ paymentId: z.string().uuid() });

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

export async function GET(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = await routeParams(context);
    // Every payment applied to this stay's folios, including part of another
    // guest's payment transferred here; allocatedCents is the part applied.
    const payments = await productionSql()<Array<{ id: string; amountCents: number; allocatedCents: number; method: string; folioId: string; note: string | null; last4: string | null; reference: string | null; refundedCents: number; createdAt: string; transferredFrom: string | null }>>`
      select p.id,p.amount_cents as "amountCents",pa.amount_cents as "allocatedCents",p.method,pa.folio_id as "folioId",p.note,p.last4,p.external_reference as reference,
        coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id),0)::int as "refundedCents",p.created_at::text as "createdAt",
        case when p.reservation_id is distinct from ${reservationId}::uuid then (select src.confirmation_number from reservations src where src.id=p.reservation_id) end as "transferredFrom"
      from payments p join payment_allocations pa on pa.payment_id=p.id join folios f on f.id=pa.folio_id
      where p.property_id=${session.propertyId}::uuid and f.reservation_id=${reservationId}::uuid
      order by p.created_at desc
    `;
    return Response.json({ payments });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = await routeParams(context);
    const parsed = paymentSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues.find((issue) => issue.path[0] === "method")?.message ?? "Enter a valid payment amount and method." }, { status: 400 });
    const payment = await productionSql().begin(async (tx) => {
      if (parsed.data.method.toUpperCase() !== "BAD DEBT") await requireOpenShift(tx, session.propertyId, "collect a payment");
      const [folio] = await tx<Array<{ id: string; balanceCents: number; reservationStatus: string; companyName: string | null }>>`
        select f.id,r.status as "reservationStatus",(select c.name from companies c where c.id=r.company_id) as "companyName",(
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c where c.folio_id=f.id and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0)
        )::int as "balanceCents"
        from folios f join reservations r on r.id=f.reservation_id
        where f.id=${parsed.data.folioId}::uuid and f.reservation_id=${reservationId}::uuid and r.property_id=${session.propertyId}::uuid
        for update
      `;
      if (!folio) throw new Error("Folio not found.");
      // FR-COM-002: a company stay is billed to the company, never the guest.
      if (folio.companyName) throw new Error(`Payment is not collected from the guest. This stay is billed to ${folio.companyName}; the balance moves to the company invoice at checkout.`);
      if (parsed.data.amountCents > folio.balanceCents) throw new Error("Payment cannot exceed the folio balance.");
      const isBadDebt = parsed.data.method.toUpperCase() === "BAD DEBT";
      if (isBadDebt && folio.reservationStatus !== "checked_in") throw new Error("Bad debt can only be recorded for an in-house stay.");
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      const [created] = await tx<Array<{ id: string; createdAt: string }>>`
        insert into payments (property_id,reservation_id,method,amount_cents,currency_code,effective_date,last4,external_reference,note)
        values (${session.propertyId}::uuid,${reservationId}::uuid,${parsed.data.method},${parsed.data.amountCents},'USD',${businessDate}::date,${parsed.data.last4 ?? null},${parsed.data.reference ?? null},${parsed.data.note ?? null})
        returning id,created_at::text as "createdAt"
      `;
      await tx`insert into payment_allocations (property_id,payment_id,folio_id,amount_cents) values (${session.propertyId}::uuid,${created.id}::uuid,${folio.id}::uuid,${parsed.data.amountCents})`;
      if (isBadDebt) await postProductionLedger(tx, {
        propertyId: session.propertyId,
        businessDate,
        resourceType: "bad-debt",
        resourceId: created.id,
        description: `Bad debt write-off: ${parsed.data.note!.trim()}`,
        debitAccount: "Bad Debt Expense",
        creditAccount: "Guest Receivable",
        amountCents: parsed.data.amountCents,
      });
      await logReservationActivity(tx, session, reservationId, "Payment", isBadDebt
        ? `Bad debt written off ${money(parsed.data.amountCents)} · ${parsed.data.note}`
        : `Payment ${money(parsed.data.amountCents)} · ${parsed.data.method}${parsed.data.last4 ? ` •••• ${parsed.data.last4}` : ""}${parsed.data.reference ? ` · Ref ${parsed.data.reference}` : ""}${parsed.data.note ? ` · ${parsed.data.note}` : ""}`);
      return { id: created.id, amountCents: parsed.data.amountCents, method: parsed.data.method, folioId: folio.id, note: parsed.data.note, last4: parsed.data.last4, reference: parsed.data.reference, refundedCents: 0, createdAt: created.createdAt };
    });
    return Response.json({ payment }, { status: 201 });
  } catch (error) {
    if (error instanceof ShiftRequiredError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && /Folio|Payment|Bad debt/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = await routeParams(context);
    const parsed = refundSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter a valid refund amount." }, { status: 400 });
    const refund = await productionSql().begin(async (tx) => {
      await requireOpenShift(tx, session.propertyId, "refund a payment");
      const [payment] = await tx<Array<{ id: string; method: string; amountCents: number; folioId: string; allocatedCents: number; refundedCents: number }>>`
        select p.id,p.method,p.amount_cents as "amountCents",pa.folio_id as "folioId",pa.amount_cents as "allocatedCents",
          coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id),0)::int as "refundedCents"
        from payments p join payment_allocations pa on pa.payment_id=p.id
        where p.id=${parsed.data.paymentId}::uuid and pa.folio_id=${parsed.data.folioId}::uuid
          and p.reservation_id=${reservationId}::uuid and p.property_id=${session.propertyId}::uuid for update
      `;
      if (!payment) throw new Error("Payment not found.");
      if (payment.method.toUpperCase() === "BAD DEBT") throw new Error("Bad debt entries cannot be refunded.");
      if (payment.method.toUpperCase() === "OTA COMMISSION") throw new Error("Payment entries for OTA commission deductions cannot be refunded.");
      if (payment.method.toUpperCase() === "DIRECT BILL") throw new Error("Payment entries for a direct bill transfer cannot be refunded.");
      if (parsed.data.amountCents > payment.amountCents - payment.refundedCents) throw new Error("Refund cannot exceed the unrefunded payment amount.");
      if (parsed.data.amountCents > payment.allocatedCents) throw new Error("Refund cannot exceed the payment allocated to this folio.");
      await tx`insert into refunds (property_id,payment_id,amount_cents,effective_date,reason) values (${session.propertyId}::uuid,${payment.id}::uuid,${parsed.data.amountCents},${await propertyBusinessDate(tx, session.propertyId)}::date,'Guest refund')`;
      await tx`update payment_allocations set amount_cents=${payment.allocatedCents - parsed.data.amountCents} where payment_id=${payment.id}::uuid and folio_id=${payment.folioId}::uuid`;
      await logReservationActivity(tx, session, reservationId, "Payment", `Refund ${money(parsed.data.amountCents)} of ${payment.method} payment`);
      return { paymentId: payment.id, refundedCents: payment.refundedCents + parsed.data.amountCents };
    });
    return Response.json({ refund });
  } catch (error) {
    if (error instanceof ShiftRequiredError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof Error && /Payment|Refund|Bad debt/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = await routeParams(context);
    const parsed = deleteSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Select a payment to delete." }, { status: 400 });
    const deleted = await productionSql().begin(async (tx) => {
      const [payment] = await tx<Array<{ id: string; method: string; amountCents: number }>>`select id,method,amount_cents as "amountCents" from payments where id=${parsed.data.paymentId}::uuid and reservation_id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update`;
      if (!payment) return false;
      if (payment.method.toUpperCase() === "BAD DEBT") throw new Error("Bad debt entries cannot be deleted.");
      if (payment.method.toUpperCase() === "OTA COMMISSION") throw new Error("Payment entries for OTA commission deductions cannot be deleted.");
      if (payment.method.toUpperCase() === "DIRECT BILL") throw new Error("Payment entries for a direct bill transfer cannot be deleted.");
      await tx`delete from refunds where payment_id=${payment.id}::uuid`;
      await tx`delete from payment_allocations where payment_id=${payment.id}::uuid`;
      await tx`delete from payments where id=${payment.id}::uuid`;
      await logReservationActivity(tx, session, reservationId, "Payment", `Payment deleted · ${money(payment.amountCents)} ${payment.method}`);
      return true;
    });
    if (!deleted) return Response.json({ error: "Payment not found." }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof Error && /Bad debt|OTA commission|direct bill/.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
