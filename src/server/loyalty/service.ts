import type { TransactionSql } from "postgres";

type LoyaltyMember = {
  id: string;
  programId: string;
  nightsRequired: number;
  rewardDescription: string;
  rewardValueCents: number | null;
  rewardType?: string;
  rewardPercentBasisPoints?: number | null;
  terms?: string | null;
  rewardExpiresDays?: number | null;
};

type EnsuredLoyaltyMember = LoyaltyMember & {
  guestId: string;
  memberNumber: string;
  status: string;
  programStatus: string;
  created: boolean;
};

function memberPrefix(propertyName: string) {
  const words = propertyName.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const value = (words.length > 1 ? words.map((word) => word[0]).join("") : words[0] ?? "INN").slice(0, 6);
  return value.length >= 2 ? value : "INN";
}

export function loyaltyMemberNumber(propertyName: string, guestId: string) {
  return `${memberPrefix(propertyName)}-${guestId.toUpperCase()}`;
}

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
    select progress_nights as nights from loyalty_member_progress
    where property_id=${propertyId}::uuid and membership_id=${member.id}::uuid
  `;
  let balance = balanceRow?.nights ?? 0;
  let issued = 0;
  while (balance >= member.nightsRequired) {
    const [countRow] = await tx<Array<{ count: number }>>`
      select count(*)::int as count from loyalty_rewards where membership_id=${member.id}::uuid
    `;
    const sequence = (countRow?.count ?? 0) + 1;
    const expiresAt = member.rewardExpiresDays ? new Date(Date.now() + member.rewardExpiresDays * 86_400_000).toISOString() : null;
    const [reward] = await tx<Array<{ id: string }>>`
      insert into loyalty_rewards (property_id,membership_id,program_id,status,description,value_cents,reward_type,percent_basis_points,terms,expires_at)
      values (${propertyId}::uuid,${member.id}::uuid,${member.programId}::uuid,'available',${member.rewardDescription},${member.rewardValueCents},
        ${member.rewardType ?? "free_night"},${member.rewardPercentBasisPoints ?? null},${member.terms ?? null},${expiresAt})
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

async function creditCompletedStays(
  tx: TransactionSql,
  propertyId: string,
  guestId: string,
  membershipId: string,
  actorAuthUserId: string,
) {
  const stays = await tx<Array<{ id: string; version: number; nights: number; confirmationNumber: string }>>`
    select r.id,r.version,r.confirmation_number as "confirmationNumber",
      greatest(
        least(
          r.departure_date,
          coalesce((select max((rr.checked_out_at at time zone p.timezone)::date) from reservation_rooms rr where rr.reservation_id=r.id),r.departure_date)
        ) - r.arrival_date,
        0
      )::int as nights
    from reservations r join properties p on p.id=r.property_id
    where r.property_id=${propertyId}::uuid and r.main_guest_id=${guestId}::uuid and r.status='checked_out'
      and exists (select 1 from charges c join folios f on f.id=c.folio_id where f.reservation_id=r.id and c.status='posted' and c.type='Room Rent' and c.amount_cents>0)
    order by r.departure_date,r.id
  `;
  if (!stays.length) return 0;
  const creditedRows = await tx<Array<{ reservationId: string; nights: number }>>`
    select reservation_id as "reservationId",coalesce(sum(nights_delta),0)::int as nights
    from loyalty_transactions
    where property_id=${propertyId}::uuid and membership_id=${membershipId}::uuid and reservation_id is not null
      and type in ('enrollment_credit','stay_credit','stay_reversal')
    group by reservation_id
  `;
  const creditedByReservation = new Map(creditedRows.map((row) => [row.reservationId, row.nights]));
  let reconciled = 0;
  for (const stay of stays) {
    const delta = stay.nights - (creditedByReservation.get(stay.id) ?? 0);
    if (!delta) continue;
    const type = delta > 0 ? "enrollment_credit" : "stay_reversal";
    const [inserted] = await tx<Array<{ id: string }>>`
      insert into loyalty_transactions
        (property_id,membership_id,reservation_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
      values
        (${propertyId}::uuid,${membershipId}::uuid,${stay.id}::uuid,${type},${delta},
         ${delta > 0 ? `Past stay ${stay.confirmationNumber}` : `Corrected stay ${stay.confirmationNumber}`},
         ${`stay:${stay.id}:v${stay.version}:target:${stay.nights}`},${actorAuthUserId}::uuid)
      on conflict (property_id,idempotency_key) do nothing returning id
    `;
    if (inserted) reconciled += delta;
  }
  return reconciled;
}

