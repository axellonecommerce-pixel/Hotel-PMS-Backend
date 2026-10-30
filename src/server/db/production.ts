import postgres, { type Sql } from "postgres";

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
  client ??= postgres(connectionString, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
}
