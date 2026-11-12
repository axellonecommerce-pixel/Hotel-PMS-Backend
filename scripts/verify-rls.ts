import postgres from "postgres";

/**
 * Checks that Supabase's data API cannot reach InnSeva's tables (see
 * drizzle-production/0024_close_data_api.sql). Read-only: it writes nothing.
 * Run with: bun run test:rls
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required. Add it to .env.local before running this check.");

const sql = postgres(databaseUrl, { prepare: false, max: 1, onnotice: () => undefined });
const problems: string[] = [];
const notes: string[] = [];
const rollback = new Error("ROLLBACK");

try {
  // 1. Row level security on every table in public.
  const withoutRls = await sql<Array<{ table: string }>>`
    select tablename as table from pg_tables where schemaname = 'public' and not rowsecurity order by tablename`;
  if (withoutRls.length) problems.push(`Row level security is off on: ${withoutRls.map((row) => row.table).join(", ")}`);

  // 2. No table rights for the data API's roles.
  const tableGrants = await sql<Array<{ grantee: string; table: string; privileges: string }>>`
    select grantee, table_name as table, string_agg(privilege_type, ', ' order by privilege_type) as privileges
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
    group by grantee, table_name order by table_name`;
  if (tableGrants.length) problems.push(`Data API roles still have table rights: ${tableGrants.slice(0, 10).map((row) => `${row.grantee} ${row.privileges} on ${row.table}`).join("; ")}${tableGrants.length > 10 ? ` (+${tableGrants.length - 10} more)` : ""}`);

  // 3. InnSeva's own functions cannot be called through the API.
  const callable = await sql<Array<{ fn: string; role: string }>>`
    select p.oid::regprocedure::text as fn, r.role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(role)
    where n.nspname = 'public' and p.proname in ('night_audit_due', 'current_property_ids')
      and has_function_privilege(r.role, p.oid, 'EXECUTE')`;
  if (callable.length) problems.push(`Callable through the data API: ${callable.map((row) => `${row.fn} by ${row.role}`).join("; ")}`);

  // 4. Future tables: default rights must not include the data API's roles.
  const defaults = await sql<Array<{ owner: string; kind: string; acl: string }>>`
    select pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype as kind, d.defaclacl::text as acl
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = 'public' and (d.defaclacl::text like '%anon=%' or d.defaclacl::text like '%authenticated=%')`;
  // Supabase does not let projects change supabase_admin's defaults; that
  // role only creates objects from the dashboard. Checks 1 and 2 still catch
  // any such table, and the closed Data API blocks it, so this is a note.
  const kinds = (rows: Array<{ owner: string; kind: string }>) => rows.map((row) => `${row.kind === "r" ? "tables" : row.kind === "S" ? "sequences" : "functions"} made by ${row.owner}`).join(", ");
  const ours = defaults.filter((row) => row.owner !== "supabase_admin");
  if (ours.length) problems.push(`New ${kinds(ours)} would still be given to the data API roles.`);
  if (defaults.length > ours.length) notes.push(`Supabase keeps its own default for objects created in the dashboard (${kinds(defaults.filter((row) => row.owner === "supabase_admin"))}); create tables with migrations, not the dashboard.`);

  // 5. The real thing: as each API role, reading a table must be refused.
  for (const role of ["anon", "authenticated"]) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select 1 from public.guests limit 1`;
        problems.push(`The "${role}" role can read guests.`);
        throw rollback;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (error !== rollback && code !== "42501") throw error;
    }
  }

  if (problems.length) {
    console.error(`Data API check FAILED:\n- ${problems.join("\n- ")}\nApply drizzle-production/0024_close_data_api.sql, then run this again.`);
    process.exitCode = 1;
  } else {
    console.log("Data API check passed: row level security is on for every table, and the anon and authenticated roles cannot read or change any InnSeva table.");
    for (const note of notes) console.log(`Note: ${note}`);
  }
} finally {
  await sql.end();
}
