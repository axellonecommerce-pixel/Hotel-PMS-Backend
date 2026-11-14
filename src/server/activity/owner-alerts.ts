import type { TransactionSql } from "postgres";

import { money } from "@/server/activity/reservation-activity";

/**
 * Tells the owner (bell notification) when someone else deletes or refunds a
 * payment: taking cash and then removing or "refunding" it is the most common
 * front-desk theft. The owner's own actions are not announced to them.
 */
export async function alertOwnerOfMoneyChange(
  tx: TransactionSql,
  session: { propertyId: string; authUserId: string; role: string },
  reservationId: string,
  change: { kind: "deleted" | "refunded"; amountCents: number; method: string },
) {
  if (session.role === "owner") return;
  const [who] = await tx<Array<{ name: string | null; confirmation: string | null }>>`
    select (select e.name from employees e join property_memberships m on m.id=e.membership_id
            where m.auth_user_id=${session.authUserId}::uuid and m.property_id=${session.propertyId}::uuid limit 1) as name,
           (select confirmation_number from reservations where id=${reservationId}::uuid) as confirmation
  `;
  const verb = change.kind === "deleted" ? "deleted" : "refunded";
  await tx`insert into notifications (property_id,recipient_role,type,title,message,resource_type,resource_id)
    values (${session.propertyId}::uuid,'owner',${change.kind === "deleted" ? "PAYMENT_DELETED" : "PAYMENT_REFUNDED"},${change.kind === "deleted" ? "Payment deleted" : "Payment refunded"},
      ${`${who?.name ?? "A staff member"} ${verb} ${money(change.amountCents)} of a ${change.method} payment on reservation ${who?.confirmation ?? ""}.`},'reservation',${reservationId}::uuid)`;
}
