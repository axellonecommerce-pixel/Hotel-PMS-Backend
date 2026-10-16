import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/production-schema.ts",
  out: "./drizzle-production",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/hotel_pms",
  },
});
