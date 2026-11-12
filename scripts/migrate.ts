import postgres from "postgres";
import { readdir } from "node:fs/promises";

/**
 * Applies the production SQL migrations (drizzle-production/*.sql) that a
 * database does not have yet, in order, and records each one in
 * public.schema_migrations so every database (test, live) knows its state.
 *
 *   bun --env-file=.env.local scripts/migrate.ts            # the database in .env.local
 *   ... scripts/migrate.ts --status                          # list, change nothing
 *   ... scripts/migrate.ts --baseline 0024                   # mark 0000–0024 as already applied
 *   ... scripts/migrate.ts --test-project                    # also stop the live night-audit
 *                                                            #   schedule (0018) on a test copy
 *
 * supabase/rls.sql runs before 0013 (later files use its function) and again
 * after every run; it is safe to repeat. Each file runs in one transaction.
 */
const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const testProject = args.includes("--test-project");
const baselineIndex = args.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required (use --env-file=.env.local).");
const host = new URL(databaseUrl.replace(/^postgres(ql)?:/, "http:")).username.split(".")[1] ?? "database";
// Show the migrations' own notes (for example "Skipped … existing row(s) do not pass it"); hide routine ones.
const sql = postgres(databaseUrl, { prepare: false, max: 1, onnotice: (notice) => { if (/^(Skipped|Default privileges)/.test(notice.message ?? "")) console.log(`[${host}] Note: ${notice.message}`); } });

const statements = (text: string) => text.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) => part.replace(/--[^\n]*/g, "").trim());
async function runFile(path: string) {
  const parts = statements(await Bun.file(path).text());
  await sql.begin(async (tx) => { for (const part of parts) await tx.unsafe(part); });
}

try {
  await sql`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql`alter table public.schema_migrations enable row level security`;
  await sql`revoke all on public.schema_migrations from anon, authenticated`.catch(() => undefined);
  const files = (await readdir("drizzle-production")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const applied = new Set((await sql<Array<{ name: string }>>`select name from public.schema_migrations`).map((row) => row.name));

  if (baseline) {
    const marked = files.filter((name) => name.slice(0, 4) <= baseline && !applied.has(name));
    for (const name of marked) await sql`insert into public.schema_migrations (name) values (${name}) on conflict do nothing`;
    console.log(`[${host}] Marked ${marked.length} migration(s) up to ${baseline} as already applied.`);
  } else {
    const pending = files.filter((name) => !applied.has(name));
    console.log(`[${host}] ${files.length - pending.length} applied, ${pending.length} pending${pending.length ? `: ${pending.join(", ")}` : ""}.`);
    if (!statusOnly) {
      for (const name of pending) {
        if (name >= "0013" && !(await sql`select 1 from pg_proc where proname = 'current_property_ids'`).length) {
          await runFile("supabase/rls.sql");
          console.log(`[${host}] Applied supabase/rls.sql (needed before ${name}).`);
        }
        await runFile(`drizzle-production/${name}`);
        await sql`insert into public.schema_migrations (name) values (${name})`;
        console.log(`[${host}] Applied ${name}.`);
      }
      await runFile("supabase/rls.sql");
      if (pending.length) console.log(`[${host}] Re-applied supabase/rls.sql.`);
      if (testProject) {
        // 0018 schedules a call to the LIVE API every minute; a test copy must not.
        await sql`select cron.unschedule('night-audit-tick') where exists (select 1 from cron.job where jobname = 'night-audit-tick')`.catch(() => undefined);
        console.log(`[${host}] Test project: night-audit schedule to the live API removed.`);
      }
    }
  }
} finally {
  await sql.end();
}
