import type { Sql, TransactionSql } from "postgres";

import { otaDeductsCommission, type OtaPaymentStatus } from "@/domain/rules/commission";
import { postProductionLedger } from "@/server/finance/production-finance";

type Tx = TransactionSql<Record<string, never>>;

export const OTA_COMMISSION_CATEGORY = "OTA Commission";
export const OTA_DEDUCTED_METHOD = "Deducted by OTA";

export class OtaCommissionError extends Error {}

/**
 * Commission state lives in the ledger, keyed by reservation id:
 * - `ota-commission` entries accrue OTA Commission Expense (net debit = amount)
 *   against Commission Payable (hotel owes it) or Guest Receivable (OTA kept it).
 * - `ota-commission-paid` entries settle Commission Payable when the hotel pays.
 * The commission expense row in `expenses` uses the reservation id as its id,
 * so each reservation has at most one commission expense to find or update.
 */
export async function readReservationCommission(tx: Tx, propertyId: string, reservationId: string) {
  const [state] = await tx<Array<{ commissionCents: number; paidCents: number; otaPaymentStatus: string | null }>>`
    select
      coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le
        where le.property_id=${propertyId}::uuid and le.resource_type='ota-commission'
          and le.resource_id=${reservationId}::uuid and le.account='OTA Commission Expense'),0)::int as "commissionCents",
      coalesce((select sum(le.debit_cents) from ledger_entries le
        where le.property_id=${propertyId}::uuid and le.resource_type='ota-commission-paid'
          and le.resource_id=${reservationId}::uuid and le.account='Commission Payable'),0)::int as "paidCents",
      (select ota_payment_status from reservations where id=${reservationId}::uuid and property_id=${propertyId}::uuid) as "otaPaymentStatus"
  `;
  return { ...state, deducted: otaDeductsCommission(state.otaPaymentStatus as OtaPaymentStatus | null) };
}

async function vendorId(tx: Tx, propertyId: string, name: string) {
  const [existing] = await tx<Array<{ id: string }>>`
    select id from vendors where property_id=${propertyId}::uuid and lower(name)=lower(${name}) limit 1
  `;
  if (existing) return existing.id;
  const [created] = await tx<Array<{ id: string }>>`
    insert into vendors (property_id,name) values (${propertyId}::uuid,${name}) returning id
  `;
  return created.id;
}

/**
 * Move a reservation's commission to `targetCents`, posting only the delta so
 * the ledger keeps its history. Used by create, manual edit, cancel/no-show
 * (target 0) and reinstatement. A commission the hotel already paid cannot be
 * changed here; that needs a separate expense adjustment.
 */