/**
 * Assign a stable, searchable member ID to an identified guest. Repeated
 * scans and concurrent saves return the same membership. Completed paid
 * stays are reconciled once, so a guest identified after earlier stays does
 * not lose their earned nights.
 */
export async function ensureLoyaltyMembership(
  tx: TransactionSql,
  input: {
    propertyId: string;
    guestId: string;
    actorAuthUserId: string;
    requireIdentity?: boolean;
    customNightsRequired?: number;
    customRewardDescription?: string;
    emailConsent?: boolean;
  },
): Promise<EnsuredLoyaltyMember | null> {
  const [guest] = await tx<Array<{ id: string; status: string; propertyName: string; hasIdentity: boolean }>>`
    select g.id,g.guest_status as status,p.name as "propertyName",
      exists(select 1 from guest_identities gi where gi.guest_id=g.id and gi.property_id=g.property_id and gi.deleted_at is null) as "hasIdentity"
    from guests g join properties p on p.id=g.property_id
    where g.id=${input.guestId}::uuid and g.property_id=${input.propertyId}::uuid and g.archived_at is null
    for update of g
  `;
  if (!guest || guest.status === "do_not_rent" || (input.requireIdentity !== false && !guest.hasIdentity)) return null;

  let [member] = await tx<Array<Omit<EnsuredLoyaltyMember, "created">>>`
    select lm.id,lm.guest_id as "guestId",lm.member_number as "memberNumber",lm.status,lp.status as "programStatus",lm.program_id as "programId",
      eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",
      eo.reward_value_cents as "rewardValueCents",eo.reward_type as "rewardType",
      eo.reward_percent_basis_points as "rewardPercentBasisPoints",eo.terms,
      eo.reward_expires_days as "rewardExpiresDays"
    from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
    join loyalty_effective_offers eo on eo.membership_id=lm.id
    where lm.property_id=${input.propertyId}::uuid and lm.guest_id=${guest.id}::uuid
    for update of lm
  `;
  let created = false;
  if (!member) {
    const [program] = await tx<Array<{ id: string }>>`
      insert into loyalty_programs (property_id,name,nights_required,reward_description)
      values (${input.propertyId}::uuid,${`${guest.propertyName} Rewards`},10,'One free night')
      on conflict (property_id) do update set property_id=excluded.property_id
      returning id
    `;
    const [inserted] = await tx<Array<{ id: string }>>`
      insert into loyalty_memberships
        (property_id,guest_id,program_id,member_number,custom_nights_required,custom_reward_description,sms_consent,email_consent,consented_at)
      values
        (${input.propertyId}::uuid,${guest.id}::uuid,${program.id}::uuid,${loyaltyMemberNumber(guest.propertyName, guest.id)},
         ${input.customNightsRequired ?? null},${input.customRewardDescription ?? null},false,${input.emailConsent ?? false},
         ${input.emailConsent ? new Date().toISOString() : null})
      on conflict (property_id,guest_id) do nothing returning id
    `;
    created = Boolean(inserted);
    [member] = await tx<Array<Omit<EnsuredLoyaltyMember, "created">>>`
      select lm.id,lm.guest_id as "guestId",lm.member_number as "memberNumber",lm.status,lp.status as "programStatus",lm.program_id as "programId",
        eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",
        eo.reward_value_cents as "rewardValueCents",eo.reward_type as "rewardType",
        eo.reward_percent_basis_points as "rewardPercentBasisPoints",eo.terms,
        eo.reward_expires_days as "rewardExpiresDays"
      from loyalty_memberships lm join loyalty_programs lp on lp.id=lm.program_id
      join loyalty_effective_offers eo on eo.membership_id=lm.id
      where lm.property_id=${input.propertyId}::uuid and lm.guest_id=${guest.id}::uuid
      for update of lm
    `;
  }
  if (!member) return null;
  if (member.status === "active" && member.programStatus === "active") {
    await creditCompletedStays(tx, input.propertyId, guest.id, member.id, input.actorAuthUserId);
    await voidAvailableRewardsForNegativeBalance(tx, input.propertyId, member.id, input.actorAuthUserId);
    await issueAvailableRewards(tx, input.propertyId, member, input.actorAuthUserId);
  }
  return { ...member, created };
}

