import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

/**
 * Payroll per employee, for Settings › Employees: an employee who has been
 * paid can only be made inactive, and one with pay still owed can be neither
 * made inactive nor deleted. Read-only (unlike GET /api/payroll, which
 * creates pay periods).
 */
export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "payroll.manage");
    if (!hasProductionDatabase()) return Response.json({ employees: [] });
    const rows = await productionSql()<Array<{ name: string; paidCount: number; owedCents: number; owedPeriods: number }>>`
      with entries as (
        select pe.employee_id,pe.paid,pe.gross_pay_cents
            + coalesce(case when pe.description ~ '^\\s*\\{' then (pe.description::jsonb->>'adjustmentCents')::int end,0) as total,
          -- Owed pay is what the Pay Schedule shows: not deleted, and a custom
          -- date range only once approved.
          coalesce(case when pe.description ~ '^\\s*\\{' then (pe.description::jsonb->>'removed')::boolean end,false)
            or (pp.status='custom' and coalesce(pe.description,'') not like '%"Approved"%') as removed
        from payroll_entries pe join pay_periods pp on pp.id=pe.pay_period_id
        where pe.property_id=${session.propertyId}::uuid
      )
      select e.name,
        count(*) filter (where x.paid)::int as "paidCount",
        coalesce(sum(x.total) filter (where not x.paid and not x.removed and x.total > 0),0)::int as "owedCents",
        count(*) filter (where not x.paid and not x.removed and x.total > 0)::int as "owedPeriods"
      from employees e join entries x on x.employee_id=e.id
      where e.property_id=${session.propertyId}::uuid
      group by e.name
    `;
    return Response.json({ employees: rows });
  } catch (error) { return propertyAccessResponse(error); }
}