export async function setReservationCommission(tx: Tx, input: {
  propertyId: string;
  reservationId: string;
  targetCents: number;
  businessDate: string;
  reason: string;
}) {
  const state = await readReservationCommission(tx, input.propertyId, input.reservationId);
  const targetCents = Math.max(0, Math.round(input.targetCents));
  const deltaCents = targetCents - state.commissionCents;
  if (deltaCents === 0) return { commissionCents: targetCents, changed: false };
  if (!state.deducted && state.paidCents > 0) {
    throw new OtaCommissionError("This commission has already been paid to the OTA. Record any adjustment as a separate expense.");
  }

  const [reservation] = await tx<Array<{ confirmationNumber: string; source: string; guestName: string; arrivalDate: string }>>`
    select r.confirmation_number as "confirmationNumber",coalesce(bs.name,'OTA') as source,
      concat(g.first_name,' ',g.last_name) as "guestName",r.arrival_date::text as "arrivalDate"
    from reservations r join guests g on g.id=r.main_guest_id left join booking_sources bs on bs.id=r.booking_source_id
    where r.id=${input.reservationId}::uuid and r.property_id=${input.propertyId}::uuid
  `;
  const counterAccount = state.deducted ? "Guest Receivable" : "Commission Payable";
  await postProductionLedger(tx, {
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    resourceType: "ota-commission",
    resourceId: input.reservationId,
    description: `${input.reason} · ${state.deducted ? "Commission deducted by OTA" : "Commission payable to OTA"} · ${reservation.source}`,
    debitAccount: deltaCents > 0 ? "OTA Commission Expense" : counterAccount,
    creditAccount: deltaCents > 0 ? counterAccount : "OTA Commission Expense",
    amountCents: Math.abs(deltaCents),
  });

  if (state.deducted) {
    // The OTA kept the commission: settle it on the folio and record it as an
    // expense that is already paid.
    const [settlement] = await tx<Array<{ id: string }>>`
      select id from payments where property_id=${input.propertyId}::uuid
        and reservation_id=${input.reservationId}::uuid and method='OTA COMMISSION' for update
    `;
    if (targetCents === 0) {
      if (settlement) {
        await tx`delete from payment_allocations where payment_id=${settlement.id}::uuid`;
        await tx`delete from payments where id=${settlement.id}::uuid`;
      }
      await tx`delete from expenses where id=${input.reservationId}::uuid and property_id=${input.propertyId}::uuid`;
    } else {
      if (settlement) {
        await tx`update payments set amount_cents=${targetCents} where id=${settlement.id}::uuid`;
        await tx`update payment_allocations set amount_cents=${targetCents} where payment_id=${settlement.id}::uuid`;
      } else {
        const [folio] = await tx<Array<{ id: string }>>`
          select id from folios where reservation_id=${input.reservationId}::uuid and property_id=${input.propertyId}::uuid
          order by created_at limit 1
        `;
        if (!folio) throw new OtaCommissionError("The reservation has no folio to settle the OTA commission against.");
        const [created] = await tx<Array<{ id: string }>>`
          insert into payments (property_id,reservation_id,method,amount_cents,currency_code,effective_date,external_reference,note)
          values (${input.propertyId}::uuid,${input.reservationId}::uuid,'OTA COMMISSION',${targetCents},'USD',${reservation.arrivalDate}::date,${reservation.confirmationNumber},${`Commission deducted by ${reservation.source}`})
          returning id
        `;
        await tx`insert into payment_allocations (property_id,payment_id,folio_id,amount_cents) values (${input.propertyId}::uuid,${created.id}::uuid,${folio.id}::uuid,${targetCents})`;
      }
      const vendor = await vendorId(tx, input.propertyId, reservation.source);
      await tx`
        insert into expenses (id,property_id,vendor_id,expense_date,category,description,payment_method,amount_cents)
        values (${input.reservationId}::uuid,${input.propertyId}::uuid,${vendor}::uuid,${reservation.arrivalDate}::date,${OTA_COMMISSION_CATEGORY},
          ${`Commission deducted by ${reservation.source} · ${reservation.confirmationNumber} · ${reservation.guestName}`},${OTA_DEDUCTED_METHOD},${targetCents})
        on conflict (id) do update set amount_cents=excluded.amount_cents,updated_at=now()
      `;
    }
  }
  return { commissionCents: targetCents, changed: true };
}

/** Pay outstanding Guest Pays Hotel commissions and record each as an expense. */
export async function payReservationCommission(tx: Tx, input: {
  propertyId: string;
  reservationId: string;
  paymentMethod: string;
  paidOn: string;
  reference?: string;
}) {
  const state = await readReservationCommission(tx, input.propertyId, input.reservationId);
  if (state.deducted) throw new OtaCommissionError("The OTA already deducted this commission.");
  const outstandingCents = state.commissionCents - state.paidCents;
  if (outstandingCents <= 0) throw new OtaCommissionError("This reservation has no commission left to pay.");
  const [reservation] = await tx<Array<{ confirmationNumber: string; source: string; guestName: string }>>`
    select r.confirmation_number as "confirmationNumber",coalesce(bs.name,'OTA') as source,concat(g.first_name,' ',g.last_name) as "guestName"
    from reservations r join guests g on g.id=r.main_guest_id left join booking_sources bs on bs.id=r.booking_source_id
    where r.id=${input.reservationId}::uuid and r.property_id=${input.propertyId}::uuid
  `;
  await postProductionLedger(tx, {
    propertyId: input.propertyId,
    businessDate: input.paidOn,
    resourceType: "ota-commission-paid",
    resourceId: input.reservationId,
    description: `Commission paid to ${reservation.source} · ${input.paymentMethod}${input.reference ? ` · ${input.reference}` : ""}`,
    debitAccount: "Commission Payable",
    creditAccount: ["Cash", "Check", "Debit Card"].includes(input.paymentMethod) ? "Cash" : "Accounts Payable",
    amountCents: outstandingCents,
  });
  const vendor = await vendorId(tx, input.propertyId, reservation.source);
  await tx`
    insert into expenses (id,property_id,vendor_id,expense_date,category,description,payment_method,amount_cents)
    values (${input.reservationId}::uuid,${input.propertyId}::uuid,${vendor}::uuid,${input.paidOn}::date,${OTA_COMMISSION_CATEGORY},
      ${`Commission paid to ${reservation.source} · ${reservation.confirmationNumber} · ${reservation.guestName}${input.reference ? ` · Ref ${input.reference}` : ""}`},${input.paymentMethod},${outstandingCents})
    on conflict (id) do update set amount_cents=expenses.amount_cents+excluded.amount_cents,payment_method=excluded.payment_method,expense_date=excluded.expense_date,updated_at=now()
  `;
  return { paidCents: outstandingCents };
}


