import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger } from "@/server/finance/production-finance";

const createSchema = z.object({
  folioId: z.string().uuid(),
  reservationRoomId: z.string().uuid().nullable().optional(),
  chargeTypeId: z.string().uuid(),
  description: z.string().trim().min(1),
  serviceDate: z.string().date(),
  amountCents: z.number().int().positive(),
  taxOverrideCents: z.number().int().nonnegative().optional(),
  taxOverrideReason: z.string().trim().min(1).optional(),
});

const editSchema = z.object({
  chargeId: z.string().uuid(),
  description: z.string().trim().min(1).optional(),
  amountCents: z.number().int().positive().optional(),
  taxOverrideCents: z.number().int().nonnegative().optional(),
  taxOverrideReason: z.string().trim().min(1).optional(),
});

type ChargeContext = {
  reservationId: string;
  taxRateBasisPoints: number;
  taxExempt: boolean;
  typeName: string;
  revenueCategory: string;
  taxable: boolean;
};

function taxAmount(context: ChargeContext, amountCents: number, override?: number, reason?: string) {
  if (override !== undefined && !reason) throw new Error("A reason is required when tax is changed manually.");
  if (context.taxExempt || !context.taxable) return 0;
  return override ?? Math.round((amountCents * context.taxRateBasisPoints) / 10_000);
}

function revenueAccount(context: Pick<ChargeContext, "revenueCategory" | "typeName">) {
  return /room/i.test(context.revenueCategory) || /room rent/i.test(context.typeName)
    ? "Room Revenue"
    : "Miscellaneous Revenue";
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Charge details are invalid." }, { status: 400 });
    const input = parsed.data;
    const charge = await productionSql().begin(async (tx) => {
      const [context] = await tx<Array<ChargeContext>>`
        select r.id as "reservationId", r.tax_rate_basis_points as "taxRateBasisPoints",
          r.tax_exempt as "taxExempt", ct.name as "typeName",
          ct.revenue_category as "revenueCategory", ct.taxable
        from folios f
        join reservations r on r.id = f.reservation_id and r.property_id = f.property_id
        join charge_types ct on ct.id = ${input.chargeTypeId}::uuid and ct.property_id = f.property_id
        where f.id = ${input.folioId}::uuid and f.property_id = ${session.propertyId}::uuid
          and f.status <> 'closed' and ct.active = true
        for update of f
      `;
      if (!context) throw new Error("The folio or charge type is unavailable.");
      const taxCents = taxAmount(context, input.amountCents, input.taxOverrideCents, input.taxOverrideReason);
      const [created] = await tx<Array<{ id: string }>>`
        insert into charges (
          property_id, folio_id, reservation_room_id, type, description,
          service_date, amount_cents, taxable, status
        ) values (
          ${session.propertyId}::uuid, ${input.folioId}::uuid,
          ${input.reservationRoomId ?? null}::uuid, ${context.typeName}, ${input.description},
          ${input.serviceDate}::date, ${input.amountCents}, ${context.taxable && !context.taxExempt}, 'posted'
        ) returning id
      `;
      if (taxCents > 0 || input.taxOverrideCents !== undefined) {
        await tx`
          insert into charge_taxes (property_id, charge_id, name, rate_basis_points, amount_cents, override_reason)
          values (${session.propertyId}::uuid, ${created.id}::uuid, 'Tax', ${context.taxRateBasisPoints}, ${taxCents}, ${input.taxOverrideReason ?? null})
        `;
      }
      await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: input.serviceDate, resourceType: "charge", resourceId: created.id,
        description: input.description, debitAccount: "Guest Receivable", creditAccount: revenueAccount(context), amountCents: input.amountCents,
      });
      if (taxCents > 0) await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: input.serviceDate, resourceType: "charge-tax", resourceId: created.id,
        description: `${input.description} tax`, debitAccount: "Guest Receivable", creditAccount: "Tax Payable", amountCents: taxCents,
      });
      return { id: created.id, ...input, type: context.typeName, taxable: context.taxable && !context.taxExempt, taxCents, totalCents: input.amountCents + taxCents };
    });
    return Response.json({ charge }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /folio|tax|charge type/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = editSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Charge changes are invalid." }, { status: 400 });
    const input = parsed.data;
    const updated = await productionSql().begin(async (tx) => {
      const [current] = await tx<Array<ChargeContext & { id: string; description: string; amountCents: number; serviceDate: string; taxCents: number }>>`
        select c.id, c.description, c.amount_cents as "amountCents", c.service_date::text as "serviceDate",
          coalesce(ctax.amount_cents, 0) as "taxCents", r.id as "reservationId",
          r.tax_rate_basis_points as "taxRateBasisPoints", r.tax_exempt as "taxExempt",
          c.type as "typeName", coalesce(def.revenue_category, 'misc') as "revenueCategory", c.taxable
        from charges c
        join folios f on f.id = c.folio_id
        join reservations r on r.id = f.reservation_id
        left join charge_taxes ctax on ctax.charge_id = c.id
        left join charge_types def on def.property_id = c.property_id and def.name = c.type
        where c.id = ${input.chargeId}::uuid and c.property_id = ${session.propertyId}::uuid and c.status = 'posted'
        for update of c
      `;
      if (!current) throw new Error("Charge not found.");
      const amountCents = input.amountCents ?? current.amountCents;
      const description = input.description ?? current.description;
      const nextTax = taxAmount(current, amountCents, input.taxOverrideCents, input.taxOverrideReason);
      await tx`update charges set amount_cents=${amountCents}, description=${description}, updated_at=now() where id=${current.id}::uuid`;
      await tx`delete from charge_taxes where charge_id=${current.id}::uuid`;
      if (nextTax > 0 || input.taxOverrideCents !== undefined) await tx`
        insert into charge_taxes (property_id, charge_id, name, rate_basis_points, amount_cents, override_reason)
        values (${session.propertyId}::uuid, ${current.id}::uuid, 'Tax', ${current.taxRateBasisPoints}, ${nextTax}, ${input.taxOverrideReason ?? null})
      `;
      const revenueDifference = amountCents - current.amountCents;
      if (revenueDifference !== 0) await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: current.serviceDate, resourceType: "charge-adjustment", resourceId: current.id,
        description: `${description} adjustment`, debitAccount: revenueDifference > 0 ? "Guest Receivable" : revenueAccount(current),
        creditAccount: revenueDifference > 0 ? revenueAccount(current) : "Guest Receivable", amountCents: Math.abs(revenueDifference),
      });
      const taxDifference = nextTax - current.taxCents;
      if (taxDifference !== 0) await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: current.serviceDate, resourceType: "tax-adjustment", resourceId: current.id,
        description: `${description} tax adjustment`, debitAccount: taxDifference > 0 ? "Guest Receivable" : "Tax Payable",
        creditAccount: taxDifference > 0 ? "Tax Payable" : "Guest Receivable", amountCents: Math.abs(taxDifference),
      });
      return { id: current.id, description, amountCents, taxCents: nextTax, totalCents: amountCents + nextTax };
    });
    return Response.json({ charge: updated });
  } catch (error) {
    if (error instanceof Error && /charge|tax/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
