import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { OtaCommissionError, payReservationCommission } from "@/server/finance/ota-commission";

const paySchema = z.object({
  reservationIds: z.array(z.string().uuid()).min(1).max(500),
  paymentMethod: z.string().trim().min(1).max(100),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().trim().max(200).optional(),
});

/** Pay Guest Pays Hotel commissions; each becomes an OTA Commission expense. */
export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Commission payments require the PMS database." }, { status: 503 });
    const parsed = paySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Select commissions, a payment method and a date." }, { status: 400 });
    const paid = await productionSql().begin(async (tx) => {
      let totalCents = 0;
      for (const reservationId of [...new Set(parsed.data.reservationIds)]) {
        const [owned] = await tx<Array<{ id: string }>>`select id from reservations where id=${reservationId}::uuid and property_id=${session.propertyId}::uuid for update`;
        if (!owned) throw new OtaCommissionError("A selected reservation was not found.");
        const result = await payReservationCommission(tx, { propertyId: session.propertyId, reservationId, paymentMethod: parsed.data.paymentMethod, paidOn: parsed.data.paidOn, reference: parsed.data.reference });
        totalCents += result.paidCents;
      }
      return { paidCents: totalCents, count: parsed.data.reservationIds.length };
    });
    return Response.json(paid, { status: 201 });
  } catch (error) {
    if (error instanceof OtaCommissionError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
