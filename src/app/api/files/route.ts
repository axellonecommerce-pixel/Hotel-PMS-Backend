import { and, eq, isNull } from "drizzle-orm";
import { hasPermission } from "@/server/auth/authorization";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { attachments } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { deletePrivateFiles, signedPrivateFileUrl, uploadPrivateFile } from "@/server/storage/private-files";
import { withRequestContext } from "@/server/db/request-context";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/** The file's first bytes must match its declared type (the browser's type is only a claim). */
async function contentMatchesType(file: File) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  if (file.type === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (file.type === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (file.type === "image/webp") return starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  if (file.type === "application/pdf") return starts(0x25, 0x50, 0x44, 0x46);
  return false;
}

async function routePOST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const resourceType = String(form.get("resourceType") ?? "");
    const resourceId = String(form.get("resourceId") ?? "");
    // Guest ID photos are never stored: the guest's ID type and number are kept instead.
    if (resourceType === "guest-id") return Response.json({ error: "Guest ID photos are not stored. Enter the ID type and number instead." }, { status: 400 });
    if (!(file instanceof File) || !resourceId || !["expense-receipt", "maintenance"].includes(resourceType)) return Response.json({ error: "File and resource details are required." }, { status: 400 });
    const session = await requirePropertySession(request, resourceType === "expense-receipt" ? "expenses.manage" : "maintenance.manage");
    if (!allowedTypes.has(file.type) || file.size > 4_000_000) return Response.json({ error: "Use a JPG, PNG, WebP, or PDF file up to 4 MB." }, { status: 400 });
    if (!await contentMatchesType(file)) return Response.json({ error: "The file's contents do not match its type. Use a real JPG, PNG, WebP, or PDF file." }, { status: 400 });
    const id = `attachment-${crypto.randomUUID()}`;
    const storageKey = `${session.propertyId}/${resourceType}/${crypto.randomUUID()}`;
    await uploadPrivateFile(storageKey, file);
    const createdAt = new Date();
    const deleteAfter = null;
    if (hasProductionDatabase()) {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId)) {
          throw new Error("The linked hotel record is invalid.");
        }
        const sql = productionSql();
        let productionAttachmentId = id;
        {
          const [resource] = resourceType === "expense-receipt"
            ? await sql<Array<{ id: string }>>`select id from expenses where id=${resourceId}::uuid and property_id=${session.propertyId}::uuid`
            : await sql<Array<{ id: string }>>`select id from maintenance_orders where id=${resourceId}::uuid and property_id=${session.propertyId}::uuid`;
          if (!resource) throw new Error("The linked hotel record was not found.");
          const [attachment] = await sql<Array<{ id: string }>>`
            insert into attachments (property_id,resource_type,resource_id,storage_key,mime_type,size_bytes)
            values (${session.propertyId}::uuid,${resourceType},${resourceId}::uuid,${storageKey},${file.type},${file.size})
            returning id
          `;
          productionAttachmentId = attachment.id;
          if (resourceType === "expense-receipt") await sql`
            update expenses set receipt_storage_key=${storageKey},updated_at=now()
            where id=${resourceId}::uuid and property_id=${session.propertyId}::uuid
          `;
        }
        return Response.json({ attachment: { id: productionAttachmentId, originalName: file.name, deleteAfter } }, { status: 201 });
      } catch (error) {
        await deletePrivateFiles([storageKey]).catch(() => undefined);
        throw error;
      }
    }
    db.insert(attachments).values({ id, propertyId: session.propertyId, resourceType, resourceId, storageKey, originalName: file.name, mimeType: file.type, sizeBytes: file.size, deleteAfter, createdAt: createdAt.toISOString() }).run();
    return Response.json({ attachment: { id, originalName: file.name, deleteAfter } }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}

async function routeGET(request: Request) {
  try {
    const session = await requirePropertySession(request, ["guests.manage", "expenses.manage", "maintenance.manage"]);
    const id = new URL(request.url).searchParams.get("id");
    if (!id || (hasProductionDatabase() && !/^[0-9a-f-]{36}$/i.test(id))) return Response.json({ error: "Attachment ID is required." }, { status: 400 });
    if (hasProductionDatabase()) {
      const [attachment] = await productionSql()<Array<{ storageKey: string; mimeType: string; resourceType: string }>>`
        select storage_key as "storageKey",mime_type as "mimeType",resource_type as "resourceType" from attachments
        where id=${id}::uuid and property_id=${session.propertyId}::uuid
      `;
      if (!attachment) return Response.json({ error: "Attachment not found." }, { status: 404 });
      // A guest's ID only for those who manage guests; a receipt for expenses; a photo for maintenance.
      const needed = attachment.resourceType.startsWith("guest-id") ? "guests.manage" : attachment.resourceType === "expense-receipt" ? "expenses.manage" : "maintenance.manage";
      if (!hasPermission(session.role, needed, session.access)) return Response.json({ error: "You do not have permission to open this file." }, { status: 403 });
      return Response.json({ url: await signedPrivateFileUrl(attachment.storageKey), mimeType: attachment.mimeType });
    }
    const attachment = await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.propertyId, session.propertyId), isNull(attachments.deletedAt)) });
    if (!attachment) return Response.json({ error: "Attachment not found." }, { status: 404 });
    return Response.json({ url: await signedPrivateFileUrl(attachment.storageKey), originalName: attachment.originalName });
  } catch (error) { return propertyAccessResponse(error); }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
export const POST = withRequestContext(routePOST);
