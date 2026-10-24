import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { OtaCommissionError, setReservationCommission } from "@/server/finance/ota-commission";
import { propertyBusinessDate } from "@/server/finance/production-finance";

const commissionSchema = z.object({
  commissionCents: z.number().int().min(0).max(100_000_000),
  reason: z.string().trim().min(1, "Enter a reason for changing the commission.").max(500),
});

/** Manually correct the total OTA commission for one reservation. */
export async function PATCH(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "payments.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Commission changes require the PMS database." }, { status: 503 });
    const parsed = commissionSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Enter a valid commission amount." }, { status: 400 });
    const { reservationId } = await context.params;
    const result = await productionSql().begin(async (tx) => {
      const [reservation] = await tx<Array<{ status: string; grossCents: number }>>`
        select r.status,coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0))
          from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted' and c.type='Room Rent'),0)::int as "grossCents"
        from reservations r where r.id=${reservationId}::uuid and r.property_id=${session.propertyId}::uuid for update
      `;
      if (!reservation) return { error: "Reservation not found.", httpStatus: 404 } as const;
      if (reservation.status === "cancelled" || reservation.status === "no_show") return { error: "Reinstate the reservation before changing its commission.", httpStatus: 409 } as const;
      if (parsed.data.commissionCents > reservation.grossCents) return { error: "Commission cannot exceed the reservation's gross room amount.", httpStatus: 400 } as const;
      return setReservationCommission(tx, {
        propertyId: session.propertyId,
        reservationId,
        targetCents: parsed.data.commissionCents,
        businessDate: await propertyBusinessDate(tx, session.propertyId),
        reason: `Commission edited: ${parsed.data.reason}`,
      });
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: result.httpStatus });
    return Response.json(result);
  } catch (error) {
    if (error instanceof OtaCommissionError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
