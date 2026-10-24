import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { logReservationActivity, money } from "@/server/activity/reservation-activity";
import { requireOpenShift, ShiftRequiredError } from "@/server/finance/shift-guard";

const DEPOSITS_HELD = "Security Deposits Held";
/** Cash sits in the drawer; any other method is a card authorization. */
const holdingAccount = (method: string) => (/cash/i.test(method) ? "Cash" : "Card Authorizations");

const reasonSchema = z.enum(["Damage", "Late Checkout", "Smoking", "Missing Item", "Other"]);
const collectSchema = z.object({
  action: z.literal("collect"),
  amountCents: z.number().int().positive(),
  method: z.string().trim().min(1).max(100),
  reservationRoomId: z.string().uuid().optional(),
});
const settleSchema = z.object({
  action: z.literal("settle"),
  deductions: z.array(z.object({ reason: reasonSchema, note: z.string().trim().max(1_000).optional(), amountCents: z.number().int().positive() })),
  releaseCents: z.number().int().nonnegative(),
  checkout: z.boolean(),
});
const requestSchema = z.discriminatedUnion("action", [collectSchema, settleSchema]);

type DepositView = {
  securityDepositCents?: number;
  securityDepositStatus?: "Held" | "Settled";
  securityDepositMethod?: string;
  securityDepositCollectedAt?: string;
  securityDepositDeductions?: Array<{ id: string; reason: "Damage" | "Late Checkout" | "Smoking" | "Missing Item" | "Other"; note?: string; amountCents: number }>;
  securityDepositReleasedCents?: number;
  securityDepositSettledAt?: string;
};

function routeParams(context: { params: Promise<{ reservationId: string }> }) {
  return context.params.then(({ reservationId }) => reservationId);
}

async function depositView(propertyId: string, reservationId: string): Promise<DepositView> {
  const [deposit] = await productionSql()<Array<{ id: string; amountCents: number; method: string; status: string; createdAt: string; settledAt: string | null }>>`
    select d.id,d.amount_cents as "amountCents",d.method,d.status,d.created_at::text as "createdAt",
      max(case when dt.type='release' then dt.created_at end)::text as "settledAt"
    from security_deposits d
    join reservation_rooms rr on rr.id=d.reservation_room_id
    left join deposit_transactions dt on dt.deposit_id=d.id
    where d.property_id=${propertyId}::uuid and rr.reservation_id=${reservationId}::uuid
    group by d.id
    order by d.created_at desc
    limit 1
  `;
  if (!deposit) return {};
  const transactions = await productionSql()<Array<{ id: string; type: string; amountCents: number; reason: string | null; note: string | null }>>`
    select id,type,amount_cents as "amountCents",reason,note
    from deposit_transactions where deposit_id=${deposit.id}::uuid and property_id=${propertyId}::uuid
    order by created_at
  `;
  const deductions: NonNullable<DepositView["securityDepositDeductions"]> = transactions
    .filter((transaction) => transaction.type === "charge")
    .map((transaction) => ({
      id: transaction.id,
      reason: (transaction.reason === "Damage" || transaction.reason === "Late Checkout" || transaction.reason === "Smoking" || transaction.reason === "Missing Item" || transaction.reason === "Other") ? transaction.reason as "Damage" | "Late Checkout" | "Smoking" | "Missing Item" | "Other" : "Other",
      note: transaction.note ?? undefined,
      amountCents: transaction.amountCents,
    }));
  const releasedCents = transactions.filter((transaction) => transaction.type === "release").reduce((sum, transaction) => sum + transaction.amountCents, 0);
  return {
    securityDepositCents: deposit.amountCents,
    securityDepositStatus: deposit.status === "held" ? "Held" : "Settled",
    securityDepositMethod: deposit.method,
    securityDepositCollectedAt: deposit.createdAt,
    securityDepositDeductions: deductions.length ? deductions : undefined,
    securityDepositReleasedCents: releasedCents || undefined,
    securityDepositSettledAt: deposit.status === "held" ? undefined : deposit.settledAt ?? undefined,
  };
}

