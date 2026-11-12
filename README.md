# Hotel PMS Backend

Next.js + Drizzle backend foundation for the multi-hotel PMS. SQLite powers local development; the production schema targets PostgreSQL.

## Included

- Normalized motel schema and migrations
- Seed data for rooms, guests, reservations, companies, booking channels, maintenance, expenses, cash drops, employees, and tasks
- Booking channel commission configuration
- Business-day and maintenance work-order tables
- Product-team hotel provisioning API
- Supabase-token authentication with membership-derived hotel isolation
- Reservation optimistic locking and a tenant-scoped realtime event stream

## Run Locally

```bash
bun install
bun run db:migrate
bun run db:seed
```

## Authentication and tenancy

Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only
`SUPABASE_SECRET_KEY`. The legacy `SUPABASE_SERVICE_ROLE_KEY` name remains
supported for existing deployments. Every operational API resolves the
signed-in user to an active `property_memberships` row. If the employee belongs
to more than one hotel, send `X-Property-Id`; the server rejects hotels outside
that user's memberships.

For local development only, set `PMS_DEMO_AUTH_ENABLED=true`, `PMS_DEMO_AUTH_TOKEN`, and `PMS_DEMO_AUTH_USER_ID`. Production never accepts the demo path.

## Product-team hotel provisioning

Set a strong `PMS_PROVISIONING_KEY`, then call `POST /api/admin/properties` with `X-PMS-Provisioning-Key`. The payload contains hotel contact/timezone details plus the existing Supabase owner's user ID and name. Provisioning transactionally creates the property, owner membership, owner employee, and starting settings.

Set `PMS_FRONTEND_ORIGINS` to the comma-separated frontend origins allowed to call the API. Reservation clients subscribe to `GET /api/events`; writes use a required expected version and return `409 EDIT_CONFLICT` instead of overwriting a newer edit.

## Platform Admin

The central motel and subscription console is available at the frontend route
`/platform`. It creates the motel, its owner email/password login, and its
subscription in one action. Add `PMS_PLATFORM_ADMIN_EMAILS` in Vercel as a
comma-separated list of the email addresses allowed to use this console.
These addresses must already be Supabase Auth users. The console intentionally
uses the server-only Supabase secret to create owner accounts; never place that
secret in frontend environment variables.

## Production database migrations

Before enabling the Platform Admin or accepting production traffic, apply the
production SQL migrations in numeric order (`0000` through the newest file in
`drizzle-production/`) in the Supabase SQL Editor or your managed PostgreSQL
migration runner. Then apply `supabase/rls.sql`. The RLS script must run after
the schema exists so every property-scoped table receives its tenant-isolation
policy.

Order on a new database: `0000`–`0012`, then `supabase/rls.sql` (later
migrations use its `current_property_ids()` function), then the rest in order,
then `supabase/rls.sql` once more.

**Supabase's data API is closed** (`0024_close_data_api.sql`). InnSeva's
browser app uses Supabase only for sign-in; all data goes through this API,
which checks each person's permissions. After applying `0024`, open Supabase ›
Project Settings › Data API and remove `public` from *Exposed schemas* (or turn
the Data API off). Never grant table rights to the `anon` or `authenticated`
roles again. `bun run test:rls` (read-only) fails if any table is reachable.

For an already-running property, apply only the migrations it has not already
recorded, in order. Never rerun destructive reset commands against production.
The current sequence includes platform subscriptions, deletion cascades,
property tasks, and `0013_secure_property_tasks.sql`; the latter enables the
required RLS policy for task records. Verify the resulting deployment with:

```bash
bun run test:rls
```

Apply `0019` → `0020` → `0021` → `0022` → `0023` in order, before deploying the API.
`0019_cash_sources_and_accounting.sql` adds cash sources (Cash Drop drawer,
safe, bank) and the Cash & Bank accounting page. It records past cash drops
into the safe and posts past paid wages to the ledger, once. After applying
it, open **Cash & Bank → Count the Safe** once per property so the safe
balance matches the real cash.

## Rules that keep every motel correct

- Times: never hard-code a time zone. The server uses `properties.timezone`;
  the frontend uses `propertyTimeZone()` (set from Settings › Property).
- Cash: an expense or wage paid in cash must name its source (`drawer` or
  `safe`). Drawer cash needs an open shift and appears as a linked paid out;
  the P&L counts the expense/wage, never the linked paid out.
- Bank: check, debit card, transfer, ACH, wire, Zelle and direct deposit
  payments come out of a bank account (`bank_accounts`); the screen
  preselects the default and the server falls back to it, so a bank payment
  is never unrecorded. Every motel gets "Main Bank Account" when it is
  provisioned (`ensureDefaultBankAccount`). Each account's ledger account is
  `Bank - <name>`. Apply `0020_bank_accounts.sql` after 0019.
- Payments: every guest, house-account and company payment posts to the
  ledger (`payment-ledger.ts`); never insert into `payments` without it.
- Card & check deposits (`0021_card_deposits.sql`): card and check payments
  wait in "Card & Check Receipts" until a deposit moves them into a bank
  account; the processor's fee is Card Processing Fees (P&L line 10). A
  deposited payment cannot be deleted, only refunded.
- Card terminals of any brand (`0023_card_terminals.sql`): Settings › Payment
  Terminals lists the motel's terminals (Chase, Clover, Square, Worldpay,
  Fiserv, …). A card payment must name its terminal once a motel has any;
  deposits are matched per terminal, by hand or by importing the
  processor's deposit report (CSV, column mapping remembered per terminal).
- Card terminal (`0022_payment_terminals.sql`, optional per motel): Settings ›
  Payment Terminal connects Stripe Terminal. The key is AES-256-GCM encrypted
  (set `PMS_ENCRYPTION_KEY`, 32 random bytes base64, on the API) and kept in a
  table no login can read. Without a terminal everything works by hand; with
  one, folio charges go to the reader, refunds go back to the card, and the
  daily job turns Stripe payouts into deposits with exact fees. New
  processors go beside `server/terminal/stripe.ts` with the same steps.
- Night Audit: the manual run sends `expectedBusinessDate` so it can never
  close a day the scheduled audit already closed. To-do notes never block it.
- Maintenance: `completed`, `resolved` and `cancelled` are all closed.
- New tables with `property_id` need the RLS policy (re-run `supabase/rls.sql`)
  and an entry in `tenant-backup.ts` and the `/api/sync` fingerprint.

The Platform Admin tables are created by
`drizzle-production/0009_platform_subscriptions.sql`. Card charging is
deliberately not implemented: subscription payments can be recorded manually
until a payment processor is selected.
