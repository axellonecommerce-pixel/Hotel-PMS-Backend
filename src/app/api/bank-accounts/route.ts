import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { bankAccountBalances, bankLedgerAccount, ensureDefaultBankAccount } from "@/server/finance/cash-sources";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";
import { withRequestContext } from "@/server/db/request-context";

export const dynamic = "force-dynamic";

// The motel's bank accounts (Cash & Bank). Expenses and wages paid by check,
// debit card, transfer or direct deposit, and bank deposits, move money in
// and out of a chosen account; each balance is the sum of those movements.

const name = z.string().trim().min(1, "Enter the account name.").max(60);
const last4 = z.string().trim().regex(/^\d{4}$/, "Last 4 digits must be 4 numbers.").optional().or(z.literal("").transform(() => undefined));
const createSchema = z.object({
  name, bankName: z.string().trim().max(80).optional(), last4,
  accountType: z.enum(["checking", "savings"]).default("checking"),
  // What the account held on the day it was added to the PMS.
  openingBalanceCents: z.number().int().min(0).max(1_000_000_000).default(0),
  isDefault: z.boolean().optional(),
});
const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), id: z.string().uuid(), name: name.optional(), bankName: z.string().trim().max(80).optional(), last4, accountType: z.enum(["checking", "savings"]).optional(), isDefault: z.literal(true).optional(), active: z.boolean().optional() }),
  // Match the balance to the bank statement; the difference (bank fees, interest) is posted.
  z.object({ action: z.literal("reconcile"), id: z.string().uuid(), statementBalanceCents: z.number().int().min(-1_000_000_000).max(1_000_000_000), note: z.string().trim().max(500).optional() }),
]);

