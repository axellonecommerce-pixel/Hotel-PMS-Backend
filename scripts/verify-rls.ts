import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required. Add it to .env.local before running this check.");

const sql = postgres(databaseUrl, { prepare: false, max: 1 });
const rollbackMarker = new Error("RLS_TEST_ROLLBACK");

try {
  const [{ protectedTables, unprotectedTables }] = await sql<[{ protectedTables: number; unprotectedTables: number }]>`
    select
      count(*) filter (where rowsecurity)::int as "protectedTables",
      count(*) filter (where not rowsecurity)::int as "unprotectedTables"
    from pg_tables
    where schemaname = 'public'
  `;

  if (protectedTables === 0 || unprotectedTables !== 0) {
    throw new Error(`RLS coverage failed: ${protectedTables} protected, ${unprotectedTables} unprotected public tables.`);
  }

  try {
    await sql.begin(async (tx) => {
      const userA = crypto.randomUUID();
      const [propertyA] = await tx<[{ id: string }]>`
        insert into properties (name, address_line_1, city, region, postal_code, phone, timezone)
        values ('RLS Test Hotel A', '1 Test Way', 'Fresno', 'CA', '93721', '555-0101', 'America/Los_Angeles')
        returning id
      `;
      const [propertyB] = await tx<[{ id: string }]>`
        insert into properties (name, address_line_1, city, region, postal_code, phone, timezone)
        values ('RLS Test Hotel B', '2 Test Way', 'Fresno', 'CA', '93721', '555-0102', 'America/Los_Angeles')
        returning id
      `;

      await tx`
        insert into property_memberships (property_id, auth_user_id, role)
        values (${propertyA.id}, ${userA}, 'manager')
      `;
      await tx`
        insert into companies (property_id, name, billing_address)
        values
          (${propertyA.id}, 'Visible Company', ${tx.json({ formatted: "1 Test Way" })}),
          (${propertyB.id}, 'Hidden Company', ${tx.json({ formatted: "2 Test Way" })})
      `;
      await tx`
        insert into property_tasks (property_id, text, area)
        values
          (${propertyA.id}, 'Visible task', 'front_desk'),
          (${propertyB.id}, 'Hidden task', 'front_desk')
      `;

      await tx`select set_config('request.jwt.claim.sub', ${userA}, true)`;
      await tx.unsafe("set local role authenticated");

      const visibleCompanies = await tx<{ propertyId: string; name: string }[]>`
        select property_id as "propertyId", name from companies order by name
      `;
      const visibleProperties = await tx<{ id: string }[]>`select id from properties order by id`;
      const visibleTasks = await tx<{ propertyId: string; text: string }[]>`
        select property_id as "propertyId", text from property_tasks order by text
      `;

      if (visibleCompanies.length !== 1 || visibleCompanies[0]?.propertyId !== propertyA.id || visibleCompanies[0]?.name !== "Visible Company") {
        throw new Error(`Company isolation failed: authenticated employee saw ${visibleCompanies.length} companies.`);
      }
      if (visibleProperties.length !== 1 || visibleProperties[0]?.id !== propertyA.id) {
        throw new Error(`Property isolation failed: authenticated employee saw ${visibleProperties.length} properties.`);
      }
      if (visibleTasks.length !== 1 || visibleTasks[0]?.propertyId !== propertyA.id || visibleTasks[0]?.text !== "Visible task") {
        throw new Error(`Property task isolation failed: authenticated employee saw ${visibleTasks.length} tasks.`);
      }

      throw rollbackMarker;
    });
  } catch (error) {
    if (error !== rollbackMarker) throw error;
  }

  console.log(`RLS verified: ${protectedTables} public tables protected; cross-hotel company, property, and task records are isolated.`);
} finally {
  await sql.end();
}
