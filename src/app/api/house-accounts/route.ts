import { z } from "zod";

import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { productionSql } from "@/server/db/production";

// HotelKey "House Accounts": a folio not tied to a guest stay, for things like
// staff meals, lost keys, or walk-up laundry. Permanent accounts stay open;
// temporary ones are closed once settled.
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["permanent", "temporary"]).default("permanent"),
  notes: z.string().trim().max(500).optional(),
});
const updateSchema = z.object({ id: z.string().uuid(), action: z.enum(["close", "reopen"]) });

const houseAccountBalance = `(
  coalesce((select sum(c.amount_cents) from house_account_charges c where c.house_account_id=ha.id and c.status='posted'),0)
  - coalesce((select sum(p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id),0)) from payments p where p.house_account_id=ha.id),0)
)::int`;

export async function GET(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const accounts = await productionSql()<Array<{ id: string; name: string; kind: string; status: string; notes: string | null; balanceCents: number; createdAt: string; closedAt: string | null }>>`
      select ha.id, ha.name, ha.kind, ha.status, ha.notes, ${productionSql().unsafe(houseAccountBalance)} as "balanceCents",
        ha.created_at::text as "createdAt", ha.closed_at::text as "closedAt"
      from house_accounts ha where ha.property_id=${session.propertyId}::uuid
      order by ha.status, ha.name
    `;
    return Response.json({ accounts });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Enter a house account name." }, { status: 400 });
    const [account] = await productionSql()<Array<{ id: string }>>`
      insert into house_accounts (property_id, name, kind, notes)
      values (${session.propertyId}::uuid, ${parsed.data.name}, ${parsed.data.kind}, ${parsed.data.notes ?? null})
      returning id
    `;
    return Response.json({ account: { id: account.id, ...parsed.data, status: "open", balanceCents: 0 } }, { status: 201 });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requirePropertySession(request, "folios.manage");
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "House account action is invalid." }, { status: 400 });
    const sql = productionSql();
    const [account] = await sql<Array<{ id: string; balanceCents: number }>>`
      select ha.id, ${sql.unsafe(houseAccountBalance)} as "balanceCents" from house_accounts ha
      where ha.id=${parsed.data.id}::uuid and ha.property_id=${session.propertyId}::uuid
    `;
    if (!account) return Response.json({ error: "House account not found." }, { status: 404 });
    if (parsed.data.action === "close" && account.balanceCents !== 0) return Response.json({ error: "Settle the balance before closing the house account." }, { status: 409 });
    await sql`
      update house_accounts set status=${parsed.data.action === "close" ? "closed" : "open"},
        closed_at=${parsed.data.action === "close" ? sql`now()` : null}, updated_at=now()
      where id=${account.id}::uuid
    `;
    return Response.json({ id: account.id, status: parsed.data.action === "close" ? "closed" : "open" });
  } catch (error) {
    return propertyAccessResponse(error);
  }
}
