import { z } from "zod";

import { propertyAccessResponse, requirePropertySession, requireSettingsSection } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { BankAccountError, bankAccountFor } from "@/server/finance/cash-sources";
import { withRequestContext } from "@/server/db/request-context";

export const dynamic = "force-dynamic";

// Settings › Payment Terminals: the motel's card terminals of any brand.
// The front desk picks the terminal that ran each card payment; deposits are
// matched per terminal.

const TERMINAL_PROVIDERS = ["chase", "clover", "square", "worldpay", "fiserv", "heartland", "elavon", "stripe", "other"] as const;
const mappingSchema = z.object({
  date: z.string().max(120), net: z.string().max(120), gross: z.string().max(120).optional(), fee: z.string().max(120).optional(),
  reference: z.string().max(120).optional(), batchDate: z.string().max(120).optional(),
}).nullable();
const baseFields = {
  name: z.string().trim().min(1, "Enter the terminal name.").max(60),
  provider: z.enum(TERMINAL_PROVIDERS),
  terminalCode: z.string().trim().max(60).optional(),
  depositBankAccountId: z.string().uuid().nullable().optional(),
  depositDelayDays: z.number().int().min(0).max(14),
  isDefault: z.boolean().optional(),
};
const createSchema = z.object({ action: z.literal("create"), ...baseFields });
const updateSchema = z.object({ action: z.literal("update"), id: z.string().uuid(), ...baseFields, active: z.boolean().optional() });
const mappingAction = z.object({ action: z.literal("mapping"), id: z.string().uuid(), mapping: mappingSchema });
const actionSchema = z.discriminatedUnion("action", [createSchema, updateSchema, mappingAction]);

class TerminalRequestError extends Error {}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "payments.manage");
    if (!hasProductionDatabase()) return Response.json({ terminals: [] });
    const terminals = await productionSql()`
      select t.id, t.name, t.provider, t.terminal_code as "terminalCode", t.deposit_bank_account_id as "depositBankAccountId",
        b.name as "depositBankAccountName", t.deposit_delay_days as "depositDelayDays", t.is_default as "isDefault", t.active, t.report_mapping as "reportMapping"
      from card_terminals t left join bank_accounts b on b.id=t.deposit_bank_account_id
      where t.property_id=${session.propertyId}::uuid order by t.active desc, t.is_default desc, t.created_at
    `;
    return Response.json({ terminals }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
  try {
    const parsed = actionSchema.safeParse(await request.clone().json().catch(() => null));
    // Remembering a report's columns is part of recording deposits; changing terminals is setup.
    const session = await requirePropertySession(request, parsed.success && parsed.data.action === "mapping" ? "expenses.manage" : "property.manage");
    if (!(parsed.success && parsed.data.action === "mapping")) requireSettingsSection(session, "Payment Terminals");
    if (!hasProductionDatabase()) return Response.json({ error: "Card terminals need the PMS database." }, { status: 503 });
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the terminal details." }, { status: 400 });
    const input = parsed.data;
    const result = await productionSql().begin(async (tx) => {
      if (input.action === "mapping") {
        const [row] = await tx`update card_terminals set report_mapping=${input.mapping ? tx.json(input.mapping) : null},updated_at=now() where id=${input.id}::uuid and property_id=${session.propertyId}::uuid returning id`;
        if (!row) throw new TerminalRequestError("Terminal not found.");
        return { saved: true };
      }
      const bank = input.depositBankAccountId ? await bankAccountFor(tx, session.propertyId, input.depositBankAccountId) : null;
      const [duplicate] = await tx`select 1 from card_terminals where property_id=${session.propertyId}::uuid and lower(name)=lower(${input.name}) and id<>${input.action === "update" ? input.id : "00000000-0000-0000-0000-000000000000"}::uuid`;
      if (duplicate) throw new TerminalRequestError("There is already a terminal with that name.");
      const [{ count }] = await tx<Array<{ count: number }>>`select count(*)::int as count from card_terminals where property_id=${session.propertyId}::uuid and active`;
      const makeDefault = input.isDefault === true || (input.action === "create" && count === 0);
      if (makeDefault) await tx`update card_terminals set is_default=false,updated_at=now() where property_id=${session.propertyId}::uuid and is_default`;
      if (input.action === "create") {
        const [created] = await tx<Array<{ id: string }>>`
          insert into card_terminals (property_id,name,provider,terminal_code,deposit_bank_account_id,deposit_delay_days,is_default)
          values (${session.propertyId}::uuid,${input.name},${input.provider},${input.terminalCode || null},${bank?.id ?? null}::uuid,${input.depositDelayDays},${makeDefault})
          returning id
        `;
        return { id: created.id };
      }
      const [updated] = await tx`
        update card_terminals set name=${input.name}, provider=${input.provider}, terminal_code=${input.terminalCode || null},
          deposit_bank_account_id=${bank?.id ?? null}::uuid, deposit_delay_days=${input.depositDelayDays},
          is_default=case when ${makeDefault} then true when ${input.active === false} then false else is_default end,
          active=coalesce(${input.active ?? null},active), updated_at=now()
        where id=${input.id}::uuid and property_id=${session.propertyId}::uuid returning id
      `;
      if (!updated) throw new TerminalRequestError("Terminal not found.");
      return { id: input.id };
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof TerminalRequestError || error instanceof BankAccountError) return Response.json({ error: error.message }, { status: 409 });
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
