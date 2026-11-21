import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "guests.manage");
    const sql = productionSql();
    const [summary] = await sql<Array<Record<string, unknown>>>`
      select
        (select count(*)::int from loyalty_memberships where property_id=${session.propertyId}::uuid) as members,
        (select count(*)::int from loyalty_rewards where property_id=${session.propertyId}::uuid and status='available' and (expires_at is null or expires_at>now())) as "availableRewards",
        (select count(*)::int from loyalty_rewards where property_id=${session.propertyId}::uuid and status='redeemed') as "redeemedRewards",
        (select coalesce(sum(coalesce(applied_discount_cents,0)+coalesce(applied_tax_cents,0)),0)::int from loyalty_rewards where property_id=${session.propertyId}::uuid and status='redeemed') as "redemptionValueCents",
        (select count(*)::int from loyalty_reminders where property_id=${session.propertyId}::uuid and status='sent') as "remindersSent",
        (select count(*)::int from loyalty_reminders where property_id=${session.propertyId}::uuid and status='failed') as "remindersFailed",
        (select count(*)::int from loyalty_memberships lm where lm.property_id=${session.propertyId}::uuid and (select count(*) from reservations r where r.main_guest_id=lm.guest_id and r.status='checked_out')>=2) as "repeatMembers",
        (select coalesce(sum(c.amount_cents),0)::int from charges c join folios f on f.id=c.folio_id join reservations r on r.id=f.reservation_id join loyalty_memberships lm on lm.guest_id=r.main_guest_id and lm.property_id=r.property_id where c.property_id=${session.propertyId}::uuid and c.status='posted' and c.type='Room Rent' and r.status='checked_out') as "memberRoomRevenueCents",
        (select count(*)::int from loyalty_campaigns where property_id=${session.propertyId}::uuid and status='active') as "activeCampaigns"
    `;
    const trend = await sql<Array<Record<string, unknown>>>`
      select day::date::text as date,
        (select count(*)::int from loyalty_memberships lm where lm.property_id=${session.propertyId}::uuid and lm.joined_at>=day and lm.joined_at<day+interval '1 day') as "membersJoined",
        (select count(*)::int from loyalty_rewards lr where lr.property_id=${session.propertyId}::uuid and lr.redeemed_at>=day and lr.redeemed_at<day+interval '1 day') as redemptions,
        (select coalesce(sum(lt.nights_delta),0)::int from loyalty_transactions lt where lt.property_id=${session.propertyId}::uuid and lt.type in ('enrollment_credit','stay_credit') and lt.created_at>=day and lt.created_at<day+interval '1 day') as "nightsCredited"
      from generate_series(current_date-29,current_date,interval '1 day') day order by day
    `;
    return Response.json({ summary, trend });
  } catch (error) { return propertyAccessResponse(error); }
}

export const GET = withRequestContext(routeGET);
