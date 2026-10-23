import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { db } from "@/server/db/client";
import { companies } from "@/server/db/schema";
import { recordChange } from "@/server/realtime/change-events";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

const companySchema = z.object({
  name: z.string().trim().min(1),
  contactPerson: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  email: z.string().email(),
  billingAddress: z.string().trim().min(1),
  status: z.enum(["Active", "On Hold", "Inactive"]),
  paymentTermsDays: z.number().int().nonnegative(),
});

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    if (hasProductionDatabase()) {
      const records = await productionSql()<Array<Record<string, unknown>> >`
        select c.id, c.name, coalesce(cc.name,'') as "contactPerson", coalesce(cc.phone,'') as phone,
          coalesce(cc.email,'') as email, coalesce(c.billing_address->>'formatted','') as "billingAddress",
          initcap(replace(c.status,'_',' ')) as status, c.payment_terms_days as "paymentTermsDays",
          coalesce((select count(*) from invoices i where i.company_id=c.id and i.status not in ('paid','void')),0)::int as "openInvoices",
          coalesce((select sum(il.amount_cents) from invoices i join invoice_lines il on il.invoice_id=i.id where i.company_id=c.id)
            - (select coalesce(sum(ipa.amount_cents),0) from invoices i join invoice_payment_allocations ipa on ipa.invoice_id=i.id where i.company_id=c.id),0)::int as "currentBalanceCents"
        from companies c
        left join lateral (select * from company_contacts where company_id=c.id order by "primary" desc limit 1) cc on true
        where c.property_id=${session.propertyId}::uuid order by c.name
      `;
      const rates = await productionSql()<Array<{ companyId: string; roomTypeId: string; roomTypeName: string; rateCents: number }>>`
        select cr.company_id as "companyId",cr.room_type_id as "roomTypeId",rt.name as "roomTypeName",cr.rate_cents as "rateCents"
        from company_room_rates cr join room_types rt on rt.id=cr.room_type_id
        where cr.property_id=${session.propertyId}::uuid order by rt.sort_order,rt.name
      `;
      return Response.json({ companies: records.map((company) => ({ ...company, negotiatedRates: rates.filter((rate) => rate.companyId === company.id) })) });
    }
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
    if (hasProductionDatabase()) {
      const company = await productionSql().begin(async (tx) => {
        const [created] = await tx<Array<{ id: string }>>`
          insert into companies (property_id,name,billing_address,payment_terms_days,status)
          values (${session.propertyId}::uuid,${parsed.data.name},${tx.json({ formatted: parsed.data.billingAddress })},${parsed.data.paymentTermsDays},${parsed.data.status.toLowerCase().replace(/ /g,"_")})
          returning id
        `;
        await tx`insert into company_contacts (property_id,company_id,name,email,phone,"primary") values (${session.propertyId}::uuid,${created.id}::uuid,${parsed.data.contactPerson},${parsed.data.email},${parsed.data.phone},true)`;
        return { id: created.id, ...parsed.data, currentBalanceCents: 0, openInvoices: 0, negotiatedRates: [] };
      });
      await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: company.id, action: "created", entityVersion: 1, payload: {} });
      return Response.json({ company }, { status: 201 });
    }
    const now = new Date().toISOString();
    const record = { id: `company-${crypto.randomUUID()}`, propertyId: session.propertyId, ...parsed.data, createdAt: now, updatedAt: now };
    db.insert(companies).values(record).run();
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: record.id, action: "created", entityVersion: 1, payload: { company: { ...record, currentBalanceCents: 0, openInvoices: 0 } } });
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
    if (hasProductionDatabase()) {
      const result = await productionSql().begin(async (tx) => {
        const [existing] = await tx<Array<{ id: string }>>`select id from companies where id=${id}::uuid and property_id=${session.propertyId}::uuid for update`;
        if (!existing) return null;
        await tx`
          update companies set
            name=coalesce(${changes.name ?? null},name),
            billing_address=case when ${changes.billingAddress ?? null}::text is null then billing_address else ${tx.json({ formatted: changes.billingAddress ?? "" })}::jsonb end,
            payment_terms_days=coalesce(${changes.paymentTermsDays ?? null},payment_terms_days),
            status=coalesce(${changes.status?.toLowerCase().replace(/ /g,"_") ?? null},status),updated_at=now()
          where id=${id}::uuid
        `;
        if (changes.contactPerson || changes.email || changes.phone) await tx`
          update company_contacts set name=coalesce(${changes.contactPerson ?? null},name),email=coalesce(${changes.email ?? null},email),phone=coalesce(${changes.phone ?? null},phone)
          where company_id=${id}::uuid and "primary"=true
        `;
        return { id, ...changes };
      });
      if (!result) return Response.json({ error: "Company not found." }, { status: 404 });
      await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: id, action: "updated", entityVersion: Math.floor(Date.now() / 1000), payload: {} });
      return Response.json(result);
    }
    const result = db.update(companies).set({ ...changes, updatedAt: new Date().toISOString() }).where(and(eq(companies.id, id), eq(companies.propertyId, session.propertyId))).run();
    if (!result.changes) return Response.json({ error: "Company not found." }, { status: 404 });
    await recordChange({ propertyId: session.propertyId, actorAuthUserId: session.authUserId, entityType: "company", entityId: id, action: "updated", entityVersion: Date.now(), payload: { changes } });
    return Response.json({ id, ...changes });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
