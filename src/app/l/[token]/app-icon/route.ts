import { createHash } from "node:crypto";

import { productionSql } from "@/server/db/production";

function image(value: string | null) {
  const match = value?.match(/^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return { type: match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") };
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return new Response("Not found", { status: 404 });
  const hash = createHash("sha256").update(token).digest("hex");
  const [row] = await productionSql()<Array<{ logo: string | null }>>`
    select ps.value->'property'->>'logoDataUrl' as logo from loyalty_wallet_passes wp
    join loyalty_memberships lm on lm.id=wp.membership_id
    left join property_settings ps on ps.property_id=lm.property_id and ps.key='application_settings'
    where wp.token_hash=${hash} and wp.platform='web' and wp.status='active' and lm.status<>'closed'
  `;
  if (!row) return new Response("Not found", { status: 404 });
  const logo = image(row.logo);
  if (!logo) return Response.redirect(new URL("/brand/innseva-logo.png", _request.url), 307);
  return new Response(logo.bytes, { headers: { "Content-Type": `image/${logo.type}`, "Cache-Control": "private, max-age=300", "Content-Disposition": "inline" } });
}

