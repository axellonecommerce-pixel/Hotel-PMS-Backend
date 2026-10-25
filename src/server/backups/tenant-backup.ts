import type { Sql, TransactionSql } from "postgres";

import { downloadPrivateBytes, uploadPrivateBytes } from "@/server/storage/private-files";

const tableOrder = [
  "property_settings","employees","property_tasks","room_types","rooms","rate_calendar","maintenance_schedules","guests","guest_remarks","guest_identities","guest_payment_sources","guest_vehicles",
  "companies","company_contacts","company_room_rates","booking_sources","promotions","promotion_room_types","tax_definitions","charge_types",
  "registration_rule_versions","reservations","reservation_rooms","reservation_guests","dnr_overrides","registration_acceptances","nightly_rates",
  "reservation_promotions","room_moves","reservation_activity","lost_found_items","document_sequences","folios","charges","charge_taxes",
  "house_accounts","house_account_charges","payments","payment_allocations","refunds","folio_transfers",
  "security_deposits","deposit_transactions","invoices","invoice_lines","invoice_payment_allocations","company_credits","business_days","cash_shifts",
  "cash_drops","cash_shift_transactions","paid_outs","housekeeping_records","maintenance_orders","time_entries","pay_periods","payroll_entries","vendors","expenses",
  "recurring_expenses","night_audit_runs","report_definitions","guest_import_jobs","backup_jobs","retention_tombstones","notifications","attachments",
  "change_events","ledger_entries",
] as const;

// These records define the property rather than its day-to-day activity. A
// reset must keep them so the motel does not need to be configured again.
const settingsTables = new Set<string>([
  "property_settings", "employees", "room_types", "rooms", "booking_sources",
  "promotions", "promotion_room_types", "tax_definitions", "charge_types",
  "registration_rule_versions", "document_sequences", "rate_calendar", "maintenance_schedules",
  "companies", "company_contacts", "company_room_rates",
]);

export type TenantBackup = {
  schemaVersion: "2026-10-16.1";
  propertyId: string;
  createdAt: string;
  property: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
  files: Array<{ storageKey: string; mimeType: string; base64: string }>;
};

export async function createTenantBackup(sql: Sql, propertyId: string): Promise<TenantBackup> {
  const [property] = await sql<Array<Record<string, unknown>>>`select * from properties where id=${propertyId}::uuid`;
  if (!property) throw new Error("Hotel not found.");
  const tables: TenantBackup["tables"] = {};
  for (const table of tableOrder) {
    const rows = await sql.unsafe<Array<Record<string, unknown>>>(`select * from "${table}" where property_id = $1`, [propertyId]);
    if (table === "guest_identities") {
      const now = Date.now();
      tables[table] = rows.map((row) => {
        const expired = Boolean(row.deleted_at) || new Date(String(row.delete_after)).getTime() <= now;
        return expired ? { ...row, storage_key: null } : row;
      });
    } else tables[table] = rows;
  }
  const keys = new Map<string, string>();
  for (const row of tables.guest_identities ?? []) if (row.storage_key && !row.deleted_at) keys.set(String(row.storage_key), "image/jpeg");
  for (const row of tables.expenses ?? []) if (row.receipt_storage_key) keys.set(String(row.receipt_storage_key), "application/octet-stream");
  for (const row of tables.attachments ?? []) if (row.storage_key) keys.set(String(row.storage_key), String(row.mime_type ?? "application/octet-stream"));
  const files: TenantBackup["files"] = [];
  for (const [storageKey, mimeType] of keys) {
    const bytes = await downloadPrivateBytes(storageKey);
    files.push({ storageKey, mimeType, base64: Buffer.from(bytes).toString("base64") });
  }
  return { schemaVersion: "2026-10-16.1", propertyId, createdAt: new Date().toISOString(), property, tables, files };
}

export function validateTenantBackup(value: unknown, propertyId: string): asserts value is TenantBackup {
  if (!value || typeof value !== "object") throw new Error("Backup file is invalid.");
  const backup = value as Partial<TenantBackup>;
  if (backup.schemaVersion !== "2026-10-16.1" || backup.propertyId !== propertyId || !backup.tables || !Array.isArray(backup.files)) {
    throw new Error("This backup does not match the selected hotel or schema version.");
  }
}

export async function restoreTenantBackup(tx: TransactionSql<Record<string, never>>, backup: TenantBackup) {
  const excluded = new Set(["property_memberships", "backup_jobs"]);
  for (const table of [...tableOrder].reverse()) {
    if (excluded.has(table)) continue;
    await tx.unsafe(`delete from "${table}" where property_id = $1`, [backup.propertyId]);
  }
  for (const table of tableOrder) {
    if (excluded.has(table)) continue;
    const rows = backup.tables[table] ?? [];
    if (!rows.length) continue;
    const validColumns = await tx<Array<{ columnName: string }>>`
      select column_name as "columnName" from information_schema.columns where table_schema='public' and table_name=${table}
    `;
    const allowed = new Set(validColumns.map((column) => column.columnName));
    const sanitized = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => allowed.has(key))));
    await tx`insert into ${tx(table)} ${tx(sanitized)}`;
  }
}

export async function resetTenantOperationalData(tx: TransactionSql<Record<string, never>>, propertyId: string) {
  for (const table of [...tableOrder].reverse()) {
    if (settingsTables.has(table)) continue;
    await tx.unsafe(`delete from "${table}" where property_id = $1`, [propertyId]);
  }

  // Rooms and their map positions are setup data, but their service and
  // cleanliness states are operational data. Resetting only the operational
  // tables previously left an OOO/dirty room embedded in both the rooms table
  // and the saved settings JSON, so the dashboard still showed stale counts.
  await tx`update rooms set service_status='rentable', cleanliness_status='clean', updated_at=now() where property_id=${propertyId}::uuid`;
  await tx`
    update property_settings
    set value=jsonb_set(
      value,
      '{rooms}',
      coalesce((
        select jsonb_agg(
          jsonb_set(
            jsonb_set(room, '{serviceStatus}', '"rentable"'::jsonb, true),
            '{housekeepingStatus}', '"clean"'::jsonb, true
          )
        )
        from jsonb_array_elements(coalesce(value->'rooms', '[]'::jsonb)) as room
      ), '[]'::jsonb),
      true
    ),
    updated_at=now()
    where property_id=${propertyId}::uuid and key='application_settings'
  `;
}

export async function restoreTenantFiles(backup: TenantBackup) {
  for (const file of backup.files) {
    await uploadPrivateBytes(file.storageKey, Uint8Array.from(Buffer.from(file.base64, "base64")), file.mimeType);
  }
}
