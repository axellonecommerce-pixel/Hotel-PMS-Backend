import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";

// roomTypeId may be a Settings id ("room-type-…"); the name resolves the
// relational room type (smoking variants share one rate).
const rateSchema = z.object({ companyId: z.string().uuid(), roomTypeId: z.string().min(1), roomTypeName: z.string().trim().optional(), rateCents: z.number().int().nonnegative() });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = rateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Company room rate is invalid." }, { status: 400 });
    const input = parsed.data;
    const [rate] = await productionSql()<Array<{ id: string; companyId: string; roomTypeId: string; rateCents: number }>>`
      insert into company_room_rates (property_id,company_id,room_type_id,rate_cents)
      select ${session.propertyId}::uuid, c.id, rt.id, ${input.rateCents}
      from companies c cross join room_types rt
      where c.id=${input.companyId}::uuid and c.property_id=${session.propertyId}::uuid
        and rt.property_id=${session.propertyId}::uuid
        and (rt.id=${uuidPattern.test(input.roomTypeId) ? input.roomTypeId : null}::uuid or rt.name=${input.roomTypeName ?? null})
      order by (rt.id=${uuidPattern.test(input.roomTypeId) ? input.roomTypeId : null}::uuid) desc nulls last
      limit 1
      on conflict (company_id,room_type_id) do update set rate_cents=excluded.rate_cents
      returning id,company_id as "companyId",room_type_id as "roomTypeId",rate_cents as "rateCents"
    `;
    if (!rate) return Response.json({ error: "Company or room type not found." }, { status: 404 });
    return Response.json({ rate });
  } catch (error) { return propertyAccessResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const session = await requirePropertySession(request, "companies.manage");
    const parsed = z.object({ companyId: z.string().uuid(), roomTypeId: z.string().uuid() }).safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Company room rate is invalid." }, { status: 400 });
    const removed = await productionSql()`delete from company_room_rates where property_id=${session.propertyId}::uuid and company_id=${parsed.data.companyId}::uuid and room_type_id=${parsed.data.roomTypeId}::uuid returning id`;
    return Response.json({ deleted: removed.length > 0 });
  } catch (error) { return propertyAccessResponse(error); }
}
