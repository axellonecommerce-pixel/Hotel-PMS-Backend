import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { createTenantBackup, restoreTenantBackup, restoreTenantFiles, validateTenantBackup } from "@/server/backups/tenant-backup";

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
