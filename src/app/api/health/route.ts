import { hasProductionDatabase, productionSql } from "@/server/db/production";

/**
 * Deployment health probe. It intentionally exposes no tenant data, secrets,
 * or configuration—only whether this backend can reach its production data
 * store. Load balancers and release checks can call it without a session.
 */
export async function GET() {
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
