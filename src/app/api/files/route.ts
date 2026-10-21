import { and, eq, isNull } from "drizzle-orm";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { attachments } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { deletePrivateFiles, signedPrivateFileUrl, uploadPrivateFile } from "@/server/storage/private-files";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const resourceType = String(form.get("resourceType") ?? "");
    const resourceId = String(form.get("resourceId") ?? "");
    if (!(file instanceof File) || !resourceId || !["guest-id", "expense-receipt", "maintenance"].includes(resourceType)) return Response.json({ error: "File and resource details are required." }, { status: 400 });
    const session = await requirePropertySession(request, resourceType === "guest-id" ? "guests.manage" : resourceType === "expense-receipt" ? "expenses.manage" : "maintenance.manage");
    if (!allowedTypes.has(file.type) || file.size > 4_000_000) return Response.json({ error: "Use a JPG, PNG, WebP, or PDF file up to 4 MB." }, { status: 400 });
    const id = `attachment-${crypto.randomUUID()}`;
    const storageKey = `${session.propertyId}/${resourceType}/${crypto.randomUUID()}`;
    await uploadPrivateFile(storageKey, file);
    const createdAt = new Date();
    const deleteAfter = resourceType === "guest-id" ? new Date(createdAt.getTime() + 365 * 86_400_000).toISOString() : null;
    if (hasProductionDatabase()) {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId)) {
          throw new Error("The linked hotel record is invalid.");
        }
        const sql = productionSql();
        let productionAttachmentId = id;
        if (resourceType === "guest-id") {
          const [identity] = await sql<Array<{ id: string; previousStorageKey: string | null }>>`
            select gi.id, gi.storage_key as "previousStorageKey"
            from guest_identities gi
            join guests g on g.id=gi.guest_id and g.property_id=gi.property_id
            where gi.guest_id=${resourceId}::uuid and gi.property_id=${session.propertyId}::uuid
            order by gi.captured_at desc limit 1
          `;
          if (!identity) throw new Error("Save the guest ID type and ID number before uploading its photo.");
          productionAttachmentId = identity.id;
          await sql`
            update guest_identities
            set storage_key=${storageKey}, captured_at=${createdAt.toISOString()}, delete_after=${deleteAfter}, warned_at=null, deleted_at=null
            where id=${identity.id}::uuid and property_id=${session.propertyId}::uuid
          `;
          if (identity.previousStorageKey && identity.previousStorageKey !== storageKey) await deletePrivateFiles([identity.previousStorageKey]);
        } else {
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

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Attachment ID is required." }, { status: 400 });
    if (hasProductionDatabase()) {
      const [attachment] = await productionSql()<Array<{ storageKey: string; mimeType: string }>>`
        select storage_key as "storageKey",mime_type as "mimeType" from attachments
        where id=${id}::uuid and property_id=${session.propertyId}::uuid
      `;
      if (!attachment) return Response.json({ error: "Attachment not found." }, { status: 404 });
      return Response.json({ url: await signedPrivateFileUrl(attachment.storageKey), mimeType: attachment.mimeType });
    }
    const attachment = await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.propertyId, session.propertyId), isNull(attachments.deletedAt)) });
    if (!attachment) return Response.json({ error: "Attachment not found." }, { status: 404 });
    return Response.json({ url: await signedPrivateFileUrl(attachment.storageKey), originalName: attachment.originalName });
  } catch (error) { return propertyAccessResponse(error); }
}