async function voidAvailableRewardsForNegativeBalance(
  tx: TransactionSql,
  propertyId: string,
  membershipId: string,
  actorAuthUserId: string,
) {
  const [balanceRow] = await tx<Array<{ nights: number }>>`
    select raw_progress_nights as nights from loyalty_member_progress
    where property_id=${propertyId}::uuid and membership_id=${membershipId}::uuid
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
    const [inserted] = await tx<Array<{ id: string }>>`
      insert into loyalty_transactions
        (property_id,membership_id,reward_id,type,nights_delta,description,idempotency_key,actor_auth_user_id)
      values
        (${propertyId}::uuid,${membershipId}::uuid,${reward.id}::uuid,'reward_voided',${reward.nights},
         'Reward voided after qualifying stay reversal',${`reward-voided:${reward.id}`},${actorAuthUserId}::uuid)
      on conflict (property_id,idempotency_key) do nothing returning id
    `;
    await tx`update loyalty_rewards set status='void',updated_at=now() where id=${reward.id}::uuid`;
    if (inserted) {
      balance += reward.nights;
    } else {
      const [current] = await tx<Array<{ nights: number }>>`
        select raw_progress_nights as nights from loyalty_member_progress
        where property_id=${propertyId}::uuid and membership_id=${membershipId}::uuid
      `;
      balance = current?.nights ?? 0;
    }
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
  const [knownMember] = await tx<Array<{ id: string }>>`
    select lm.id from reservations r join loyalty_memberships lm on lm.guest_id=r.main_guest_id and lm.property_id=r.property_id
    where r.id=${input.reservationId}::uuid and r.property_id=${input.propertyId}::uuid
  `;
  if (!knownMember) {
    const [reservation] = await tx<Array<{ guestId: string }>>`
      select main_guest_id as "guestId" from reservations where id=${input.reservationId}::uuid and property_id=${input.propertyId}::uuid
    `;
    if (reservation) await ensureLoyaltyMembership(tx, {
      propertyId: input.propertyId,
      guestId: reservation.guestId,
      actorAuthUserId: input.actorAuthUserId,
    });
  }
  const [row] = await tx<Array<{
    membershipId: string;
    programId: string;
    status: string;
    programStatus: string;
    nightsRequired: number;
    rewardDescription: string;
    rewardValueCents: number | null;
    rewardType: string;
    rewardPercentBasisPoints: number | null;
    terms: string | null;
    rewardExpiresDays: number | null;
    reservationStatus: string;
    version: number;
    nights: number;
    roomRentCents: number;
    confirmationNumber: string;
  }>>`
    select lm.id as "membershipId",lm.program_id as "programId",lm.status,lp.status as "programStatus",
      eo.nights_required as "nightsRequired",eo.reward_description as "rewardDescription",
      eo.reward_value_cents as "rewardValueCents",eo.reward_type as "rewardType",
      eo.reward_percent_basis_points as "rewardPercentBasisPoints",eo.terms,
      eo.reward_expires_days as "rewardExpiresDays",
      r.status as "reservationStatus",r.version,
      greatest(
        least(
          r.departure_date,
          coalesce((select max((rr.checked_out_at at time zone p.timezone)::date) from reservation_rooms rr where rr.reservation_id=r.id),r.departure_date)
        ) - r.arrival_date,
        0
      )::int as nights,r.confirmation_number as "confirmationNumber",
      coalesce((select sum(c.amount_cents) from charges c join folios f on f.id=c.folio_id
        where f.reservation_id=r.id and c.status='posted' and c.type='Room Rent'),0)::int as "roomRentCents"
    from reservations r join properties p on p.id=r.property_id
    join loyalty_memberships lm on lm.guest_id=r.main_guest_id and lm.property_id=r.property_id
    join loyalty_programs lp on lp.id=lm.program_id
    join loyalty_effective_offers eo on eo.membership_id=lm.id
    where r.id=${input.reservationId}::uuid and r.property_id=${input.propertyId}::uuid
    for update of lm
  `;
  if (!row || row.status !== "active" || row.programStatus !== "active") return { changed: false, issued: 0 };

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
    rewardType: row.rewardType,
    rewardPercentBasisPoints: row.rewardPercentBasisPoints,
    terms: row.terms,
    rewardExpiresDays: row.rewardExpiresDays,
  }, input.actorAuthUserId);
  return { changed: true, issued };
}
