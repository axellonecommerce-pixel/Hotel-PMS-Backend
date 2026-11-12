import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { requireOpenShift, ShiftRequiredError } from "@/server/finance/shift-guard";
import { ProcessorError } from "@/server/terminal/stripe";
import { cancelTerminalPayment, listReaders, refreshTerminalPayment, simulateCardTap, startTerminalPayment, TerminalError } from "@/server/terminal/terminal-service";
import { isUserMessage } from "@/server/http/errors";
import { withIdempotency } from "@/server/http/idempotency";

export const dynamic = "force-dynamic";

// Charging a guest's card on the connected terminal from the folio. The
// screen starts the charge, then checks it every couple of seconds; the
// payment is posted to the folio once the card is approved.

const startSchema = z.object({ action: z.literal("start"), reservationId: z.string().uuid(), folioId: z.string().uuid(), amountCents: z.number().int().positive().max(10_000_000), readerId: z.string().trim().min(3).max(100) });
const simulateSchema = z.object({ action: z.literal("simulate"), id: z.string().uuid() });
const idSchema = z.object({ id: z.string().uuid() });

function errorResponse(error: unknown) {
  if (error instanceof ProcessorError || error instanceof TerminalError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof ShiftRequiredError) return Response.json({ error: error.message }, { status: 409 });
  if (isUserMessage(error, /^(Folio|Payment)/)) return Response.json({ error: error.message }, { status: 409 });
  return propertyAccessResponse(error);
}

async function handlePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const body = await request.json().catch(() => null);
    const simulate = simulateSchema.safeParse(body);
    if (simulate.success) {
      const [row] = await productionSql()<Array<{ readerId: string }>>`select reader_id as "readerId" from terminal_payments where id=${simulate.data.id}::uuid and property_id=${session.propertyId}::uuid and status='processing'`;
      if (!row) return Response.json({ error: "This charge is no longer waiting for a card." }, { status: 409 });
      await simulateCardTap(productionSql(), session.propertyId, row.readerId);
      return Response.json({ simulated: true });
    }
    const parsed = startSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Choose a terminal and enter the amount." }, { status: 400 });
    const input = parsed.data;
    const reader = (await listReaders(productionSql(), session.propertyId)).find((item) => item.id === input.readerId);
    if (!reader) return Response.json({ error: "That card reader is not connected to this motel." }, { status: 409 });
    if (reader.status !== "online") return Response.json({ error: `${reader.label} is offline. Turn it on and connect it to the internet, then try again.` }, { status: 409 });
    const started = await productionSql().begin(async (tx) => {
      await requireOpenShift(tx, session.propertyId, "collect a payment");
      const [folio] = await tx<Array<{ id: string; balanceCents: number; companyName: string | null; confirmationNumber: string }>>`
        select f.id, r.confirmation_number as "confirmationNumber", (select c.name from companies c where c.id=r.company_id) as "companyName", (
          coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c where c.folio_id=f.id and c.status='posted'),0)
          - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0))::int as "balanceCents"
        from folios f join reservations r on r.id=f.reservation_id
        where f.id=${input.folioId}::uuid and f.reservation_id=${input.reservationId}::uuid and r.property_id=${session.propertyId}::uuid
        for update of f
      `;
      if (!folio) throw new Error("Folio not found.");
      if (folio.companyName) throw new Error(`Payment is not collected from the guest. This stay is billed to ${folio.companyName}.`);
      if (input.amountCents > folio.balanceCents) throw new Error("Payment cannot exceed the folio balance.");
      const [waiting] = await tx`select 1 from terminal_payments where property_id=${session.propertyId}::uuid and reader_id=${input.readerId} and status='processing' and created_at > now() - interval '5 minutes'`;
      if (waiting) throw new TerminalError(`${reader.label} is already waiting for a card. Finish or cancel that charge first.`);
      return startTerminalPayment(tx, { propertyId: session.propertyId, authUserId: session.authUserId, reservationId: input.reservationId, folioId: folio.id, amountCents: input.amountCents, readerId: reader.id, readerLabel: reader.label, confirmationNumber: folio.confirmationNumber });
    });
    return Response.json({ terminalPayment: { ...started, simulated: reader.simulated } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

/** The charge's status; posts the payment to the folio when the card is approved. */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = idSchema.safeParse({ id: new URL(request.url).searchParams.get("id") });
    if (!parsed.success) return Response.json({ error: "Choose a charge." }, { status: 400 });
    const result = await productionSql().begin((tx) => refreshTerminalPayment(tx, session.propertyId, parsed.data.id));
    if (!result) return Response.json({ error: "Charge not found." }, { status: 404 });
    return Response.json({ terminalPayment: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const parsed = idSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Choose a charge." }, { status: 400 });
    const canceled = await productionSql().begin((tx) => cancelTerminalPayment(tx, session.propertyId, parsed.data.id));
    if (!canceled) return Response.json({ error: "The charge already finished. Check the folio." }, { status: 409 });
    return Response.json({ canceled: true });
  } catch (error) { return errorResponse(error); }
}

/** Repeated with the same Idempotency-Key (double tap, retry), it runs once. */
export const POST = withIdempotency(handlePOST);
