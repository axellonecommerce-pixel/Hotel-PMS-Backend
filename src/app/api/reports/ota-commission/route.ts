import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { listOtaCommissions } from "@/server/finance/ota-commission";

const querySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const statusLabel: Record<string, string> = { reserved: "Reserved", checked_in: "Checked In", checked_out: "Checked Out", cancelled: "Cancelled", no_show: "No Show" };

/** OTA Commission report: per-reservation gross, tax, commission, net and settlement by arrival date. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const input = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success || input.data.startDate > input.data.endDate) return Response.json({ error: "Choose a valid report date range." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "The production reporting database is unavailable." }, { status: 503 });
    const rows = await listOtaCommissions(productionSql(), session.propertyId, input.data.startDate, input.data.endDate);
    const total = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
    const bySource = new Map<string, { count: number; commission: number }>();
    rows.forEach((row) => {
      const current = bySource.get(row.source) ?? { count: 0, commission: 0 };
      bySource.set(row.source, { count: current.count + 1, commission: current.commission + row.commissionCents });
    });
    return Response.json({ report: {
      metrics: [
        { label: "OTA Gross Amount", value: total((row) => row.grossCents), format: "money" },
        { label: "OTA Tax Amount", value: total((row) => row.taxCents), format: "money" },
        { label: "Total Commission", value: total((row) => row.commissionCents), format: "money" },
        { label: "OTA Net Amount", value: total((row) => row.netCents), format: "money" },
        { label: "Deducted by OTA", value: total((row) => (row.deducted ? row.commissionCents : 0)), format: "money" },
        { label: "Paid by Hotel", value: total((row) => row.paidCents), format: "money" },
        { label: "Payable to OTA", value: total((row) => row.outstandingCents), format: "money" },
        { label: "Reservations", value: rows.length, format: "number" },
      ],
      columns: [
        { key: "arrival", label: "Arrival", format: "date" },
        { key: "confirmation", label: "Confirmation" },
        { key: "guest", label: "Guest" },
        { key: "source", label: "Source" },
        { key: "otaPaymentStatus", label: "OTA Payment Status", format: "status" },
        { key: "status", label: "Reservation", format: "status" },
        { key: "roomRent", label: "Room Rent", format: "money", align: "right" },
        { key: "tax", label: "Tax", format: "money", align: "right" },
        { key: "gross", label: "Gross", format: "money", align: "right" },
        { key: "commissionPercent", label: "Comm. %", align: "right" },
        { key: "commission", label: "Commission", format: "money", align: "right" },
        { key: "net", label: "Net", format: "money", align: "right" },
        { key: "settlement", label: "Settlement", format: "status" },
        { key: "paid", label: "Paid", format: "money", align: "right" },
        { key: "outstanding", label: "Payable", format: "money", align: "right" },
        { key: "paidOn", label: "Paid / Deducted On", format: "date" },
        { key: "paymentMethod", label: "Method" },
      ],
      rows: rows.map((row) => ({
        id: row.reservationId,
        arrival: row.arrivalDate,
        confirmation: row.confirmationNumber,
        guest: row.guestName,
        source: row.source,
        otaPaymentStatus: row.otaPaymentStatus ?? "—",
        status: statusLabel[row.reservationStatus] ?? row.reservationStatus,
        roomRent: row.roomRentCents,
        tax: row.taxCents,
        gross: row.grossCents,
        commissionPercent: `${row.commissionPercent}%`,
        commission: row.commissionCents,
        net: row.netCents,
        settlement: row.settlement,
        paid: row.paidCents,
        outstanding: row.outstandingCents,
        paidOn: row.paidOn ?? "",
        paymentMethod: row.paymentMethod ?? "—",
      })),
      note: `By source: ${[...bySource.entries()].map(([source, value]) => `${source} ${value.count} reservation${value.count === 1 ? "" : "s"}, $${(value.commission / 100).toFixed(2)} commission`).join(" · ") || "no OTA reservations"}. Commission is calculated on room rent before tax; Paid Online and Virtual Card Pending commissions are deducted by the OTA.`,
    } });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
