import { and, eq, isNull } from "drizzle-orm";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { attachments } from "@/server/db/schema";
import { signedPrivateFileUrl, uploadPrivateFile } from "@/server/storage/private-files";

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
    const storageKey = `${session.propertyId}/${resourceType}/${id}`;
    await uploadPrivateFile(storageKey, file);
    const createdAt = new Date();
    const deleteAfter = resourceType === "guest-id" ? new Date(createdAt.getTime() + 365 * 86_400_000).toISOString() : null;
    db.insert(attachments).values({ id, propertyId: session.propertyId, resourceType, resourceId, storageKey, originalName: file.name, mimeType: file.type, sizeBytes: file.size, deleteAfter, createdAt: createdAt.toISOString() }).run();
    return Response.json({ attachment: { id, originalName: file.name, deleteAfter } }, { status: 201 });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "reports.view");
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Attachment ID is required." }, { status: 400 });
    const attachment = await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.propertyId, session.propertyId), isNull(attachments.deletedAt)) });
    if (!attachment) return Response.json({ error: "Attachment not found." }, { status: 404 });
    return Response.json({ url: await signedPrivateFileUrl(attachment.storageKey), originalName: attachment.originalName });
  } catch (error) { return propertyAccessResponse(error); }
}
