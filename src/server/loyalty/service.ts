import type { TransactionSql } from "postgres";

type LoyaltyMember = {
  id: string;
  programId: string;
  nightsRequired: number;
  rewardDescription: string;
  rewardValueCents: number | null;
};

/**
 * Turn complete thresholds into explicit reward rows and debit the progress
 * balance. The membership row is locked by every caller before this runs, so
 * two checkouts cannot issue the same reward.
 */
export async function issueAvailableRewards(
  tx: TransactionSql,
  propertyId: string,
  member: LoyaltyMember,
  actorAuthUserId: string,
) {
  const [balanceRow] = await tx<Array<{ nights: number }>>`
    select coalesce(sum(nights_delta),0)::int as nights
    from loyalty_transactions where property_id=${propertyId}::uuid and membership_id=${member.id}::uuid
  `;
  let balance = balanceRow?.nights ?? 0;
  let issued = 0;
  while (balance >= member.nightsRequired) {
    const [countRow] = await tx<Array<{ count: number }>>`
      select count(*)::int as count from loyalty_rewards where membership_id=${member.id}::uuid
    `;
    const sequence = (countRow?.count ?? 0) + 1;
    const [reward] = await tx<Array<{ id: string }>>`
      insert into loyalty_rewards (property_id,membership_id,program_id,status,description,value_cents)
      values (${propertyId}::uuid,${member.id}::uuid,${member.programId}::uuid,'available',${member.rewardDescription},${member.rewardValueCents})
      returning id
    `;
    await tx`
      insert into loyalty_transactions
        (property_id,membership_id,reward_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
      values
        (${propertyId}::uuid,${member.id}::uuid,${reward.id}::uuid,'reward_issued',${-member.nightsRequired},
         ${`Reward unlocked: ${member.rewardDescription}`},${`reward:${member.id}:${sequence}`},${actorAuthUserId}::uuid)
    `;
    balance -= member.nightsRequired;
    issued += 1;
  }
  return issued;
}

async function voidAvailableRewardsForNegativeBalance(
  tx: TransactionSql,
  propertyId: string,
  membershipId: string,
  actorAuthUserId: string,
) {
  const [balanceRow] = await tx<Array<{ nights: number }>>`
    select coalesce(sum(nights_delta),0)::int as nights
    from loyalty_transactions where property_id=${propertyId}::uuid and membership_id=${membershipId}::uuid
  `;
  let balance = balanceRow?.nights ?? 0;
  while (balance < 0) {
    const [reward] = await tx<Array<{ id: string; nights: number }>>`
      select lr.id,(-lt.nights_delta)::int as nights
      from loyalty_rewards lr
      join loyalty_transactions lt on lt.reward_id=lr.id and lt.type='reward_issued'
      where lr.property_id=${propertyId}::uuid and lr.membership_id=${membershipId}::uuid and lr.status='available'
      order by lr.issued_at desc,lr.id desc limit 1
      for update of lr
    `;
    if (!reward || reward.nights <= 0) break;
    await tx`update loyalty_rewards set status='void',updated_at=now() where id=${reward.id}::uuid`;
    await tx`
      insert into loyalty_transactions
        (property_id,membership_id,reward_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
      values
        (${propertyId}::uuid,${membershipId}::uuid,${reward.id}::uuid,'reward_voided',${reward.nights},
         'Reward voided after qualifying stay reversal',${`reward-voided:${reward.id}`},${actorAuthUserId}::uuid)
      on conflict (property_id,idempotency_key) do nothing
    `;
    balance += reward.nights;
  }
}

/**
 * Reconcile one reservation with the loyalty ledger. Repeated checkout calls
 * are harmless; an undone checkout writes a reversal instead of deleting the
 * original credit, and a later checkout can earn the stay again.
 */
export async function syncReservationLoyalty(
  tx: TransactionSql,
  input: { propertyId: string; reservationId: string; actorAuthUserId: string },
) {
  const [row] = await tx<Array<{
    membershipId: string;
    programId: string;
    status: string;
    nightsRequired: number;
    rewardDescription: string;
    rewardValueCents: number | null;
    reservationStatus: string;
    version: number;
    nights: number;
    roomRentCents: number;
    confirmationNumber: string;
  }>>`
    select lm.id as "membershipId",lm.program_id as "programId",lm.status,
      coalesce(lm.custom_nights_required,lp.nights_required)::int as "nightsRequired",
      coalesce(nullif(lm.custom_reward_description,''),lp.reward_description) as "rewardDescription",
      lp.reward_value_cents as "rewardValueCents",r.status as "reservationStatus",r.version,
      greatest(r.departure_date-r.arrival_date,1)::int as nights,r.confirmation_number as "confirmationNumber",
      coalesce((select sum(c.amount_cents) from charges c join folios f on f.id=c.folio_id
        where f.reservation_id=r.id and c.status='posted' and c.type='Room Rent'),0)::int as "roomRentCents"
    from reservations r
    join loyalty_memberships lm on lm.guest_id=r.main_guest_id and lm.property_id=r.property_id
    join loyalty_programs lp on lp.id=lm.program_id
    where r.id=${input.reservationId}::uuid and r.property_id=${input.propertyId}::uuid
    for update of lm
  `;
  if (!row || row.status !== "active") return { changed: false, issued: 0 };

  const expected = row.reservationStatus === "checked_out" && row.roomRentCents > 0 ? row.nights : 0;
  const [creditedRow] = await tx<Array<{ nights: number }>>`
    select coalesce(sum(nights_delta),0)::int as nights from loyalty_transactions
    where property_id=${input.propertyId}::uuid and membership_id=${row.membershipId}::uuid
      and reservation_id=${input.reservationId}::uuid and type in ('enrollment_credit','stay_credit','stay_reversal')
  `;
  const credited = creditedRow?.nights ?? 0;
  const delta = expected - credited;
  if (!delta) return { changed: false, issued: 0 };
  const type = delta > 0 ? "stay_credit" : "stay_reversal";
  const [inserted] = await tx<Array<{ id: string }>>`
    insert into loyalty_transactions
      (property_id,membership_id,reservation_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
    values
      (${input.propertyId}::uuid,${row.membershipId}::uuid,${input.reservationId}::uuid,${type},${delta},
       ${delta > 0 ? `Stay ${row.confirmationNumber}` : `Checkout undone · ${row.confirmationNumber}`},
       ${`stay:${input.reservationId}:v${row.version}:target:${expected}`},${input.actorAuthUserId}::uuid)
    on conflict (property_id,idempotency_key) do nothing returning id
  `;
  if (!inserted) return { changed: false, issued: 0 };
  if (delta < 0) {
    await voidAvailableRewardsForNegativeBalance(tx, input.propertyId, row.membershipId, input.actorAuthUserId);
  }
  const issued = await issueAvailableRewards(tx, input.propertyId, {
    id: row.membershipId,
    programId: row.programId,
    nightsRequired: row.nightsRequired,
    rewardDescription: row.rewardDescription,
    rewardValueCents: row.rewardValueCents,
  }, input.actorAuthUserId);
  return { changed: true, issued };
}
