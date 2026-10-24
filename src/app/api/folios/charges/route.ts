import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger } from "@/server/finance/production-finance";

const createSchema = z.object({
  // Older clients hold a display folio label and a configured charge-type
  // name, while production records use UUIDs. Accept either trusted handle
  // and resolve it within the authenticated property below.
  folioId: z.string().uuid().optional(),
  reservationId: z.string().uuid().optional(),
  reservationRoomId: z.string().uuid().nullable().optional(),
  chargeTypeId: z.string().uuid().optional(),
  chargeTypeName: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1),
  serviceDate: z.string().date(),
  amountCents: z.number().int().positive(),
  taxOverrideCents: z.number().int().nonnegative().optional(),
  taxOverrideReason: z.string().trim().min(1).optional(),
}).superRefine((value, context) => {
  if (!value.folioId && !value.reservationId) context.addIssue({ code: "custom", message: "A folio or reservation is required." });
  if (!value.chargeTypeId && !value.chargeTypeName) context.addIssue({ code: "custom", message: "A charge type is required." });
});

const editSchema = z.object({
  chargeId: z.string().uuid(),
  folioId: z.string().uuid().optional(),
  description: z.string().trim().min(1).optional(),
  amountCents: z.number().int().positive().optional(),
  taxOverrideCents: z.number().int().nonnegative().optional(),
  taxOverrideReason: z.string().trim().min(1).optional(),
});

const deleteSchema = z.object({ chargeId: z.string().uuid() });

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
  // Owner rule: only room rent is taxed; every extra charge is non-taxable.
  if (context.taxExempt || !context.taxable || !/room rent/i.test(context.typeName)) return 0;
  return override ?? Math.round((amountCents * context.taxRateBasisPoints) / 10_000);
}

