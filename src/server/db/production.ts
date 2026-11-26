import { databaseNeedsTls } from "@/server/db/tls";
import postgres, { type Sql } from "postgres";

import { currentRequestActor } from "./request-context";

let client: Sql | null = null;

export function hasProductionDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export function productionSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  if (!client) {
    client = postgres(connectionString, {
      // Always encrypted to the database (Supabase can then refuse any
      // unencrypted connection); a database on this computer has no TLS.
      ssl: databaseNeedsTls(connectionString) ? "require" : false,
      // A single local Next.js process serves the whole PMS shell, whose
      // providers load several independent screens' data at once. Five
      // connections made those reads queue for ~30 seconds and the browser
      // rendered an empty property while it waited. Serverless production
      // stays conservative because each instance has its own pool.
      max: process.env.NODE_ENV === "production" ? 5 : 15,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    attributeTransactions(client);
  }
  return client;
}

/**
 * Every transaction opened during a signed-in API request first records who
 * is making it (transaction-local settings, so pooled connections never
 * carry it over). The audit log triggers (migration 0027) read them.
 */
function attributeTransactions(sql: Sql) {
  const begin = sql.begin.bind(sql) as (...args: unknown[]) => Promise<unknown>;
  (sql as unknown as { begin: (...args: unknown[]) => Promise<unknown> }).begin = (...args: unknown[]) => {
    const actor = currentRequestActor();
    const work = args[args.length - 1];
    if (!actor || (!actor.actorAuthUserId && !actor.actorLabel) || typeof work !== "function") return begin(...args);
    const attributed = async (tx: Sql) => {
      await tx`select set_config('innseva.actor', ${actor.actorAuthUserId ?? ""}, true), set_config('innseva.actor_label', ${actor.actorLabel ?? ""}, true)`;
      return (work as (tx: Sql) => unknown)(tx);
    };
    return begin(...args.slice(0, -1), attributed);
  };
}

