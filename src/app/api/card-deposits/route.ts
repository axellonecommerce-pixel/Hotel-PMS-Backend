import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { BankAccountError, bankAccountFor } from "@/server/finance/cash-sources";
import { autoDepositSettings, DepositError, pendingDepositItems, settleDeposit, undoDeposit } from "@/server/finance/card-settlements";
import { propertyBusinessDate } from "@/server/finance/production-finance";
import { withIdempotency } from "@/server/http/idempotency";

export const dynamic = "force-dynamic";

// Card & check deposits on Cash & Bank: what is waiting to reach the bank,
// recording a deposit (with the processor's fee), automatic deposits, and
// undoing a deposit recorded by mistake.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deposit"),
    bankAccountId: z.string().uuid(),
    paymentIds: z.array(z.string().uuid()).max(2000).default([]),
    refundIds: z.array(z.string().uuid()).max(2000).default([]),
    // What the bank actually received.
    netCents: z.number().int().min(0).max(1_000_000_000),
    depositDate: isoDate,
    reference: z.string().trim().max(80).optional(),
    note: z.string().trim().max(500).optional(),
    // Deposited before the motel used the PMS: already part of the bank's opening balance.
    historical: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("settings"),
    enabled: z.boolean(),
    bankAccountId: z.string().uuid().nullable().optional(),
    feePercent: z.number().min(0).max(20),
    delayDays: z.number().int().min(0).max(14),
  }),
]);

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ pending: [], deposits: [], settings: null });
    const sql = productionSql();
    const [pending, deposits, settings] = await Promise.all([
      pendingDepositItems(sql, session.propertyId),
      sql<Array<{ id: string; depositDate: string; bankAccount: string; grossCents: number; feeCents: number; netCents: number; itemCount: number; reference: string | null; note: string | null; automatic: boolean }>>`
        select s.id, s.deposit_date::text as "depositDate", b.name as "bankAccount", s.gross_cents as "grossCents", s.fee_cents as "feeCents",
          s.net_cents as "netCents", s.item_count as "itemCount", s.reference, s.note, s.automatic
        from card_settlements s join bank_accounts b on b.id=s.bank_account_id
        where s.property_id=${session.propertyId}::uuid order by s.deposit_date desc, s.created_at desc limit 200
      `,
      autoDepositSettings(sql, session.propertyId),
    ]);
    return Response.json({ pending, deposits, settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}

async function handlePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Card deposits need the PMS database." }, { status: 503 });
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the deposit details." }, { status: 400 });
    const input = parsed.data;
    if (input.action === "settings") {
      if (input.enabled) await bankAccountFor(productionSql(), session.propertyId, input.bankAccountId);
      const value = { enabled: input.enabled, bankAccountId: input.bankAccountId ?? null, feePercent: input.feePercent, delayDays: input.delayDays };
      await productionSql()`
        insert into property_settings (property_id,key,value) values (${session.propertyId}::uuid,'card_deposits',${productionSql().json(value)})
        on conflict (property_id,key) do update set value=excluded.value,updated_at=now()
      `;
      return Response.json({ settings: value });
    }
    const result = await productionSql().begin(async (tx) => {
      const bankAccount = await bankAccountFor(tx, session.propertyId, input.bankAccountId);
      if (input.depositDate > await propertyBusinessDate(tx, session.propertyId)) throw new DepositError("The deposit date cannot be in the future.");
      return settleDeposit(tx, { propertyId: session.propertyId, bankAccount, paymentIds: input.paymentIds, refundIds: input.refundIds, netCents: input.netCents, depositDate: input.depositDate, reference: input.reference, note: input.note, historical: input.historical, authUserId: session.authUserId });
    });
    return Response.json({ deposit: result }, { status: 201 });
  } catch (error) {
    if (error instanceof DepositError || error instanceof BankAccountError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Undo a deposit recorded by mistake; its payments wait for deposit again. */
export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    const parsed = z.object({ id: z.string().uuid() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Choose a deposit." }, { status: 400 });
    const undone = await productionSql().begin((tx) => undoDeposit(tx, session.propertyId, parsed.data.id));
    if (!undone) return Response.json({ error: "Deposit not found." }, { status: 404 });
    return Response.json({ undone: true });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Repeated with the same Idempotency-Key (double tap, retry), it runs once. */
export const POST = withIdempotency(handlePOST);
