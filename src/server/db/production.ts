import { databaseNeedsTls } from "@/server/db/tls";
import postgres, { type Sql } from "postgres";

import { currentRequestActor } from "./request-context";

let client: Sql | null = null;

export function hasProductionDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

let lastUsed = 0;
/** After this long unused, pooled connections are not trusted. */
const STALE_AFTER_MS = 60_000;

export function productionSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  // A server paused while idle (serverless between requests, or a computer
  // that slept) keeps sockets the database has already closed; the next query
  // then waits until the dead connection times out. Start fresh instead and
  // let the old client finish anything still running.
  const now = Date.now();
  if (client && now - lastUsed > STALE_AFTER_MS) {
    const old = client;
    client = null;
    void old.end({ timeout: 60 }).catch(() => undefined);
  }
  lastUsed = now;
  if (!client) {
    client = postgres(connectionString, {
      // Always encrypted to the database (Supabase can then refuse any
      // unencrypted connection); a database on this computer has no TLS.
      ssl: databaseNeedsTls(connectionString) ? "require" : false,
      max: 5,
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