function revenueAccount(context: Pick<ChargeContext, "revenueCategory" | "typeName">) {
  return /room/i.test(context.revenueCategory) || /room rent/i.test(context.typeName)
    ? "Room Revenue"
    // Revenue reports read misc revenue from "Revenue:*" accounts.
    : `Revenue:${context.typeName}`;
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Charge details are invalid." }, { status: 400 });
    const input = parsed.data;
    const charge = await productionSql().begin(async (tx) => {
      const [context] = await tx<Array<ChargeContext & { folioId: string }>>`
        select r.id as "reservationId", r.tax_rate_basis_points as "taxRateBasisPoints",
          r.tax_exempt as "taxExempt", ct.name as "typeName",
          ct.revenue_category as "revenueCategory", ct.taxable,f.id as "folioId"
        from folios f
        join reservations r on r.id = f.reservation_id and r.property_id = f.property_id
        join charge_types ct on ct.property_id = f.property_id
          and (${input.chargeTypeId ?? null}::uuid is null or ct.id = ${input.chargeTypeId ?? null}::uuid)
          and (${input.chargeTypeName ?? null}::text is null or ct.name = ${input.chargeTypeName ?? null})
        where f.property_id = ${session.propertyId}::uuid
          and (${input.folioId ?? null}::uuid is null or f.id = ${input.folioId ?? null}::uuid)
          and (${input.reservationId ?? null}::uuid is null or f.reservation_id = ${input.reservationId ?? null}::uuid)
          and f.status <> 'closed' and ct.active = true
        order by f.created_at limit 1 for update of f
      `;
      if (!context) throw new Error("The folio or charge type is unavailable.");
      const taxCents = taxAmount(context, input.amountCents, input.taxOverrideCents, input.taxOverrideReason);
      const [created] = await tx<Array<{ id: string }>>`
        insert into charges (
          property_id, folio_id, reservation_room_id, type, description,
          service_date, amount_cents, taxable, status
        ) values (
          ${session.propertyId}::uuid, ${context.folioId}::uuid,
          ${input.reservationRoomId ?? null}::uuid, ${context.typeName}, ${input.description},
          ${input.serviceDate}::date, ${input.amountCents}, false, 'posted'
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
      const [balance] = await tx<Array<{ balanceCents: number }>>`
        select (
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios all_folios on all_folios.id=c.folio_id where all_folios.reservation_id=${context.reservationId}::uuid and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios all_folios on all_folios.id=pa.folio_id where all_folios.reservation_id=${context.reservationId}::uuid),0)
        )::int as "balanceCents"
      `;
      return { id: created.id, folioId: context.folioId, reservationRoomId: input.reservationRoomId ?? null, description: input.description, amountCents: input.amountCents, type: context.typeName, taxable: context.taxable && !context.taxExempt, taxCents, totalCents: input.amountCents + taxCents, balanceCents: balance?.balanceCents ?? input.amountCents + taxCents };
    });
    return Response.json({ charge }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /folio|tax|charge type/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const reservationId = new URL(request.url).searchParams.get("reservationId");
    if (!reservationId || !z.string().uuid().safeParse(reservationId).success) return Response.json({ error: "A reservation is required." }, { status: 400 });
    const charges = await productionSql()<Array<{ id: string; folioId: string; description: string; amountCents: number; type: string; taxCents: number }>>`
      select c.id,c.folio_id as "folioId",c.description,c.amount_cents as "amountCents",c.type,
        coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)::int as "taxCents"
      from charges c join folios f on f.id=c.folio_id
      where c.property_id=${session.propertyId}::uuid and f.reservation_id=${reservationId}::uuid
        and c.status='posted' and c.type <> 'Room Rent'
      order by c.service_date,c.created_at
    `;
    return Response.json({ charges: charges.map((charge) => ({ ...charge, totalCents: charge.amountCents + charge.taxCents })) });
  } catch (error) {
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
      const [current] = await tx<Array<ChargeContext & { id: string; folioId: string; description: string; amountCents: number; serviceDate: string; taxCents: number }>>`
        select c.id, c.folio_id as "folioId", c.description, c.amount_cents as "amountCents", c.service_date::text as "serviceDate",
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
      let folioId = current.folioId;
      if (input.folioId && input.folioId !== current.folioId) {
        const [targetFolio] = await tx<Array<{ id: string }>>`
          select f.id from folios f
          where f.id=${input.folioId}::uuid and f.property_id=${session.propertyId}::uuid
            and f.reservation_id=${current.reservationId}::uuid and f.status='open'
          for update
        `;
        if (!targetFolio) throw new Error("The target folio is unavailable.");
        folioId = targetFolio.id;
      }
      const nextTax = taxAmount(current, amountCents, input.taxOverrideCents, input.taxOverrideReason);
      await tx`update charges set folio_id=${folioId}::uuid, amount_cents=${amountCents}, description=${description}, updated_at=now() where id=${current.id}::uuid`;
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
      const [balance] = await tx<Array<{ balanceCents: number }>>`
        select (
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios all_folios on all_folios.id=c.folio_id where all_folios.reservation_id=${current.reservationId}::uuid and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios all_folios on all_folios.id=pa.folio_id where all_folios.reservation_id=${current.reservationId}::uuid),0)
        )::int as "balanceCents"
      `;
      return { id: current.id, folioId, description, amountCents, taxCents: nextTax, totalCents: amountCents + nextTax, balanceCents: balance?.balanceCents ?? amountCents + nextTax };
    });
    return Response.json({ charge: updated });
  } catch (error) {
    if (error instanceof Error && /charge|tax/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = deleteSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "A valid charge is required." }, { status: 400 });
    const result = await productionSql().begin(async (tx) => {
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
        where c.id = ${parsed.data.chargeId}::uuid and c.property_id = ${session.propertyId}::uuid
          and c.status = 'posted' and c.type <> 'Room Rent'
        for update of c
      `;
      if (!current) throw new Error("Charge not found or cannot be removed.");
      await tx`update charges set status='void', updated_at=now() where id=${current.id}::uuid`;
      await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: current.serviceDate, resourceType: "charge-void", resourceId: current.id,
        description: `${current.description} void`, debitAccount: revenueAccount(current), creditAccount: "Guest Receivable", amountCents: current.amountCents,
      });
      if (current.taxCents > 0) await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate: current.serviceDate, resourceType: "charge-tax-void", resourceId: current.id,
        description: `${current.description} tax void`, debitAccount: "Tax Payable", creditAccount: "Guest Receivable", amountCents: current.taxCents,
      });
      const [balance] = await tx<Array<{ balanceCents: number }>>`
        select (
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios all_folios on all_folios.id=c.folio_id where all_folios.reservation_id=${current.reservationId}::uuid and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios all_folios on all_folios.id=pa.folio_id where all_folios.reservation_id=${current.reservationId}::uuid),0)
        )::int as "balanceCents"
      `;
      return { balanceCents: balance?.balanceCents ?? 0 };
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && /charge/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
