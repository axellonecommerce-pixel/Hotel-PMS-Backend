import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shiftSchema = z.enum(["Day Shift", "Evening Shift", "Night Shift"]);
const requestSchema = z.object({
  date: dateSchema,
  shift: shiftSchema,
  manager: z.string().trim().min(1),
  countedCents: z.number().int().nonnegative(),
  droppedCents: z.number().int().nonnegative(),
  laundryIncomeCents: z.number().int().nonnegative(),
  cashExpenseCents: z.number().int().nonnegative(),
  cashExpenseCategory: z.string().trim().max(120).optional(),
  cashExpenseNote: z.string().trim().max(1000).optional(),
  housekeeperPaymentCents: z.number().int().nonnegative(),
  otherAdjustmentCents: z.number().int().min(-10_000_000).max(10_000_000),
  notes: z.string().trim().max(2000).optional(),
});

type CashRecord = {
  id: string;
  date: string;
  shift: "Day Shift" | "Evening Shift" | "Night Shift";
  expectedCents: number;
  countedCents: number;
  differenceCents: number;
  droppedCents: number;
  employee: string;
  status: "Balanced" | "Over" | "Short";
  notes?: string;
};

type StoredSettings = { property?: { cashFloatCents?: unknown } };

function shiftStatus(kind: "open" | "closed", shift: string) {
  return `${kind}:${shift}`;
}

function parseFloatCents(value: unknown) {
  if (!value || typeof value !== "object") return 20_000;
  const configured = (value as StoredSettings).property?.cashFloatCents;
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 0
    ? configured
    : 20_000;
}

function toRecord(row: {
  id: string; date: string; status: string; expectedCents: number | null; countedCents: number | null;
  openingCents: number; drawerFloatCents: number; droppedCents: number; employee: string; note: string | null;
}): CashRecord {
  const expectedCents = row.expectedCents ?? row.openingCents;
  const countedCents = row.countedCents ?? 0;
  const differenceCents = countedCents - expectedCents;
  const encodedShift = row.status.split(":")[1];
  const shift = encodedShift === "Day Shift" || encodedShift === "Evening Shift" || encodedShift === "Night Shift"
    ? encodedShift
    : "Night Shift";
  return {
    id: row.id,
    date: row.date,
    shift,
    expectedCents,
    countedCents,
    differenceCents,
    droppedCents: row.droppedCents,
    employee: row.employee,
    status: differenceCents === 0 ? "Balanced" : differenceCents > 0 ? "Over" : "Short",
    notes: row.note ?? undefined,
  };
}

