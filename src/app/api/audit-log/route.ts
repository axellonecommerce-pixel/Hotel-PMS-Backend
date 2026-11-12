import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

/**
 * Settings › Change History (owners only): who added, changed or deleted
 * money and staff records, with the record before and after
 * (migration 0027). Newest first, 50 at a time.
 */
const AREAS: Record<string, string[]> = {
  payments: ["payments", "refunds", "payment_allocations", "security_deposits", "deposit_transactions", "folio_transfers"],
  charges: ["charges", "nightly_rates"],
  cash: ["paid_outs", "cash_shifts", "cash_drops", "cash_movements", "bank_accounts", "card_settlements"],
  expenses: ["expenses", "recurring_expenses"],
  payroll: ["payroll_entries", "time_entries"],
  companies: ["invoices", "invoice_payment_allocations", "company_credits", "house_account_charges"],
  staff: ["property_memberships", "property_settings", "dnr_overrides"],
};
const querySchema = z.object({
  area: z.enum(Object.keys(AREAS) as [string, ...string[]]).optional(),
  before: z.coerce.number().int().positive().optional(),
});

/** Field names whose values differ (ignoring timestamps), for a one-line summary. */
function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return [];
  return Object.keys({ ...before, ...after }).filter((key) => key !== "updated_at" && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "users.manage");
    if (session.role !== "owner") return Response.json({ error: "Only the motel owner can see the change history." }, { status: 403 });
    if (!hasProductionDatabase()) return Response.json({ entries: [] });
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: "Choose a valid area." }, { status: 400 });
    const sql = productionSql();
    const tables = parsed.data.area ? AREAS[parsed.data.area] : Object.values(AREAS).flat();
    const rows = await sql<Array<{ id: string; occurredAt: string; actor: string | null; actorLabel: string | null; action: string; tableName: string; rowId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>>`
      select a.id::text, a.occurred_at::text as "occurredAt", a.action, a.table_name as "tableName", a.row_id as "rowId", a.before, a.after, a.actor_label as "actorLabel",
        (select e.name from employees e join property_memberships m on m.id = e.membership_id
          where m.auth_user_id = a.actor_auth_user_id and m.property_id = a.property_id order by e.created_at limit 1) as actor
      from audit_log a
      where a.property_id = ${session.propertyId}::uuid and a.table_name = any(${tables}::text[])
        ${parsed.data.before ? sql`and a.id < ${parsed.data.before}` : sql``}
      order by a.id desc limit 50`.catch((error: { code?: string }) => {
      // Migration 0027 not applied yet: no history to show.
      if (error.code === "42P01") return [];
      throw error;
    });
    return Response.json({
      entries: rows.map((row) => ({
        ...row,
        who: row.actor ?? row.actorLabel ?? "Unknown",
        changed: changedFields(row.before, row.after),
      })),
      areas: Object.keys(AREAS),
    });
  } catch (error) { return propertyAccessResponse(error); }
}

export const GET = withRequestContext(routeGET);