export async function GET(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    return Response.json({ deposit: await depositView(session.propertyId, await routeParams(context)) });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ reservationId: string }> }) {
  try {
    const session = await requirePropertySession(request, "reservations.manage");
    const reservationId = await routeParams(context);
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Deposit details are invalid." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      await requireOpenShift(tx, session.propertyId, input.action === "collect" ? "collect a deposit" : "settle a deposit");
      const rooms = await tx<Array<{ id: string }>>`
        select id from reservation_rooms where reservation_id=${reservationId}::uuid and property_id=${session.propertyId}::uuid order by created_at for update
      `;
      if (!rooms.length) return { error: "Reservation room not found." } as const;
      if (input.action === "collect") {
        const reservationRoomId = input.reservationRoomId && rooms.some((room) => room.id === input.reservationRoomId) ? input.reservationRoomId : rooms[0]!.id;
        const [open] = await tx<Array<{ id: string }>>`
          select d.id from security_deposits d where d.property_id=${session.propertyId}::uuid and d.reservation_room_id=${reservationRoomId}::uuid and d.status='held' for update
        `;
        if (open) return { error: "Resolve the existing held deposit before collecting another one." } as const;
        const [created] = await tx<Array<{ id: string }>>`
          insert into security_deposits (property_id,reservation_room_id,method,amount_cents,status,show_on_folio)
          values (${session.propertyId}::uuid,${reservationRoomId}::uuid,${input.method},${input.amountCents},'held',true)
          returning id
        `;
        await logReservationActivity(tx, session, reservationId, "Deposit", `Security deposit collected · ${money(input.amountCents)} ${input.method}`);
        // A deposit is a liability, not revenue (FR-REV-001).
        await postProductionLedger(tx, { propertyId: session.propertyId, businessDate: await propertyBusinessDate(tx, session.propertyId), resourceType: "deposit-collect", resourceId: created.id, description: `Security deposit collected · ${input.method}`, debitAccount: holdingAccount(input.method), creditAccount: DEPOSITS_HELD, amountCents: input.amountCents });
      } else {
        const [deposit] = await tx<Array<{ id: string; amountCents: number; method: string }>>`
          select d.id,d.amount_cents as "amountCents",d.method from security_deposits d
          join reservation_rooms rr on rr.id=d.reservation_room_id
          where d.property_id=${session.propertyId}::uuid and rr.reservation_id=${reservationId}::uuid and d.status='held'
          order by d.created_at desc limit 1 for update
        `;
        if (!deposit) return { error: "There is no held deposit to settle." } as const;
        const [used] = await tx<Array<{ amountCents: number }>>`
          select coalesce(sum(amount_cents),0)::int as "amountCents" from deposit_transactions
          where deposit_id=${deposit.id}::uuid and type in ('charge','release')
        `;
        const requestedCents = input.deductions.reduce((sum, deduction) => sum + deduction.amountCents, 0) + input.releaseCents;
        const availableCents = deposit.amountCents - used.amountCents;
        if (requestedCents <= 0 || requestedCents > availableCents) return { error: "Deposit deductions and release cannot exceed the held amount." } as const;
        const businessDate = await propertyBusinessDate(tx, session.propertyId);
        for (const deduction of input.deductions) {
          const [charge] = await tx<Array<{ id: string }>>`
            insert into deposit_transactions (property_id,deposit_id,type,amount_cents,reason,note)
            values (${session.propertyId}::uuid,${deposit.id}::uuid,'charge',${deduction.amountCents},${deduction.reason},${deduction.note ?? null})
            returning id
          `;
          // Kept deposit money becomes revenue of its deduction reason (FR-REV-001).
          await postProductionLedger(tx, { propertyId: session.propertyId, businessDate, resourceType: "deposit-charge", resourceId: charge.id, description: `Deposit deduction · ${deduction.reason}${deduction.note ? ` · ${deduction.note}` : ""}`, debitAccount: DEPOSITS_HELD, creditAccount: `Revenue:Deposit ${deduction.reason}`, amountCents: deduction.amountCents });
        }
        if (input.releaseCents) {
          const [release] = await tx<Array<{ id: string }>>`
            insert into deposit_transactions (property_id,deposit_id,type,amount_cents,reason)
            values (${session.propertyId}::uuid,${deposit.id}::uuid,'release',${input.releaseCents},'Unused security deposit')
            returning id
          `;
          await postProductionLedger(tx, { propertyId: session.propertyId, businessDate, resourceType: "deposit-release", resourceId: release.id, description: `Security deposit released · ${deposit.method}`, debitAccount: DEPOSITS_HELD, creditAccount: holdingAccount(deposit.method), amountCents: input.releaseCents });
        }
        const deducted = input.deductions.map((deduction) => `${deduction.reason} ${money(deduction.amountCents)}`).join(", ");
        await logReservationActivity(tx, session, reservationId, "Deposit", [deducted ? `Deposit charged · ${deducted}` : "", input.releaseCents ? `Deposit released · ${money(input.releaseCents)}` : ""].filter(Boolean).join(" · "));
        if (requestedCents === availableCents) await tx`update security_deposits set status='settled',updated_at=now() where id=${deposit.id}::uuid`;
      }
      return { ok: true } as const;
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ deposit: await depositView(session.propertyId, reservationId) });
  } catch (error) {
    if (error instanceof ShiftRequiredError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}
