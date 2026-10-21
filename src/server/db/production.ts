import postgres, { type Sql } from "postgres";

let client: Sql | null = null;

export function hasProductionDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export function productionSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  client ??= postgres(connectionString, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
}
