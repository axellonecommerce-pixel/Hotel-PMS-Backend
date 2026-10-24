import type { Sql, TransactionSql } from "postgres";

type Db = Sql | TransactionSql<Record<string, never>>;

export type ActivityCategory =
  | "Reservation" | "Stay" | "Status" | "Room" | "Rate" | "Guest"
  | "Charge" | "Payment" | "Folio" | "Deposit" | "Commission" | "Billing";

/** Who acted: a signed-in staff member, or the system (Night Audit). */
export type ActivityActor = { propertyId: string; authUserId?: string | null; systemName?: string };

const isUuid = (value: string | null | undefined): value is string => Boolean(value && /^[0-9a-f-]{36}$/i.test(value));

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Append a plain-language entry to a reservation's activity log (HotelKey
 * "Reservation Activity Log"). Runs inside the caller's transaction so the
 * entry exists exactly when the change does.
 */
export async function logReservationActivity(db: Db, actor: ActivityActor, reservationId: string, category: ActivityCategory, description: string) {
  const authUserId = isUuid(actor.authUserId) ? actor.authUserId : null;
  let actorName = actor.systemName ?? "System";
  if (authUserId) {
    const [person] = await db<Array<{ name: string }>>`
      select coalesce(
        (select e.name from employees e where e.membership_id=m.id and e.property_id=m.property_id order by e.created_at limit 1),
        initcap(replace(m.role, '_', ' '))
      ) as name
      from property_memberships m where m.auth_user_id=${authUserId}::uuid and m.property_id=${actor.propertyId}::uuid limit 1
    `;
    actorName = person?.name ?? "Staff";
  }
  await db`
    insert into reservation_activity (property_id, reservation_id, actor_auth_user_id, actor_name, category, description)
    values (${actor.propertyId}::uuid, ${reservationId}::uuid, ${authUserId}::uuid, ${actorName}, ${category}, ${description})
  `;
}

/** Friendly names for the stay details kept in the reservation notes. */
const noteFields: Record<string, string> = {
  adults: "Adults", children: "Children", petCount: "Pets", servicePetCount: "Service pets", rateCode: "Rate plan",
};

/** Describe the stay details that changed between two notes payloads. */
export function describeNoteChanges(before: string | null, after: string | null) {
  const parse = (value: string | null) => {
    try { const parsed = value ? JSON.parse(value) : {}; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
    catch { return {}; }
  };
  const old = parse(before);
  const next = parse(after);
  const changes: string[] = [];
  for (const [key, label] of Object.entries(noteFields)) {
    if (key in next && JSON.stringify(old[key]) !== JSON.stringify(next[key])) changes.push(`${label} ${old[key] ?? "—"} → ${next[key]}`);
  }
  const remarks = (value: Record<string, unknown>) => (Array.isArray(value.stayRemarkEntries) ? value.stayRemarkEntries : []) as Array<{ text?: string; category?: string }>;
  const added = remarks(next).slice(remarks(old).length);
  for (const remark of added) if (remark?.text) changes.push(`Remark added${remark.category ? ` (${remark.category})` : ""}: ${String(remark.text).slice(0, 200)}`);
  return changes;
}
