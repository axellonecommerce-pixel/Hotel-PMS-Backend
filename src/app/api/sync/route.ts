import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

export const dynamic = "force-dynamic";

/**
 * A short fingerprint of the property's operational data. Every screen polls
 * it; when it changes (any user or device saved something), screens reload.
 * Each part is the latest change time and row count of a table, so inserts,
 * edits and deletes all move it.
 */
export async function GET(request: Request) {
  try {
    // Every role can view reports, so every signed-in device can sync.
    const session = await requirePropertySession(request, "reports.view");
    if (!hasProductionDatabase()) return Response.json({ version: "local" });
    const id = session.propertyId;
    const [row] = await productionSql()<Array<{ version: string }>>`
      select md5(concat_ws('|',
        (select concat(max(updated_at), ':', count(*)) from reservations where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from reservation_rooms where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from reservation_activity where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from guests where property_id=${id}::uuid),
        (select count(*) from guest_identities where property_id=${id}::uuid and deleted_at is null),
        (select concat(max(updated_at), ':', count(*)) from guest_vehicles where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from guest_payment_sources where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from rooms where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from payments where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*), ':', sum(amount_cents)) from payment_allocations where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from refunds where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from charges where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from folios where property_id=${id}::uuid),
        (select max(updated_at)::text from property_settings where property_id=${id}::uuid),
        (select count(*) from housekeeping_records where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from maintenance_orders where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from property_tasks where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from companies where property_id=${id}::uuid),
        (select string_agg(concat(business_date, status), ',' order by business_date) from business_days where property_id=${id}::uuid),
        (select string_agg(concat(id, status), ',' order by id) from cash_shifts where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from cash_drops where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from lost_found_items where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from expenses where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from house_accounts where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from house_account_charges where property_id=${id}::uuid),
        (select concat(max(created_at), ':', count(*)) from paid_outs where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from invoices where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from security_deposits where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from rate_calendar where property_id=${id}::uuid),
        (select concat(max(updated_at), ':', count(*)) from employees where property_id=${id}::uuid)
      )) as version
    `;
    return Response.json({ version: row.version }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