export type OtaCommissionRow = {
  reservationId: string; confirmationNumber: string; guestName: string; source: string; otaPaymentStatus: string | null;
  reservationStatus: string; arrivalDate: string; departureDate: string; roomRentCents: number; taxCents: number;
  grossCents: number; commissionPercent: number; commissionCents: number; netCents: number; deducted: boolean;
  paidCents: number; outstandingCents: number; settlement: "Deducted by OTA" | "Paid" | "Payable" | "None";
  paidOn: string | null; paymentMethod: string | null;
};

/**
 * Per-reservation OTA commission breakdown (FR-RAT-004) shared by Expenses
 * and the OTA Commission report. Filters by arrival date when given.
 */
export async function listOtaCommissions(sql: Sql, propertyId: string, startDate?: string, endDate?: string) {
  const records = await sql<Array<Omit<OtaCommissionRow, "netCents" | "deducted" | "outstandingCents" | "settlement" | "grossCents">>>`
    select r.id as "reservationId",r.confirmation_number as "confirmationNumber",concat(g.first_name,' ',g.last_name) as "guestName",
      coalesce(bs.name,'Direct') as source,r.ota_payment_status as "otaPaymentStatus",r.status as "reservationStatus",
      r.arrival_date::text as "arrivalDate",r.departure_date::text as "departureDate",
      coalesce(rent.rent,0)::int as "roomRentCents",coalesce(rent.tax,0)::int as "taxCents",
      coalesce(bs.commission_basis_points,0)/100.0 as "commissionPercent",
      coalesce((select sum(le.debit_cents-le.credit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission' and le.resource_id=r.id and le.account='OTA Commission Expense'),0)::int as "commissionCents",
      coalesce((select sum(le.debit_cents) from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission-paid' and le.resource_id=r.id and le.account='Commission Payable'),0)::int as "paidCents",
      e.expense_date::text as "paidOn",e.payment_method as "paymentMethod"
    from reservations r
    join guests g on g.id=r.main_guest_id
    left join booking_sources bs on bs.id=r.booking_source_id
    left join expenses e on e.id=r.id and e.category=${OTA_COMMISSION_CATEGORY}
    left join lateral (
      select sum(c.amount_cents) as rent,sum(coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) as tax
      from charges c join folios f on f.id=c.folio_id
      where f.reservation_id=r.id and c.type='Room Rent' and c.status='posted'
    ) rent on true
    where r.property_id=${propertyId}::uuid
      and (lower(coalesce(bs.type,''))='ota' or coalesce(bs.commission_basis_points,0)>0
        or exists (select 1 from ledger_entries le where le.property_id=r.property_id and le.resource_type='ota-commission' and le.resource_id=r.id))
      and (${startDate ?? null}::date is null or r.arrival_date>=${startDate ?? null}::date)
      and (${endDate ?? null}::date is null or r.arrival_date<=${endDate ?? null}::date)
    order by r.arrival_date desc,r.created_at desc
  `;
  return records.map((record): OtaCommissionRow => {
    const deducted = otaDeductsCommission(record.otaPaymentStatus as OtaPaymentStatus | null);
    const grossCents = record.roomRentCents + record.taxCents;
    const outstandingCents = deducted ? 0 : Math.max(0, record.commissionCents - record.paidCents);
    return {
      ...record,
      commissionPercent: Number(record.commissionPercent),
      grossCents,
      netCents: grossCents - record.commissionCents,
      deducted,
      outstandingCents,
      settlement: record.commissionCents <= 0 ? "None" : deducted ? "Deducted by OTA" : outstandingCents > 0 ? "Payable" : "Paid",
      paidOn: deducted || record.paidCents > 0 ? record.paidOn : null,
      paymentMethod: deducted || record.paidCents > 0 ? record.paymentMethod : null,
    };
  });
}
