import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger } from "@/server/finance/production-finance";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";

const updateSchema = z.object({
  roomRentCents: z.number().int().nonnegative().optional(),
  taxCents: z.number().int().nonnegative().optional(),
  taxOverrideReason: z.string().trim().min(1).max(500).optional(),
}).superRefine((value, context) => {
  if (value.roomRentCents === undefined && value.taxCents === undefined) context.addIssue({ code: "custom", message: "Enter a room rent or tax amount." });
  if (value.taxCents !== undefined && !value.taxOverrideReason) {
    context.addIssue({ code: "custom", message: "A reason is required when tax is changed manually." });
  }
});

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

function distributeCents(total: number, count: number) {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export async function PATCH(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = await routeParams(context);
    const parsed = updateSchema.safeParse(await request.json());
    if (!z.string().uuid().safeParse(reservationId).success || !parsed.success) return Response.json({ error: "Rate changes are invalid." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ id: string; taxRateBasisPoints: number; taxExempt: boolean }>>`
        select id,tax_rate_basis_points as "taxRateBasisPoints",tax_exempt as "taxExempt"
        from reservations where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid
        for update
      `;
      if (!reservation) throw new Error("Reservation not found.");
      if (reservation.taxExempt && input.taxCents !== undefined) throw new Error("Tax-exempt reservations cannot have a manual tax amount.");
      const charges = await tx<Array<{ id: string; reservationRoomId: string; serviceDate: string; amountCents: number; taxCents: number }>>`
        select c.id,c.reservation_room_id as "reservationRoomId",c.service_date::text as "serviceDate",
          c.amount_cents as "amountCents",coalesce(ct.amount_cents,0)::int as "taxCents"
        from charges c
        join folios f on f.id=c.folio_id
        left join charge_taxes ct on ct.charge_id=c.id
        where c.property_id=${session.propertyId}::uuid and f.reservation_id=${reservation.id}::uuid
          and c.type='Room Rent' and c.status='posted'
        order by c.service_date,c.created_at
        for update of c
      `;
      if (!charges.length) throw new Error("There are no posted room charges to adjust.");
      const nextRoomRent = input.roomRentCents ?? charges.reduce((sum, charge) => sum + charge.amountCents, 0);
      const nextAmounts = distributeCents(nextRoomRent, charges.length);
      const nextTaxes = input.taxCents !== undefined
        ? distributeCents(input.taxCents, charges.length)
        : reservation.taxExempt
          ? charges.map(() => 0)
          : nextAmounts.map((amount) => Math.round(amount * reservation.taxRateBasisPoints / 10_000));
      for (let index = 0; index < charges.length; index += 1) {
        const charge = charges[index];
        const nextAmount = nextAmounts[index];
        const nextTax = nextTaxes[index];
        await tx`update charges set amount_cents=${nextAmount},updated_at=now() where id=${charge.id}::uuid`;
        await tx`update nightly_rates set base_rate_cents=${nextAmount},final_rate_cents=${nextAmount} where property_id=${session.propertyId}::uuid and reservation_room_id=${charge.reservationRoomId}::uuid and stay_date=${charge.serviceDate}::date`;
        await tx`delete from charge_taxes where charge_id=${charge.id}::uuid`;
        if (nextTax > 0 || input.taxCents !== undefined) await tx`
          insert into charge_taxes (property_id,charge_id,name,rate_basis_points,amount_cents,override_reason)
          values (${session.propertyId}::uuid,${charge.id}::uuid,'Room Tax',${reservation.taxRateBasisPoints},${nextTax},${input.taxCents === undefined ? null : input.taxOverrideReason ?? 'Room rent adjustment'})
        `;
        const roomDifference = nextAmount - charge.amountCents;
        if (roomDifference !== 0) await postProductionLedger(tx, {
          propertyId: session.propertyId, businessDate: charge.serviceDate, resourceType: "room-rent-adjustment", resourceId: charge.id,
          description: "Room rent adjustment", debitAccount: roomDifference > 0 ? "Guest Receivable" : "Room Revenue",
          creditAccount: roomDifference > 0 ? "Room Revenue" : "Guest Receivable", amountCents: Math.abs(roomDifference),
        });
        const taxDifference = nextTax - charge.taxCents;
        if (taxDifference !== 0) await postProductionLedger(tx, {
          propertyId: session.propertyId, businessDate: charge.serviceDate, resourceType: "room-tax-adjustment", resourceId: charge.id,
          description: "Room tax adjustment", debitAccount: taxDifference > 0 ? "Guest Receivable" : "Tax Payable",
          creditAccount: taxDifference > 0 ? "Tax Payable" : "Guest Receivable", amountCents: Math.abs(taxDifference),
        });
      }
      const roomRentCents = nextAmounts.reduce((sum, amount) => sum + amount, 0);
      const rentBefore = charges.reduce((sum, charge) => sum + charge.amountCents, 0);
      if (roomRentCents !== rentBefore) await logReservationActivity(tx, session, reservationId, "Rate", `Room rent changed ${money(rentBefore)} → ${money(roomRentCents)}`);
      const taxCents = nextTaxes.reduce((sum, amount) => sum + amount, 0);
      const [balance] = await tx<Array<{ balanceCents: number }>>`
        select (
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios f on f.id=c.folio_id where f.reservation_id=${reservation.id}::uuid and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios f on f.id=pa.folio_id where f.reservation_id=${reservation.id}::uuid),0)
        )::int as "balanceCents"
      `;
      return { roomRentCents, taxCents, totalCents: roomRentCents + taxCents, balanceCents: balance?.balanceCents ?? roomRentCents + taxCents };
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && /reservation|room|tax/i.test(error.message)) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
