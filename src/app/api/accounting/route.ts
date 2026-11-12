import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { BankAccountError, bankAccountBalances, bankAccountFor, bankLedgerAccount, CASH_ACCOUNTS, cashBalances, ensureDefaultBankAccount } from "@/server/finance/cash-sources";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { cashActivityBetween } from "@/server/finance/shift-guard";
import { withRequestContext } from "@/server/db/request-context";

export const dynamic = "force-dynamic";

// Accounting for owners, managers and accountants: where the cash is (drawer,
// safe, bank), moving it (bank deposits, safe counts, owner money), and the
// books (trial balance and general ledger) built from every posting.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({ start: isoDate, end: isoDate }).refine((value) => value.start <= value.end);
const money = z.number().int().positive().max(100_000_000);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bank_deposit"), amountCents: money, bankAccountId: z.string().uuid().optional(), reference: z.string().trim().max(80).optional(), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("bank_withdrawal"), amountCents: money, bankAccountId: z.string().uuid().optional(), reference: z.string().trim().max(80).optional(), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("owner_contribution"), amountCents: money, note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("owner_withdrawal"), amountCents: money, note: z.string().trim().max(500).optional() }),
  // The cash actually counted in the safe; the difference is posted as over / short.
  z.object({ action: z.literal("safe_count"), countedCents: z.number().int().min(0).max(100_000_000), note: z.string().trim().max(500).optional() }),
]);

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function drawerCash(propertyId: string) {
  const sql = productionSql();
  const [shift] = await sql<Array<{ openedAt: string; openingCents: number; clerk: string }>>`
    select to_char(cs.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "openedAt", cs.opening_cents as "openingCents", e.name as clerk
    from cash_shifts cs join employees e on e.id=cs.employee_id
    where cs.property_id=${propertyId}::uuid and cs.status like 'open:%' order by cs.opened_at desc limit 1
  `;
  if (shift) {
    const activity = await cashActivityBetween(sql, propertyId, shift.openedAt, null);
    return { cents: Math.max(0, shift.openingCents + activity.netCents), shiftOpen: true, clerk: shift.clerk, detail: `Expected in the drawer now (shift open, ${shift.clerk})` };
  }
  const [last] = await sql<Array<{ countedCents: number; droppedCents: number }>>`
    select coalesce(cs.counted_cents,0)::int as "countedCents", coalesce((select sum(cd.amount_cents) from cash_drops cd where cd.cash_shift_id=cs.id),0)::int as "droppedCents"
    from cash_shifts cs where cs.property_id=${propertyId}::uuid and cs.status like 'closed:%' order by cs.closed_at desc nulls last limit 1
  `;
  return { cents: last ? Math.max(0, last.countedCents - last.droppedCents) : 0, shiftOpen: false, clerk: null, detail: last ? "Left in the drawer when the last shift ended" : "No shift recorded yet" };
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Accounting needs the PMS database." }, { status: 503 });
    const params = new URL(request.url).searchParams;
    const view = params.get("view") ?? "cash";
    const range = rangeSchema.safeParse({ start: params.get("start"), end: params.get("end") });
    if (!range.success) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
    const { start, end } = range.data;
    const sql = productionSql();
    const id = session.propertyId;

    if (view === "cash") {
      await ensureDefaultBankAccount(sql, id);
      const [drawer, balances, movements, summary, bankAccounts] = await Promise.all([
        drawerCash(id),
        cashBalances(sql, id),
        sql<Array<{ id: string; businessDate: string; createdAt: string; fromLocation: string | null; toLocation: string | null; amountCents: number; kind: string; description: string; reference: string | null; note: string | null; bankAccountId: string | null; bankAccountName: string | null }>>`
          select m.id, m.business_date::text as "businessDate", m.created_at as "createdAt", m.from_location as "fromLocation", m.to_location as "toLocation",
            m.amount_cents as "amountCents", m.kind, m.description, m.reference, m.note, m.bank_account_id as "bankAccountId", b.name as "bankAccountName"
          from cash_movements m left join bank_accounts b on b.id=m.bank_account_id where m.property_id=${id}::uuid and m.business_date between ${start}::date and ${end}::date
          order by m.business_date desc, m.created_at desc limit 1000
        `,
        sql<Array<{ kind: string; fromLocation: string | null; toLocation: string | null; amountCents: number; count: number }>>`
          select kind, from_location as "fromLocation", to_location as "toLocation", sum(amount_cents)::int as "amountCents", count(*)::int as count
          from cash_movements where property_id=${id}::uuid and business_date between ${start}::date and ${end}::date
          group by 1,2,3
        `,
        bankAccountBalances(sql, id),
      ]);
      const [lastCount] = await sql<Array<{ businessDate: string; createdAt: string }>>`
        select business_date::text as "businessDate", created_at as "createdAt" from cash_movements
        where property_id=${id}::uuid and kind='safe_count' order by created_at desc limit 1
      `;
      return Response.json({
        drawer, safeCents: balances.safeCents, bankCents: balances.bankCents,
        cashOnHandCents: drawer.cents + balances.safeCents,
        lastSafeCount: lastCount ?? null,
        movements, summary, bankAccounts,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (view === "trial-balance") {
      // Opening balance (everything before the range), activity in the range, closing balance.
      const accounts = await sql<Array<{ account: string; openingCents: number; debitCents: number; creditCents: number }>>`
        select account,
          coalesce(sum(debit_cents-credit_cents) filter (where business_date < ${start}::date),0)::int as "openingCents",
          coalesce(sum(debit_cents) filter (where business_date between ${start}::date and ${end}::date),0)::int as "debitCents",
          coalesce(sum(credit_cents) filter (where business_date between ${start}::date and ${end}::date),0)::int as "creditCents"
        from ledger_entries where property_id=${id}::uuid and business_date <= ${end}::date
        group by account order by account
      `;
      return Response.json({
        start, end,
        accounts: accounts.map((row) => ({ ...row, closingCents: row.openingCents + row.debitCents - row.creditCents }))
          .filter((row) => row.openingCents || row.debitCents || row.creditCents),
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (view === "ledger") {
      const account = params.get("account")?.slice(0, 120);
      if (!account) return Response.json({ error: "Choose an account." }, { status: 400 });
      const [opening] = await sql<Array<{ cents: number }>>`
        select coalesce(sum(debit_cents-credit_cents),0)::int as cents from ledger_entries
        where property_id=${id}::uuid and account=${account} and business_date < ${start}::date
      `;
      const entries = await sql<Array<{ id: string; businessDate: string; description: string; debitCents: number; creditCents: number; resourceType: string }>>`
        select id, business_date::text as "businessDate", description, debit_cents as "debitCents", credit_cents as "creditCents", resource_type as "resourceType"
        from ledger_entries where property_id=${id}::uuid and account=${account} and business_date between ${start}::date and ${end}::date
        order by business_date, created_at limit 5000
      `;
      return Response.json({ account, start, end, openingCents: opening.cents, entries }, { headers: { "Cache-Control": "no-store" } });
    }

    return Response.json({ error: "Unknown view." }, { status: 400 });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Accounting needs the PMS database." }, { status: 503 });
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Enter a valid amount." }, { status: 400 });
    const input = parsed.data;
    const actor = /^[0-9a-f-]{36}$/i.test(session.authUserId) ? session.authUserId : null;
    const result = await productionSql().begin(async (tx) => {
      // One safe: serialize changes so a count and a deposit never race.
      await tx`select pg_advisory_xact_lock(hashtext(${`cash:${session.propertyId}`}))`;
      const businessDate = await propertyBusinessDate(tx, session.propertyId);
      const balances = await cashBalances(tx, session.propertyId);
      let move: { from: string | null; to: string | null; amountCents: number; kind: string; description: string; debit: string; credit: string };
      // Deposits and withdrawals go to or from a chosen bank account (the default when not chosen).
      const bank = input.action === "bank_deposit" || input.action === "bank_withdrawal" ? await bankAccountFor(tx, session.propertyId, input.bankAccountId) : null;
      if (input.action === "bank_deposit") {
        if (input.amountCents > balances.safeCents) return { error: `The safe only has ${usd(balances.safeCents)}. Count the safe first if that is wrong.` };
        move = { from: "safe", to: "bank", amountCents: input.amountCents, kind: "bank_deposit", description: `Cash deposited to ${bank!.name}`, debit: bankLedgerAccount(bank!.name), credit: CASH_ACCOUNTS.safe };
      } else if (input.action === "bank_withdrawal") {
        move = { from: "bank", to: "safe", amountCents: input.amountCents, kind: "bank_withdrawal", description: `Cash withdrawn from ${bank!.name} into the safe`, debit: CASH_ACCOUNTS.safe, credit: bankLedgerAccount(bank!.name) };
      } else if (input.action === "owner_contribution") {
        move = { from: null, to: "safe", amountCents: input.amountCents, kind: "owner_contribution", description: "Owner added cash to the safe", debit: CASH_ACCOUNTS.safe, credit: "Owner's Equity" };
      } else if (input.action === "owner_withdrawal") {
        if (input.amountCents > balances.safeCents) return { error: `The safe only has ${usd(balances.safeCents)}.` };
        move = { from: "safe", to: null, amountCents: input.amountCents, kind: "owner_withdrawal", description: "Owner took cash from the safe", debit: "Owner's Draw", credit: CASH_ACCOUNTS.safe };
      } else {
        const difference = input.countedCents - balances.safeCents;
        if (difference === 0) return { balanced: true, safeCents: balances.safeCents };
        move = difference > 0
          ? { from: null, to: "safe", amountCents: difference, kind: "safe_count", description: `Safe count ${usd(input.countedCents)}: over by ${usd(difference)}`, debit: CASH_ACCOUNTS.safe, credit: "Cash Over/Short" }
          : { from: "safe", to: null, amountCents: -difference, kind: "safe_count", description: `Safe count ${usd(input.countedCents)}: short by ${usd(-difference)}`, debit: "Cash Over/Short", credit: CASH_ACCOUNTS.safe };
      }
      const reference = "reference" in input ? input.reference || null : null;
      const [movement] = await tx<Array<{ id: string }>>`
        insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,description,reference,note,created_by_auth_user_id,bank_account_id)
        values (${session.propertyId}::uuid,${businessDate}::date,${move.from},${move.to},${move.amountCents},${move.kind},'cash-movement',${move.description},${reference},${input.note ?? null},${actor}::uuid,${bank?.id ?? null}::uuid)
        returning id
      `;
      await tx`update cash_movements set resource_id=id where id=${movement.id}::uuid`;
      await postProductionLedger(tx, {
        propertyId: session.propertyId, businessDate, resourceType: "cash-movement", resourceId: movement.id,
        description: `${move.description}${reference ? ` · ref ${reference}` : ""}`, debitAccount: move.debit, creditAccount: move.credit, amountCents: move.amountCents,
      });
      return { saved: true, ...(await cashBalances(tx, session.propertyId)) };
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 409 });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BankAccountError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