class BankAccountRequestError extends Error {}
const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const actorId = (id: string) => /^[0-9a-f-]{36}$/i.test(id) ? id : null;

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ accounts: [] });
    await ensureDefaultBankAccount(productionSql(), session.propertyId);
    return Response.json({ accounts: await bankAccountBalances(productionSql(), session.propertyId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Bank accounts need the PMS database." }, { status: 503 });
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the bank account details." }, { status: 400 });
    const input = parsed.data;
    const account = await productionSql().begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`cash:${session.propertyId}`}))`;
      const [duplicate] = await tx`select 1 from bank_accounts where property_id=${session.propertyId}::uuid and lower(name)=lower(${input.name})`;
      if (duplicate) throw new BankAccountRequestError("There is already a bank account with that name.");
      const [{ count }] = await tx<Array<{ count: number }>>`select count(*)::int as count from bank_accounts where property_id=${session.propertyId}::uuid and active`;
      const makeDefault = input.isDefault || count === 0;
      if (makeDefault) await tx`update bank_accounts set is_default=false,updated_at=now() where property_id=${session.propertyId}::uuid and is_default`;
      const [created] = await tx<Array<{ id: string }>>`
        insert into bank_accounts (property_id,name,bank_name,account_last4,account_type,is_default)
        values (${session.propertyId}::uuid,${input.name},${input.bankName || null},${input.last4 ?? null},${input.accountType},${makeDefault})
        returning id
      `;
      if (input.openingBalanceCents > 0) {
        const businessDate = await propertyBusinessDate(tx, session.propertyId);
        const description = `Opening balance · ${input.name}`;
        const [movement] = await tx<Array<{ id: string }>>`
          insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,description,bank_account_id,created_by_auth_user_id)
          values (${session.propertyId}::uuid,${businessDate}::date,null,'bank',${input.openingBalanceCents},'opening_balance','bank-account',${description},${created.id}::uuid,${actorId(session.authUserId)}::uuid)
          returning id
        `;
        await tx`update cash_movements set resource_id=${created.id}::uuid where id=${movement.id}::uuid`;
        await postProductionLedger(tx, {
          propertyId: session.propertyId, businessDate, resourceType: "bank-account", resourceId: created.id,
          description, debitAccount: bankLedgerAccount(input.name), creditAccount: "Opening Balance Equity", amountCents: input.openingBalanceCents,
        });
      }
      return created;
    });
    return Response.json({ account }, { status: 201 });
  } catch (error) {
    if (error instanceof BankAccountRequestError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

async function routePATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "expenses.manage");
    if (!hasProductionDatabase()) return Response.json({ error: "Bank accounts need the PMS database." }, { status: 503 });
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the bank account details." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`cash:${session.propertyId}`}))`;
      const accounts = await bankAccountBalances(tx, session.propertyId);
      const account = accounts.find((item) => item.id === input.id);
      if (!account) throw new BankAccountRequestError("Bank account not found.");

      if (input.action === "reconcile") {
        const difference = input.statementBalanceCents - account.balanceCents;
        if (difference === 0) return { balanced: true };
        const businessDate = await propertyBusinessDate(tx, session.propertyId);
        const description = `Matched to bank statement ${usd(input.statementBalanceCents)}: ${difference > 0 ? "up" : "down"} ${usd(Math.abs(difference))}`;
        const [movement] = await tx<Array<{ id: string }>>`
          insert into cash_movements (property_id,business_date,from_location,to_location,amount_cents,kind,resource_type,resource_id,description,note,bank_account_id,created_by_auth_user_id)
          values (${session.propertyId}::uuid,${businessDate}::date,${difference < 0 ? "bank" : null},${difference > 0 ? "bank" : null},${Math.abs(difference)},'bank_reconcile','bank-account',${account.id}::uuid,${description},${input.note ?? null},${account.id}::uuid,${actorId(session.authUserId)}::uuid)
          returning id
        `;
        await postProductionLedger(tx, {
          propertyId: session.propertyId, businessDate, resourceType: "cash-movement", resourceId: movement.id, description,
          debitAccount: difference > 0 ? bankLedgerAccount(account.name) : "Bank Fees & Adjustments",
          creditAccount: difference > 0 ? "Bank Fees & Adjustments" : bankLedgerAccount(account.name),
          amountCents: Math.abs(difference),
        });
        return { reconciled: true };
      }

      if (input.active === false) {
        if (account.balanceCents !== 0) throw new BankAccountRequestError(`This account still holds ${usd(account.balanceCents)}. Move or match the balance to $0 before closing it.`);
        if (account.isDefault) throw new BankAccountRequestError("Make another account the default before closing this one.");
      }
      const newName = input.name && input.name !== account.name ? input.name : null;
      if (newName) {
        const [duplicate] = await tx`select 1 from bank_accounts where property_id=${session.propertyId}::uuid and lower(name)=lower(${newName}) and id<>${account.id}::uuid`;
        if (duplicate) throw new BankAccountRequestError("There is already a bank account with that name.");
        // The ledger account follows the bank account's name.
        await tx`update ledger_entries set account=${bankLedgerAccount(newName)} where property_id=${session.propertyId}::uuid and account=${bankLedgerAccount(account.name)}`;
      }
      if (input.isDefault) await tx`update bank_accounts set is_default=false,updated_at=now() where property_id=${session.propertyId}::uuid and is_default and id<>${account.id}::uuid`;
      await tx`
        update bank_accounts set
          name=coalesce(${newName},name),
          bank_name=case when ${input.bankName !== undefined} then ${input.bankName || null} else bank_name end,
          account_last4=case when ${input.last4 !== undefined || "last4" in input} then ${input.last4 ?? null} else account_last4 end,
          account_type=coalesce(${input.accountType ?? null},account_type),
          is_default=case when ${input.isDefault === true} then true else is_default end,
          active=coalesce(${input.active ?? null},active),
          updated_at=now()
        where id=${account.id}::uuid and property_id=${session.propertyId}::uuid
      `;
      return { updated: true };
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof BankAccountRequestError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
export const PATCH = withRequestContext(routePATCH);
