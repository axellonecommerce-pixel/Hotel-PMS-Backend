import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/server/db/client";
import { attachments, notifications } from "@/server/db/schema";
import { deletePrivateFiles } from "@/server/storage/private-files";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const now = new Date();
  const warningCutoff = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const expiring = await db.query.attachments.findMany({ where: and(eq(attachments.resourceType, "guest-id"), isNull(attachments.warnedAt), isNull(attachments.deletedAt), lte(attachments.deleteAfter, warningCutoff)) });
  for (const file of expiring) {
    db.insert(notifications).values({ id: `notification-${crypto.randomUUID()}`, propertyId: file.propertyId, type: "ID_IMAGE_DELETION", title: "Guest ID image will be deleted", detail: `${file.originalName} is scheduled for automatic deletion within seven days.`, href: "/guests", status: "Unread", createdAt: now.toISOString() }).run();
    db.update(attachments).set({ warnedAt: now.toISOString() }).where(eq(attachments.id, file.id)).run();
  }
  const expired = await db.query.attachments.findMany({ where: and(eq(attachments.resourceType, "guest-id"), isNull(attachments.deletedAt), lte(attachments.deleteAfter, now.toISOString())) });
  await deletePrivateFiles(expired.map((file) => file.storageKey));
  for (const file of expired) db.update(attachments).set({ deletedAt: now.toISOString() }).where(eq(attachments.id, file.id)).run();
  return Response.json({ warned: expiring.length, deleted: expired.length });
}
