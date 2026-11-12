import { verifiedAuthUserId } from "@/server/auth/property-session";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

/**
 * Wraps a route handler that takes money (payment, refund, charge, deposit,
 * transfer, checkout, paid-out, cash drop, invoice payment, …) so a request
 * repeated with the same Idempotency-Key header runs only once:
 * - the first request does the work; a successful answer is kept;
 * - a repeat gets the kept answer back (header Idempotent-Replayed: true);
 * - a repeat while the first is still running gets 409 "still being saved".
 * A failed request keeps nothing, so it can be tried again. Requests without
 * the header run as before. Keys are scoped to the signed-in user, the motel
 * and the path, so nobody can read another person's answer with their key.
 */
type Handler<A extends unknown[]> = (request: Request, ...args: A) => Promise<Response>;

export function withIdempotency<A extends unknown[]>(handler: Handler<A>): Handler<A> {
  return async (request, ...args) => {
    const key = request.headers.get("idempotency-key")?.trim();
    if (!key || !hasProductionDatabase()) return handler(request, ...args);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return Response.json({ error: "Invalid Idempotency-Key." }, { status: 400 });
    let userId: string;
    try {
      userId = await verifiedAuthUserId(request);
    } catch {
      // Not signed in: the handler gives its usual 401.
      return handler(request, ...args);
    }
    const scope = `${userId}:${request.headers.get("x-property-id") ?? ""}:${request.method}:${new URL(request.url).pathname}`;
    const sql = productionSql();
    let claimed: { key: string } | undefined;
    try {
      [claimed] = await sql<Array<{ key: string }>>`
        insert into idempotency_keys (scope, key) values (${scope}, ${key}) on conflict do nothing returning key`;
    } catch (error) {
      // Migration 0025 not applied on this database yet: run as before.
      if ((error as { code?: string }).code === "42P01") return handler(request, ...args);
      throw error;
    }
    if (!claimed) {
      const [earlier] = await sql<Array<{ status: number; body: string | null }>>`
        select status, body from idempotency_keys where scope = ${scope} and key = ${key}`;
      if (earlier?.status) {
        return new Response(earlier.body ?? "", { status: earlier.status, headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" } });
      }
      return Response.json({ error: "This is still being saved. Wait a moment, then refresh before trying again." }, { status: 409 });
    }
    const forget = () => sql`delete from idempotency_keys where scope = ${scope} and key = ${key} and status = 0`.catch(() => undefined);
    try {
      const response = await handler(request, ...args);
      if (response.ok) {
        const body = await response.clone().text();
        await sql`update idempotency_keys set status = ${response.status}, body = ${body}, completed_at = now() where scope = ${scope} and key = ${key}`;
      } else {
        await forget();
      }
      return response;
    } catch (error) {
      await forget();
      throw error;
    }
  };
}
