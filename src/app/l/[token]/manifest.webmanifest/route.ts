import { createHash } from "node:crypto";

import { productionSql } from "@/server/db/production";

export function loyaltyManifest(token: string, propertyName: string) {
  const rewardsName = `${propertyName.trim() || "InnSeva"} Rewards`;
  return {
    name: rewardsName,
    short_name: rewardsName,
    id: `/l/${token}`,
    start_url: `/l/${token}`,
    scope: `/l/${token}`,
    display: "standalone",
    background_color: "#eef6fd",
    theme_color: "#092b4c",
    icons: [{ src: `/l/${token}/app-icon`, sizes: "any", purpose: "any maskable" }],
  };
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return new Response("Not found", { status: 404 });
  const hash = createHash("sha256").update(token).digest("hex");
  const [card] = await productionSql()<Array<{ propertyName: string }>>`
    select coalesce(nullif(ps.value->'property'->>'name',''),p.name) as "propertyName"
    from loyalty_wallet_passes wp join loyalty_memberships lm on lm.id=wp.membership_id
    join properties p on p.id=lm.property_id left join property_settings ps on ps.property_id=p.id and ps.key='application_settings'
    where wp.token_hash=${hash} and wp.platform='web' and wp.status='active' and lm.status<>'closed'
  `;
  if (!card) return new Response("Not found", { status: 404 });
  return Response.json(loyaltyManifest(token, card.propertyName), { headers: { "Cache-Control": "private, max-age=300", "Content-Type": "application/manifest+json" } });
}
