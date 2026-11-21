import type { TransactionSql } from "postgres";

import { logReservationActivity, money, type ActivityActor } from "@/server/activity/reservation-activity";
import { postProductionLedger, propertyBusinessDate } from "@/server/finance/production-finance";

type Tx = TransactionSql<Record<string, never>>;

export function calculateRewardApplication(input: {
  rewardType: string; valueCents: number | null; percentBasisPoints: number | null;
  balanceCents: number; roomRentCents: number; roomTaxCents: number; freeNightCents: number; freeNightTaxCents: number;
}) {
  const requested = input.rewardType === "free_night"
    ? input.freeNightCents
    : input.rewardType === "percent_discount"
      ? Math.round(input.roomRentCents * (input.percentBasisPoints ?? 0) / 10_000)
      : input.valueCents ?? 0;
  const discountCents = Math.min(Math.max(0, requested), input.roomRentCents, input.balanceCents);
  const proportionalTax = input.rewardType === "free_night"
    ? input.freeNightTaxCents
    : Math.round(input.roomTaxCents * discountCents / Math.max(1, input.roomRentCents));
  const taxCents = Math.min(Math.max(0, proportionalTax), Math.max(0, input.balanceCents - discountCents));
  return { discountCents, taxCents, totalCents: discountCents + taxCents };
}

export async function applyLoyaltyReward(tx: Tx, actor: ActivityActor, input: {
  membershipId: string;
  rewardId: string;
  reservationId: string;
}) {
  const [row] = await tx<Array<{
    rewardId: string; description: string; rewardType: string; valueCents: number | null; percentBasisPoints: number | null;
    confirmationNumber: string; folioId: string; balanceCents: number; roomRentCents: number; roomTaxCents: number;
    freeNightCents: number; freeNightTaxCents: number;
  }>>`
    select lr.id as "rewardId",lr.description,lr.reward_type as "rewardType",lr.value_cents as "valueCents",
      lr.percent_basis_points as "percentBasisPoints",r.confirmation_number as "confirmationNumber",f.id as "folioId",
      (coalesce((select sum(c.amount_cents+coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0)) from charges c join folios af on af.id=c.folio_id where af.reservation_id=r.id and c.status='posted'),0)
       -coalesce((select sum(pa.amount_cents) from payment_allocations pa join folios af on af.id=pa.folio_id where af.reservation_id=r.id),0))::int as "balanceCents",
      coalesce((select sum(c.amount_cents) from charges c join folios af on af.id=c.folio_id where af.reservation_id=r.id and c.status='posted' and c.type='Room Rent'),0)::int as "roomRentCents",
      coalesce((select sum(ct.amount_cents) from charge_taxes ct join charges c on c.id=ct.charge_id join folios af on af.id=c.folio_id where af.reservation_id=r.id and c.status='posted' and c.type='Room Rent'),0)::int as "roomTaxCents",
      coalesce((select c.amount_cents from charges c join folios af on af.id=c.folio_id where af.reservation_id=r.id and c.status='posted' and c.type='Room Rent' order by c.amount_cents desc,c.service_date limit 1),0)::int as "freeNightCents",
      coalesce((select coalesce((select sum(ct.amount_cents) from charge_taxes ct where ct.charge_id=c.id),0) from charges c join folios af on af.id=c.folio_id where af.reservation_id=r.id and c.status='posted' and c.type='Room Rent' order by c.amount_cents desc,c.service_date limit 1),0)::int as "freeNightTaxCents"
    from loyalty_rewards lr
    join loyalty_memberships lm on lm.id=lr.membership_id and lm.property_id=lr.property_id
    join reservations r on r.id=${input.reservationId}::uuid and r.property_id=lr.property_id and r.main_guest_id=lm.guest_id
    join lateral (select id from folios where reservation_id=r.id and property_id=r.property_id and status='open' order by created_at limit 1) f on true
    where lr.id=${input.rewardId}::uuid and lr.membership_id=${input.membershipId}::uuid and lr.property_id=${actor.propertyId}::uuid
      and lr.status='available' and (lr.expires_at is null or lr.expires_at>now())
      and r.status not in ('cancelled','no_show')
    for update of lr
  `;
  if (!row) throw new Error("Choose an open reservation for this guest before redeeming the reward.");
  if (row.balanceCents <= 0 || row.roomRentCents <= 0) throw new Error("This reservation has no room balance available for a loyalty discount.");

  const { discountCents, taxCents } = calculateRewardApplication(row);
  if (!discountCents) throw new Error("This reward does not have a usable discount value.");
  const businessDate = await propertyBusinessDate(tx, actor.propertyId);
  const [charge] = await tx<Array<{ id: string }>>`
    insert into charges (property_id,folio_id,type,description,service_date,amount_cents,taxable,status)
    values (${actor.propertyId}::uuid,${row.folioId}::uuid,'Loyalty Reward',${`Loyalty reward · ${row.description}`},${businessDate}::date,${-discountCents},false,'posted')
    returning id
  `;
  if (taxCents > 0) await tx`
    insert into charge_taxes (property_id,charge_id,name,rate_basis_points,amount_cents,override_reason)
    values (${actor.propertyId}::uuid,${charge.id}::uuid,'Tax reversal',0,${-taxCents},'Loyalty reward applied')
  `;
  await postProductionLedger(tx, { propertyId: actor.propertyId, businessDate, resourceType: "loyalty-redemption", resourceId: charge.id, description: `Loyalty reward · ${row.description}`, debitAccount: "Room Revenue", creditAccount: "Guest Receivable", amountCents: discountCents });
  if (taxCents > 0) await postProductionLedger(tx, { propertyId: actor.propertyId, businessDate, resourceType: "loyalty-redemption-tax", resourceId: charge.id, description: `Loyalty reward tax reversal · ${row.description}`, debitAccount: "Tax Payable", creditAccount: "Guest Receivable", amountCents: taxCents });
  await tx`update loyalty_rewards set status='redeemed',reservation_id=${input.reservationId}::uuid,charge_id=${charge.id}::uuid,
    applied_discount_cents=${discountCents},applied_tax_cents=${taxCents},redeemed_at=now(),redemption_note=${`Applied to ${row.confirmationNumber}`},updated_at=now()
    where id=${row.rewardId}::uuid`;
  await logReservationActivity(tx, actor, input.reservationId, "Charge", `Loyalty reward redeemed · ${row.description} · ${money(discountCents + taxCents)} credit`);
  return { discountCents, taxCents, totalCents: discountCents + taxCents, confirmationNumber: row.confirmationNumber };
}

