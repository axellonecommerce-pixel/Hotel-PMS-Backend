import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "@/server/db/schema";

// Production uses PostgreSQL. Keep the SQLite demo adapter in memory there so
// importing an API route never creates or locks a local file during parallel
// Next.js builds or inside a serverless function.
const databasePath = process.env.DATABASE_URL ? ":memory:" : process.env.DEMO_DATABASE_PATH ?? "data/sun-star-demo-v3.sqlite";
const sqlite = new Database(databasePath);

sqlite.exec("PRAGMA foreign_keys = ON");
if (databasePath !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");

export const db = drizzle({ client: sqlite, schema });
export { sqlite };
