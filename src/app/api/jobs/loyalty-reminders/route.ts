import { timingSafeEqual } from "node:crypto";

import { productionSql } from "@/server/db/production";
import { withRequestContext, setRequestActor } from "@/server/db/request-context";
import { processLoyaltyReminders } from "@/server/loyalty/reminders";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET; const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  return Boolean(expected && supplied && expected.length === supplied.length && timingSafeEqual(Buffer.from(expected!), Buffer.from(supplied!)));
}

async function run(request: Request) {
  setRequestActor({ label: "Loyalty reminder job" });
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  return Response.json(await processLoyaltyReminders(productionSql()));
}

export const GET = withRequestContext(run);
export const POST = GET;