export async function restoreLoyaltyReward(tx: Tx, actor: ActivityActor, input: { membershipId: string; rewardId: string; reason: string }) {
  const [row] = await tx<Array<{ rewardId: string; description: string; reservationId: string | null; chargeId: string | null; discountCents: number | null; taxCents: number | null }>>`
    select id as "rewardId",description,reservation_id as "reservationId",charge_id as "chargeId",
      applied_discount_cents as "discountCents",applied_tax_cents as "taxCents"
    from loyalty_rewards where id=${input.rewardId}::uuid and membership_id=${input.membershipId}::uuid
      and property_id=${actor.propertyId}::uuid and status='redeemed' for update
  `;
  if (!row) throw new Error("Only a redeemed reward can be restored.");
  if (row.chargeId && row.reservationId && row.discountCents) {
    const [charge] = await tx<Array<{ status: string }>>`select status from charges where id=${row.chargeId}::uuid and property_id=${actor.propertyId}::uuid for update`;
    if (!charge || charge.status !== "posted") throw new Error("The folio credit for this reward is no longer available to reverse.");
    const businessDate = await propertyBusinessDate(tx, actor.propertyId);
    await tx`update charges set status='voided',updated_at=now() where id=${row.chargeId}::uuid`;
    await postProductionLedger(tx, { propertyId: actor.propertyId, businessDate, resourceType: "loyalty-restoration", resourceId: row.chargeId, description: `Restored loyalty reward · ${row.description}`, debitAccount: "Guest Receivable", creditAccount: "Room Revenue", amountCents: row.discountCents });
    if ((row.taxCents ?? 0) > 0) await postProductionLedger(tx, { propertyId: actor.propertyId, businessDate, resourceType: "loyalty-restoration-tax", resourceId: row.chargeId, description: `Restored loyalty reward tax · ${row.description}`, debitAccount: "Guest Receivable", creditAccount: "Tax Payable", amountCents: row.taxCents! });
    await logReservationActivity(tx, actor, row.reservationId, "Charge", `Loyalty reward restored · ${row.description} · ${input.reason}`);
  }
  await tx`update loyalty_rewards set status='available',reservation_id=null,charge_id=null,applied_discount_cents=null,applied_tax_cents=null,
    redeemed_at=null,redemption_note=${input.reason},updated_at=now() where id=${row.rewardId}::uuid`;
}
