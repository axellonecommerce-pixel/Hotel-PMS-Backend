import { createHash } from "node:crypto";
import { z } from "zod";

import { productionSql } from "@/server/db/production";
import { publicVapidKey } from "@/server/loyalty/web-push";

const tokenPattern = /^[A-Za-z0-9_-]{32,100}$/;
const endpointSchema = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "Push endpoint must use HTTPS.");
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscribe"), subscription: z.object({ endpoint: endpointSchema, keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }) }) }),
  z.object({ action: z.literal("unsubscribe"), endpoint: endpointSchema }),
]);

async function membershipForToken(token: string) {
  if (!tokenPattern.test(token)) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const [member] = await productionSql()<Array<{ membershipId: string; propertyId: string }>>`
    select lm.id as "membershipId",lm.property_id as "propertyId"
    from loyalty_wallet_passes wp join loyalty_memberships lm on lm.id=wp.membership_id
    where wp.token_hash=${hash} and wp.platform='web' and wp.status='active' and lm.status='active'
  `;
  return member ?? null;
}

const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!(await membershipForToken(token))) return response({ error: "Card not found." }, 404);
  const key = publicVapidKey();
  return response({ ready: Boolean(key), publicKey: key });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const member = await membershipForToken(token);
  if (!member) return response({ error: "Card not found." }, 404);
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response({ error: "Push subscription is invalid." }, 400);
  const endpoint = parsed.data.action === "subscribe" ? parsed.data.subscription.endpoint : parsed.data.endpoint;
  const endpointHash = createHash("sha256").update(endpoint).digest("hex");
  if (parsed.data.action === "unsubscribe") {
    await productionSql()`update loyalty_push_subscriptions set status='revoked',updated_at=now() where membership_id=${member.membershipId}::uuid and endpoint_hash=${endpointHash}`;
    return response({ subscribed: false });
  }
  if (!publicVapidKey()) return response({ error: "Deal alerts are not configured yet." }, 409);
  await productionSql()`
    insert into loyalty_push_subscriptions (property_id,membership_id,endpoint,endpoint_hash,p256dh,auth,card_path,status)
    values (${member.propertyId}::uuid,${member.membershipId}::uuid,${endpoint},${endpointHash},${parsed.data.subscription.keys.p256dh},${parsed.data.subscription.keys.auth},${`/l/${token}`},'active')
    on conflict (membership_id,endpoint_hash) do update set endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,card_path=excluded.card_path,status='active',failure_count=0,updated_at=now()
  `;
  return response({ subscribed: true });
}
