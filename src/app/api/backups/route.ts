import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";
import { createTenantBackup, restoreTenantBackup, restoreTenantFiles, validateTenantBackup } from "@/server/backups/tenant-backup";
import { isUserMessage } from "@/server/http/errors";
import { withRequestContext } from "@/server/db/request-context";

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, "backups.manage");
    const backup = await createTenantBackup(productionSql(), session.propertyId);
    await productionSql()`insert into backup_jobs (property_id,type,status,schema_version,manifest,completed_at) values (${session.propertyId}::uuid,'manual','completed',${backup.schemaVersion},${productionSql().json({ tables: Object.keys(backup.tables).length, files: backup.files.length })},now())`;
    return new Response(JSON.stringify(backup), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="hotel-backup-${backup.createdAt.slice(0,10)}.json"`, "Cache-Control": "no-store" } });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routePOST(request: Request) {
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
    if (isUserMessage(error, /backup|schema|hotel/i)) return Response.json({ error: error.message }, { status: 400 });
    return propertyAccessResponse(error);
  }
}

/**
 * "Reset hotel data" (delete every reservation, guest and payment) was
 * removed: InnSeva keeps every motel's data for life, and one stolen or
 * unhappy login could otherwise erase a motel. Old screens get a clear answer.
 */
async function routeDELETE(request: Request) {
  try {
    await requirePropertySession(request, "backups.manage");
    return Response.json({ error: "Resetting hotel data is no longer available. InnSeva keeps all data for life." }, { status: 410 });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
export const DELETE = withRequestContext(routeDELETE);
