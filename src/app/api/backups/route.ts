import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { createTenantBackup, resetTenantOperationalData, restoreTenantBackup, restoreTenantFiles, validateTenantBackup } from "@/server/backups/tenant-backup";
import { deletePrivateFiles } from "@/server/storage/private-files";

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "backups.manage");
    const backup = await createTenantBackup(productionSql(), session.propertyId);
    await productionSql()`insert into backup_jobs (property_id,type,status,schema_version,manifest,completed_at) values (${session.propertyId}::uuid,'manual','completed',${backup.schemaVersion},${productionSql().json({ tables: Object.keys(backup.tables).length, files: backup.files.length })},now())`;
    return new Response(JSON.stringify(backup), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="hotel-backup-${backup.createdAt.slice(0,10)}.json"`, "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "backups.manage");
    const body = await request.json();
    const confirmation = z.object({ confirmation: z.string(), backup: z.unknown() }).safeParse(body);
    if (!confirmation.success || confirmation.data.confirmation !== `RESTORE ${session.propertyId}`) {
      return Response.json({ error: `Type RESTORE ${session.propertyId} to confirm.` }, { status: 400 });
    }
    const backup = confirmation.data.backup;
    validateTenantBackup(backup, session.propertyId);
    await productionSql().begin((tx) => restoreTenantBackup(tx, backup));
    await restoreTenantFiles(backup);
    await productionSql()`insert into backup_jobs (property_id,type,status,schema_version,manifest,completed_at) values (${session.propertyId}::uuid,'restore','completed',${backup.schemaVersion},${productionSql().json({ restoredAt: new Date().toISOString() })},now())`;
    return Response.json({ restored: true });
  } catch (error) {
    if (error instanceof Error && /backup|schema|hotel/i.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    return propertyAccessResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "backups.manage");
    const parsed = z.object({ confirmation: z.literal("RESET HOTEL DATA") }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Type RESET HOTEL DATA to confirm." }, { status: 400 });
    const sql = productionSql();
    const privateRows = await sql<Array<{ storageKey: string | null }>>`
      select storage_key as "storageKey" from guest_identities where property_id=${session.propertyId}::uuid and storage_key is not null
      union all select receipt_storage_key as "storageKey" from expenses where property_id=${session.propertyId}::uuid and receipt_storage_key is not null
      union all select storage_key as "storageKey" from attachments where property_id=${session.propertyId}::uuid and storage_key is not null
    `;
    await sql.begin((tx) => resetTenantOperationalData(tx, session.propertyId));
    await deletePrivateFiles(privateRows.flatMap((row) => row.storageKey ? [row.storageKey] : []));
    return Response.json({ reset: true });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
