import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { companies } from "@/server/db/schema";
import { recordChange } from "@/server/realtime/change-events";

const companySchema = z.object({
  name: z.string().trim().min(1),
  contactPerson: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  email: z.string().email(),
  billingAddress: z.string().trim().min(1),
  status: z.enum(["Active", "Inactive"]),
  paymentTermsDays: z.number().int().nonnegative(),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const records = await db.query.companies.findMany({ where: eq(companies.propertyId, session.propertyId) });
    return Response.json({ companies: records.map((company) => ({ ...company, currentBalanceCents: 0, openInvoices: 0 })) });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = companySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Complete all required company details." }, { status: 400 });
    const now = new Date().toISOString();
    const record = { id: `company-${crypto.randomUUID()}`, propertyId: session.propertyId, ...parsed.data, createdAt: now, updatedAt: now };
    db.insert(companies).values(record).run();
    recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: record.id, action: "created", entityVersion: 1, payload: { company: { ...record, currentBalanceCents: 0, openInvoices: 0 } } });
    return Response.json({ company: { ...record, currentBalanceCents: 0, openInvoices: 0 } }, { status: 201 });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

const updateSchema = companySchema.partial().extend({ id: z.string().min(1) });

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Company changes are invalid." }, { status: 400 });
    const { id, ...changes } = parsed.data;
    const result = db.update(companies).set({ ...changes, updatedAt: new Date().toISOString() }).where(and(eq(companies.id, id), eq(companies.propertyId, session.propertyId))).run();
    if (!result.changes) return Response.json({ error: "Company not found." }, { status: 404 });
    recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: id, action: "updated", entityVersion: Date.now(), payload: { changes } });
    return Response.json({ id, ...changes });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
