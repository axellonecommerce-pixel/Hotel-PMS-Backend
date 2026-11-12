import { provisionPlatformMotel } from "@/server/provisioning/platform-motel";
import { productionSql } from "@/server/db/production";

/**
 * Creates "InnSeva Test Motel" and its owner login in the TEST Supabase
 * project, the same way the Platform page creates a real motel. Refuses to
 * run against any other database.
 *
 *   bun --env-file=.env.local scripts/seed-test.ts
 *
 * Prints the owner's user id (for PMS_DEMO_AUTH_USER_ID); the owner's
 * password is written to .env.test-secrets.local, never printed.
 */
const TEST_PROJECT_REF = "vumtwyzdzqqnhmjtocad";
if (!process.env.DATABASE_URL?.includes(`postgres.${TEST_PROJECT_REF}:`) || !process.env.SUPABASE_URL?.includes(TEST_PROJECT_REF)) {
  throw new Error(`Refusing to seed: this is not the test project (${TEST_PROJECT_REF}).`);
}

const ownerEmail = "owner@innseva-test.dev";
const sql = productionSql();
const [existing] = await sql<Array<{ propertyId: string; authUserId: string }>>`
  select m.property_id as "propertyId", m.auth_user_id::text as "authUserId"
  from property_memberships m join employees e on e.membership_id = m.id
  where lower(e.email) = ${ownerEmail} and m.role = 'owner' limit 1`;
if (existing) {
  console.log(`Already seeded. property=${existing.propertyId} owner=${existing.authUserId}`);
} else {
  const ownerPassword = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
  const motel = await provisionPlatformMotel({
    name: "InnSeva Test Motel", addressLine1: "100 Test Way", city: "Sampletown", region: "CA", postalCode: "90000",
    countryCode: "US", phone: "5550100100", timezone: "America/Los_Angeles",
    ownerName: "Test Owner", ownerEmail, ownerPassword,
    planName: "Test", billingCycle: "monthly", amountCents: 0, startsOn: today, expiresOn: nextYear, status: "trial",
    notes: "Test project only. Safe to change or delete.",
  });
  const [owner] = await sql<Array<{ authUserId: string }>>`
    select auth_user_id::text as "authUserId" from property_memberships where property_id = ${motel.propertyId}::uuid and role = 'owner' limit 1`;
  const secrets = await Bun.file(".env.test-secrets.local").text().catch(() => "");
  await Bun.write(".env.test-secrets.local", `${secrets.trimEnd()}\nTEST_OWNER_EMAIL=${ownerEmail}\nTEST_OWNER_PASSWORD=${ownerPassword}\n`);
  console.log(`Seeded. property=${motel.propertyId} owner=${owner.authUserId}`);
}
await sql.end();