async function listRecords(propertyId: string) {
  const rows = await productionSql()<Array<{
    id: string; date: string; status: string; expectedCents: number | null; countedCents: number | null;
    openingCents: number; drawerFloatCents: number; droppedCents: number; employee: string; note: string | null;
  }>>`
    select cs.id, bd.business_date::text as date, cs.status,
      cs.expected_cents as "expectedCents", cs.counted_cents as "countedCents",
      cs.opening_cents as "openingCents", cs.drawer_float_cents as "drawerFloatCents",
      coalesce(sum(cd.amount_cents),0)::int as "droppedCents", e.name as employee,
      max(cd.note) as note
    from cash_shifts cs
    join business_days bd on bd.id=cs.business_day_id
    join employees e on e.id=cs.employee_id
    left join cash_drops cd on cd.cash_shift_id=cs.id
    where cs.property_id=${propertyId}::uuid and cs.status like 'closed:%'
    group by cs.id,bd.business_date,e.name
    order by bd.business_date desc,cs.closed_at desc nulls last
    limit 100
  `;
  return rows.map(toRecord);
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    if (!hasProductionDatabase()) return Response.json({ records: [] });
    return Response.json({ records: await listRecords(session.propertyId) });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "cash.manage");
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Cash drop details are invalid." }, { status: 400 });
    if (!hasProductionDatabase()) return Response.json({ error: "Production database is unavailable." }, { status: 503 });
    const input = parsed.data;
    const saved = await productionSql().begin(async (tx) => {
      const [employee] = await tx<Array<{ id: string }>>`
        select id from employees
        where property_id=${session.propertyId}::uuid and active=true
          and lower(name)=lower(${input.manager})
          and lower(job_role) in ('owner','manager')
        limit 1
      `;
      if (!employee) return { error: "Choose an active employee with the Owner or Manager role." } as const;
      const [settings] = await tx<Array<{ value: unknown }>>`
        select value from property_settings
        where property_id=${session.propertyId}::uuid and key='application_settings'
      `;
      const drawerFloatCents = parseFloatCents(settings?.value);
      const [businessDay] = await tx<Array<{ id: string }>>`
        insert into business_days (property_id,business_date,status,opened_at)
        values (${session.propertyId}::uuid,${input.date},'open',now())
        on conflict (property_id,business_date) do update set status=case when business_days.status='closed' then 'open' else business_days.status end
        returning id
      `;
      const existing = await tx<Array<{ id: string }>>`
        select id from cash_shifts
        where property_id=${session.propertyId}::uuid and business_day_id=${businessDay.id}::uuid
          and status in (${shiftStatus("open", input.shift)},${shiftStatus("closed", input.shift)})
        order by opened_at desc limit 1 for update
      `;
      if (existing[0]) return { error: "This shift already has a completed cash drop. Create a correcting adjustment instead of replacing the audit record." } as const;
      const adjustmentTotal = input.laundryIncomeCents - input.cashExpenseCents - input.housekeeperPaymentCents + input.otherAdjustmentCents;
      const expectedCents = Math.max(0, drawerFloatCents + adjustmentTotal);
      if (input.droppedCents > Math.max(0, input.countedCents - drawerFloatCents)) {
        return { error: "Keep the configured drawer float in the drawer; only excess cash can be dropped." } as const;
      }
      if (input.countedCents < expectedCents && !input.notes) {
        return { error: "Add a reason when the drawer is short." } as const;
      }
      const [cashShift] = await tx<Array<{ id: string }>>`
        insert into cash_shifts (property_id,business_day_id,employee_id,opening_cents,expected_cents,counted_cents,drawer_float_cents,status,opened_at,closed_at)
        values (${session.propertyId}::uuid,${businessDay.id}::uuid,${employee.id}::uuid,${drawerFloatCents},${expectedCents},${input.countedCents},${drawerFloatCents},${shiftStatus("closed", input.shift)},now(),now())
        returning id
      `;
      const transactions = [
        ["laundry_income", input.laundryIncomeCents, "Laundry income"] as const,
        ["cash_expense", -input.cashExpenseCents, input.cashExpenseCategory ? `Cash expense: ${input.cashExpenseCategory}${input.cashExpenseNote ? ` — ${input.cashExpenseNote}` : ""}` : "Cash expense"] as const,
        ["housekeeper_payment", -input.housekeeperPaymentCents, "Housekeeper payment"] as const,
        ["other_adjustment", input.otherAdjustmentCents, "Other cash adjustment"] as const,
      ];
      for (const [type, amountCents, note] of transactions) {
        if (!amountCents) continue;
        await tx`
          insert into cash_shift_transactions (property_id,cash_shift_id,type,amount_cents,note)
          values (${session.propertyId}::uuid,${cashShift.id}::uuid,${type},${amountCents},${note})
        `;
      }
      await tx`
        insert into cash_drops (property_id,cash_shift_id,amount_cents,note)
        values (${session.propertyId}::uuid,${cashShift.id}::uuid,${input.droppedCents},${input.notes ?? null})
      `;
      return { id: cashShift.id } as const;
    });
    if ("error" in saved) return Response.json({ error: saved.error }, { status: 400 });
    return Response.json({ recordId: saved.id, records: await listRecords(session.propertyId) }, { status: 201 });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
