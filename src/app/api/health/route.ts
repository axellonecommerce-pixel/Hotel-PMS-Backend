import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { withRequestContext } from "@/server/db/request-context";

/**
 * Deployment health probe. It intentionally exposes no tenant data, secrets,
 * or configuration—only whether this backend can reach its production data
 * store. Load balancers and release checks can call it without a session.
 */
async function routeGET() {
  if (!hasProductionDatabase()) {
    return Response.json({ status: "unavailable", database: "not configured" }, { status: 503 });
  }
  try {
    await productionSql()`select 1`;
    return Response.json({ status: "ok", database: "connected" });
  } catch {
    return Response.json({ status: "unavailable", database: "unreachable" }, { status: 503 });
  }
}

/** Each request gets its own context (who is acting, for the audit log). */
export const GET = withRequestContext(routeGET);
