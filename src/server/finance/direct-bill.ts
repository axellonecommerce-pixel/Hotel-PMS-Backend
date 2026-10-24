import type { TransactionSql } from "postgres";

type Tx = TransactionSql<Record<string, never>>;

export const DIRECT_BILL_METHOD = "DIRECT BILL";

/**
 * FR-COM-002: when a company stay checks out, its open folio balances move to
 * the company invoice. A "DIRECT BILL" transfer settles each folio so the
 * reservation shows a zero balance; the company owes the same amount on its
 * invoice. Guest payments already on the folio are credited on the invoice.
 */
export async function transferBalanceToCompany(tx: Tx, input: {
  propertyId: string;
  reservationId: string;
  companyId: string;
  invoiceId: string;
  invoiceNumber: string;
  companyName: string;
  businessDate: string;
}) {
  const folios = await tx<Array<{ folioId: string; balanceCents: number; guestPaidCents: number }>>`
    select f.id as "folioId",
      (coalesce((select sum(c.amount_cents + coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c where c.folio_id=f.id and c.status='posted'),0)
        - coalesce((select sum(pa.amount_cents) from payment_allocations pa where pa.folio_id=f.id),0))::int as "balanceCents",
      coalesce((select sum(pa.amount_cents) from payment_allocations pa join payments p on p.id=pa.payment_id where pa.folio_id=f.id and p.method<>${DIRECT_BILL_METHOD}),0)::int as "guestPaidCents"
    from folios f
    where f.reservation_id=${input.reservationId}::uuid and f.property_id=${input.propertyId}::uuid
    for update of f
  `;
  const guestPaidCents = folios.reduce((sum, folio) => sum + folio.guestPaidCents, 0);
  const [credited] = await tx<Array<{ count: number }>>`
    select count(*)::int as count from invoice_lines where invoice_id=${input.invoiceId}::uuid and charge_id is null and amount_cents<0
  `;
  if (guestPaidCents > 0 && credited.count === 0) {
    await tx`
      insert into invoice_lines (property_id,invoice_id,description,amount_cents)
      values (${input.propertyId}::uuid,${input.invoiceId}::uuid,'Paid by guest at the front desk',${-guestPaidCents})
    `;
  }
  const open = folios.filter((folio) => folio.balanceCents > 0);
  const totalCents = open.reduce((sum, folio) => sum + folio.balanceCents, 0);
  if (!totalCents) return 0;
  const [payment] = await tx<Array<{ id: string }>>`
    insert into payments (property_id,reservation_id,company_id,method,amount_cents,currency_code,effective_date,external_reference,note)
    values (${input.propertyId}::uuid,${input.reservationId}::uuid,${input.companyId}::uuid,${DIRECT_BILL_METHOD},${totalCents},'USD',
      ${input.businessDate}::date,${input.invoiceNumber},${`Balance transferred to ${input.companyName} invoice ${input.invoiceNumber}`})
    returning id
  `;
  for (const folio of open) {
    await tx`insert into payment_allocations (property_id,payment_id,folio_id,amount_cents) values (${input.propertyId}::uuid,${payment.id}::uuid,${folio.folioId}::uuid,${folio.balanceCents})`;
  }
  return totalCents;
}
